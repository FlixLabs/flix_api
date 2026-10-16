import { Router } from 'express';
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import CryptoJS from 'crypto-js';

const derive = promisify(scrypt);
const duration = 30 * 24 * 60 * 60;
const digest = value => createHash('sha256').update(value).digest('hex');
const enabled = auth => !!(auth && auth.username && (auth.passwordHash || auth.password));
export const authenticationFingerprint = auth => digest(JSON.stringify([
  auth.username, auth.passwordHash, auth.salt, auth.version, auth.password,
]));

export async function passwordRecord(username, password) {
  const salt = randomBytes(16).toString('hex');
  const hash = await derive(password, salt, 64);
  return { username, salt, passwordHash: hash.toString('hex'), version: randomBytes(32).toString('hex') };
}

export function createAuthentication(redis, { legacyKey = process.env.AUTH_LEGACY_CRYPT_KEY, accounts } = {}) {
  const router = Router();
  const read = () => redis.json.get('auth');
  const sessionKey = token => `flix:session:${digest(token)}`;
  async function authenticated(req, auth) {
    if (accounts && await accounts.principal(req)) return false;
    if (!enabled(auth)) return !(accounts && await accounts.hasAccounts());
    const header = req.get('Authorization') ?? '';
    if (!/^Bearer [a-f0-9]{64}$/.test(header)) return false;
    const stored = await redis.get(sessionKey(header.slice(7)));
    return !!stored && stored === authenticationFingerprint(auth);
  }
  async function issue(res, auth) {
    const token = randomBytes(32).toString('hex');
    await redis.set(sessionKey(token), authenticationFingerprint(auth), { EX: duration });
    return res.json({ enabled: true, authenticated: true, token, expiresIn: duration });
  }
  const requireSession = async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    try {
      if (!await authenticated(req, await read())) return res.status(401).json({ error: 'Sign in to Flix to continue.' });
      next();
    } catch { res.status(503).json({ error: 'Authentication unavailable.' }); }
  };
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.get('/auth', async (req, res) => {
    const auth = await read();
    res.json({ enabled: enabled(auth), ...(await authenticated(req, auth) && enabled(auth) ? { username: auth.username } : {}) });
  });
  router.get('/session', async (req, res) => {
    const user = accounts && await accounts.principal(req);
    if (user) return res.json({ enabled: true, authenticated: true, role: 'user', user });
    const auth = await read();
    res.json({ enabled: enabled(auth), authenticated: await authenticated(req, auth) });
  });
  router.post('/session', async (req, res) => {
    if (accounts && await accounts.login(req, res)) return;
    const auth = await read();
    if (!enabled(auth)) {
      if (accounts && await accounts.hasAccounts()) return res.status(503).json({ error: 'Authentication unavailable.' });
      return res.json({ enabled: false, authenticated: true });
    }
    const limitKey = `flix:login:${digest(req.ip ?? 'unknown')}`;
    const attempts = await redis.incr(limitKey);
    if (attempts === 1) await redis.expire(limitKey, 900);
    if (attempts > 10) return res.status(429).json({ error: 'Too many sign-in attempts. Try again in 15 minutes.' });
    const { username, password } = req.body ?? {};
    if (typeof username !== 'string' || typeof password !== 'string' || password.length > 1024 || !password.length) return res.status(400).json({ error: 'Username and password are required.' });
    let valid = false;
    if (auth.passwordHash) {
      const actual = await derive(password, auth.salt, 64);
      const expected = Buffer.from(auth.passwordHash, 'hex');
      valid = actual.length === expected.length && timingSafeEqual(actual, expected);
    } else {
      if (!legacyKey) return res.status(503).json({ error: 'Existing account migration requires AUTH_LEGACY_CRYPT_KEY on the API.' });
      try {
        const legacy = CryptoJS.AES.decrypt(auth.password, legacyKey).toString(CryptoJS.enc.Utf8);
        valid = !!legacy && timingSafeEqual(Buffer.from(digest(password)), Buffer.from(digest(legacy)));
      } catch { valid = false; }
    }
    if (!valid || username !== auth.username) return res.status(401).json({ error: 'Wrong username or password.' });
    // Do not overwrite a password changed concurrently with sign-in/migration.
    if (JSON.stringify(await read()) !== JSON.stringify(auth)) return res.status(409).json({ error: 'Account changed. Please sign in again.' });
    const current = auth.passwordHash ? auth : await passwordRecord(username, password);
    if (!auth.passwordHash) {
      const migrated = await redis.eval(`
        local raw = redis.call('JSON.GET', KEYS[1])
        if not raw then return 0 end
        local current = cjson.decode(raw)
        if current.username ~= ARGV[1] or current.password ~= ARGV[2] then return 0 end
        redis.call('JSON.SET', KEYS[1], '$', ARGV[3])
        return 1
      `, { keys: ['auth'], arguments: [auth.username, auth.password, JSON.stringify(current)] });
      if (migrated !== 1) return res.status(409).json({ error: 'Account changed. Please sign in again.' });
    }
    await redis.del(limitKey);
    return issue(res, current);
  });
  router.delete('/session', async (req, res) => {
    if (accounts) await accounts.logout(req);
    const header = req.get('Authorization') ?? '';
    if (/^Bearer [a-f0-9]{64}$/.test(header)) await redis.del(sessionKey(header.slice(7)));
    res.sendStatus(204);
  });
  router.post('/auth', requireSession, async (req, res) => {
    const { username, password } = req.body ?? {};
    if (typeof username !== 'string' || !username.trim() || username.length > 128 || typeof password !== 'string' || !password.length || password.length > 1024) return res.status(400).json({ error: 'Username and password are required.' });
    const auth = await passwordRecord(username, password);
    await redis.json.set('auth', '$', auth);
    return issue(res, auth);
  });
  router.delete('/auth', requireSession, async (req, res) => {
    if (accounts) {
      if (!await accounts.disableAuthentication()) return res.status(409).json({ error: 'Revoke pending invitations and disable guest accounts before disabling authentication.' });
    } else await redis.json.del('auth');
    res.sendStatus(204);
  });
  router.use((error, _req, res, _next) => {
    if ([400, 409, 429].includes(error.status)) return res.status(error.status).json({ error: error.message });
    res.status(503).json({ error: 'Authentication unavailable.' });
  });
  const requireAdministrator = async (req, res, next) => {
    try {
      const auth = await read();
      if (!enabled(auth)) return res.status(403).json({ error: 'Enable administrator authentication before inviting users.' });
      if (!await authenticated(req, auth)) return res.status(403).json({ error: 'Administrator access required.' });
      next();
    } catch { res.status(503).json({ error: 'Authentication unavailable.' }); }
  };
  return { router, requireSession, requireAdministrator };
}
