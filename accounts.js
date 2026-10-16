import { Router } from 'express';
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const hash = value => createHash('sha256').update(value).digest('hex');
const key = 'flix:accounts:v1';
const lifetime = 30 * 86400;
const emailPattern = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const publicUser = user => ({ id: user.id, email: user.email, name: user.name, language: user.language, role: 'user', disabled: user.disabled, createdAt: user.createdAt });
const failure = (status, message) => Object.assign(new Error(message), { status });

// Compare-and-swap keeps invitation consumption and account creation atomic across API replicas.
export function accountStore(redis) {
  const read = async () => {
    const raw = await redis.get(key);
    return { raw, state: raw ? JSON.parse(raw) : { users: [], invitations: [] } };
  };
  async function change(update, { requireAdmin = false } = {}) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const { raw, state } = await read();
      const result = update(state);
      const saved = await redis.eval(`
        if ARGV[3] == '1' then
          local rawAuth = redis.call('JSON.GET', KEYS[2])
          if not rawAuth then return -1 end
          local auth = cjson.decode(rawAuth)
          if not auth.username or not (auth.passwordHash or auth.password) then return -1 end
        end
        local current = redis.call('GET', KEYS[1])
        if (current or '') ~= ARGV[1] then return 0 end
        redis.call('SET', KEYS[1], ARGV[2])
        return 1
      `, { keys: [key, 'auth'], arguments: [raw ?? '', JSON.stringify(state), requireAdmin ? '1' : '0'] });
      if (saved === -1) throw failure(403, 'Enable administrator authentication before inviting users.');
      if (saved === 1) return result;
    }
    throw failure(409, 'Accounts changed. Please try again.');
  }
  return { read, change };
}

export function createAccounts(redis, { env = process.env, fetcher = fetch, now = Date.now } = {}) {
  const store = accountStore(redis);
  const router = Router();
  const encryptionKey = () => createHash('sha256').update(env.MAILJET_SECRET_KEY ?? '').digest();
  function seal(value) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), encrypted].map(part => part.toString('base64url')).join('.');
  }
  function open(value) {
    const [iv, tag, encrypted] = value.split('.').map(part => Buffer.from(part, 'base64url'));
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  }
  function mailConfiguration() {
    if (!env.MAILJET_API_KEY || !env.MAILJET_SECRET_KEY || !emailPattern.test(env.MAIL_FROM_EMAIL ?? '')) return null;
    try {
      const url = new URL(env.FLIX_PUBLIC_URL);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
      return { url: url.href.replace(/\/$/, ''), from: env.MAIL_FROM_EMAIL, name: env.MAIL_FROM_NAME || 'Flix' };
    } catch { return null; }
  }
  async function issue(res, user) {
    const token = randomBytes(32).toString('hex');
    await redis.set(`flix:user-session:${hash(token)}`, JSON.stringify({ id: user.id, version: user.version }), { EX: lifetime });
    return res.json({ enabled: true, authenticated: true, role: 'user', user: publicUser(user), token, expiresIn: lifetime });
  }
  async function principal(req) {
    const header = req.get('Authorization') ?? '';
    if (!/^Bearer [a-f0-9]{64}$/.test(header)) return null;
    const saved = await redis.get(`flix:user-session:${hash(header.slice(7))}`);
    if (!saved) return null;
    const session = JSON.parse(saved);
    const { state } = await store.read();
    const user = state.users.find(user => user.id === session.id && user.version === session.version && !user.disabled);
    return user ? publicUser(user) : null;
  }
  async function login(req, res) {
    const { username, password } = req.body ?? {};
    if (typeof username !== 'string' || !username.includes('@')) return false;
    if (typeof password !== 'string' || !password.length || password.length > 1024) throw failure(400, 'Username and password are required.');
    const limitKey = `flix:user-login:${hash(req.ip ?? '')}`;
    if (await redis.incr(limitKey) === 1) await redis.expire(limitKey, 900);
    if (Number(await redis.get(limitKey)) > 10) throw failure(429, 'Too many sign-in attempts. Try again in 15 minutes.');
    const { state } = await store.read();
    const user = state.users.find(user => user.email === username.trim().toLowerCase());
    const actual = await derive(password, user?.salt ?? 'flix-unknown-user', 64);
    if (!user || user.disabled || !timingSafeEqual(actual, Buffer.from(user.passwordHash, 'hex'))) return false;
    // Recheck revocation after password derivation; session validity is also checked on every request.
    const current = (await store.read()).state.users.find(item => item.id === user.id && item.version === user.version && !item.disabled);
    if (!current) return false;
    await redis.del(limitKey);
    await issue(res, current);
    return true;
  }
  async function logout(req) {
    const header = req.get('Authorization') ?? '';
    if (/^Bearer [a-f0-9]{64}$/.test(header)) await redis.del(`flix:user-session:${hash(header.slice(7))}`);
  }
  const requireUser = async (req, res, next) => {
    try {
      const user = await principal(req);
      if (!user) return res.status(401).json({ error: 'Sign in to Flix to continue.' });
      req.flixUser = user;
      next();
    } catch { res.status(503).json({ error: 'Accounts unavailable.' }); }
  };
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.get('/me', requireUser, (req, res) => res.json(req.flixUser));
  router.post('/accept', async (req, res) => {
    const { token, name, password } = req.body ?? {};
    const limitKey = `flix:invitation-attempt:${hash(req.ip ?? '')}`;
    if (await redis.incr(limitKey) === 1) await redis.expire(limitKey, 900);
    if (Number(await redis.get(limitKey)) > 10) throw failure(429, 'Too many attempts. Try again in 15 minutes.');
    if (!/^[a-f0-9]{64}$/.test(token ?? '') || typeof name !== 'string' || !name.trim() || name.length > 128 || typeof password !== 'string' || password.length < 12 || password.length > 1024) throw failure(400, 'A valid invitation, name and password of at least 12 characters are required.');
    const invitationHash = hash(token);
    const validInvitation = state => state.invitations.find(invite => invite.tokenHash === invitationHash && !invite.revoked && !invite.acceptedAt && invite.expiresAt > now());
    if (!validInvitation((await store.read()).state)) throw failure(410, 'Invitation expired or already used.');
    const salt = randomBytes(16).toString('hex');
    const passwordHash = (await derive(password, salt, 64)).toString('hex');
    const user = await store.change(state => {
      const invite = validInvitation(state);
      if (!invite) throw failure(410, 'Invitation expired or already used.');
      if (state.users.some(user => user.email === invite.email)) throw failure(409, 'This account already exists.');
      const user = { id: randomUUID(), email: invite.email, name: name.trim(), language: invite.language, salt, passwordHash, version: randomUUID(), disabled: false, createdAt: now() };
      invite.acceptedAt = now();
      delete invite.encryptedToken;
      state.users.push(user);
      return user;
    });
    return issue(res, user);
  });

  function administration(requireAdmin) {
    const admin = Router();
    admin.use(requireAdmin);
    admin.get('/', async (_req, res) => {
      const { state } = await store.read();
      res.json({ mailConfigured: !!mailConfiguration(), users: state.users.map(publicUser), invitations: state.invitations.filter(invite => !invite.acceptedAt).map(invite => ({ id: invite.id, email: invite.email, language: invite.language, expiresAt: invite.expiresAt, revoked: invite.revoked, delivery: invite.delivery })) });
    });
    admin.post('/invitations', async (req, res) => {
      if (!mailConfiguration()) throw failure(503, 'Configure Mailjet and the public Flix URL on the API first.');
      const { email, language = 'en' } = req.body ?? {};
      if (typeof email !== 'string' || email.length > 254 || !emailPattern.test(email.trim()) || !['en', 'fr'].includes(language)) throw failure(400, 'A valid email address and language are required.');
      const normalized = email.trim().toLowerCase();
      const token = randomBytes(32).toString('hex');
      const id = randomUUID();
      await store.change(state => {
        state.invitations = state.invitations.filter(item => item.expiresAt > now() && !item.revoked && !item.acceptedAt);
        if (state.users.some(user => user.email === normalized)) throw failure(409, 'This account already exists.');
        if (state.invitations.some(invite => invite.email === normalized)) throw failure(409, 'An invitation is already pending for this email.');
        if (state.invitations.length >= 100 || state.users.length >= 1000) throw failure(409, 'Account or invitation limit reached.');
        state.invitations.push({ id, email: normalized, language, tokenHash: hash(token), encryptedToken: seal(token), createdAt: now(), expiresAt: now() + 7 * 86400000, revoked: false, delivery: 'queued', attempts: 0, nextAttempt: now() });
      }, { requireAdmin: true });
      res.status(202).json({ id, delivery: 'queued' });
    });
    admin.delete('/invitations/:id', async (req, res) => {
      await store.change(state => {
        const invite = state.invitations.find(invite => invite.id === req.params.id);
        if (!invite) throw failure(404, 'Invitation not found.');
        invite.revoked = true;
        delete invite.encryptedToken;
      });
      res.sendStatus(204);
    });
    admin.put('/users/:id', async (req, res) => {
      if (typeof req.body?.disabled !== 'boolean') throw failure(400, 'A boolean account status is required.');
      await store.change(state => {
        const user = state.users.find(user => user.id === req.params.id);
        if (!user) throw failure(404, 'User not found.');
        user.disabled = req.body.disabled;
        user.version = randomUUID();
      }, { requireAdmin: true });
      res.sendStatus(204);
    });
    admin.use(errors);
    return admin;
  }
  function errors(error, _req, res, _next) {
    res.status(error.status ?? 503).json({ error: error.status ? error.message : 'Accounts unavailable.' });
  }
  router.use(errors);

  async function deliverInvitations() {
    if (!mailConfiguration()) return;
    const lease = randomUUID();
    const leaseKey = 'flix:invitation-mail:lock';
    if (!await redis.set(leaseKey, lease, { NX: true, EX: 60 })) return;
    try {
      const { state } = await store.read();
      const invite = state.invitations.find(item => !item.revoked && !item.acceptedAt && item.expiresAt > now() && item.encryptedToken && item.attempts < 5 && item.nextAttempt <= now() && item.delivery !== 'sent');
      if (!invite) return;
      let success = false;
      try {
        const config = mailConfiguration();
        const url = `${config.url}/join#${open(invite.encryptedToken)}`;
        const french = invite.language === 'fr';
        const response = await fetcher('https://api.mailjet.com/v3.1/send', {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
          headers: { 'Content-Type': 'application/json', Authorization: `Basic ${Buffer.from(`${env.MAILJET_API_KEY}:${env.MAILJET_SECRET_KEY}`).toString('base64')}` },
          body: JSON.stringify({ Messages: [{ From: { Email: config.from, Name: config.name }, To: [{ Email: invite.email }], Subject: french ? 'Votre invitation Flix' : 'Your Flix invitation', TextPart: french ? `Vous avez été invité sur Flix. Créez votre compte :\n${url}\nCe lien est à usage unique et expire dans 7 jours.` : `You have been invited to Flix. Create your account:\n${url}\nThis single-use link expires in 7 days.`, CustomID: invite.id }] }),
        });
        const data = await response.json();
        success = response.ok && data.Messages?.length === 1 && data.Messages[0].Status === 'success';
      } catch { /* Do not log provider bodies, credentials, or invitation links. Retry durably. */ }
      await store.change(state => {
        const current = state.invitations.find(item => item.id === invite.id);
        if (!current || current.revoked || current.acceptedAt) return;
        current.attempts += 1;
        current.delivery = success ? 'sent' : current.attempts >= 5 ? 'failed' : 'queued';
        current.nextAttempt = now() + 60000 * 2 ** current.attempts;
        if (success) delete current.encryptedToken;
      });
    } finally {
      await redis.eval("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0", { keys: [leaseKey], arguments: [lease] });
    }
  }
  async function disableAuthentication() {
    // Pair with requireAdmin writes above: concurrent invitations must never reopen public mode.
    return await redis.eval(`
      local raw = redis.call('GET', KEYS[1])
      if raw then
        local accounts = cjson.decode(raw)
        for _, user in ipairs(accounts.users) do
          if not user.disabled then return 0 end
        end
        for _, invite in ipairs(accounts.invitations) do
          if not invite.revoked and not invite.acceptedAt and invite.expiresAt > tonumber(ARGV[1]) then return 0 end
        end
      end
      redis.call('DEL', KEYS[2])
      return 1
    `, { keys: [key, 'auth'], arguments: [String(now())] }) === 1;
  }
  async function hasAccounts() {
    const { state } = await store.read();
    return state.users.some(user => !user.disabled) || state.invitations.some(invite => !invite.revoked && !invite.acceptedAt && invite.expiresAt > now());
  }
  return { router, administration, principal, login, logout, deliverInvitations, disableAuthentication, hasAccounts };
}
