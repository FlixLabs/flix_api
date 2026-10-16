import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import express from 'express';
import { createAccounts } from '../accounts.js';
import { accountStore } from '../accounts.js';
import { createAuthentication, passwordRecord } from '../auth.js';

const administrator = await passwordRecord('admin', 'administrator-password');
const mailEnv = { MAILJET_API_KEY: 'test-public', MAILJET_SECRET_KEY: 'test-secret', MAIL_FROM_EMAIL: 'flix@example.test', FLIX_PUBLIC_URL: 'https://flix.example.test' };
async function setup(t, options = {}) {
  const values = new Map();
  let auth = administrator;
  const redis = {
    get: async key => { const entry = values.get(key); return entry && (!entry.expiresAt || entry.expiresAt > Date.now()) ? entry.value : null; },
    set: async (key, value, options = {}) => { if (options.NX && await redis.get(key)) return null; values.set(key, { value, expiresAt: options.EX ? Date.now() + options.EX * 1000 : 0 }); return 'OK'; },
    del: async key => values.delete(key),
    incr: async key => { const value = Number(await redis.get(key) ?? 0) + 1; await redis.set(key, String(value)); return value; },
    expire: async (key, seconds) => { values.get(key).expiresAt = Date.now() + seconds * 1000; },
    json: { get: async () => auth, set: async (_key, _path, value) => { auth = value; }, del: async () => { auth = null; } },
    eval: async (script, { keys, arguments: args }) => {
      const current = values.get(keys[0])?.value ?? null;
      if (script.includes('local accounts')) {
        const state = current ? JSON.parse(current) : { users: [], invitations: [] };
        if (state.users.some(user => !user.disabled) || state.invitations.some(invite => !invite.revoked && !invite.acceptedAt && invite.expiresAt > Number(args[0]))) return 0;
        auth = null; return 1;
      }
      if (script.includes("redis.call('DEL'")) { if (current === args[0]) return Number(values.delete(keys[0])); return 0; }
      if (args[2] === '1' && (!auth?.username || !(auth.passwordHash || auth.password))) return -1;
      if ((current ?? '') !== args[0]) return 0;
      values.set(keys[0], { value: args[1], expiresAt: 0 }); return 1;
    },
  };
  const messages = [];
  let clock = Date.now();
  let failMail = false;
  const accounts = createAccounts(redis, { env: mailEnv, now: () => clock, fetcher: async (_url, request) => {
    messages.push(JSON.parse(request.body));
    return { ok: true, json: async () => ({ Messages: [{ Status: failMail ? 'error' : 'success' }] }) };
  }, ...options });
  const authentication = createAuthentication(redis, { accounts });
  const app = express(); app.use(express.json()); app.use(authentication.router);
  app.use('/accounts', accounts.router);
  app.use('/admin/accounts', accounts.administration(authentication.requireAdministrator));
  app.get('/instances', authentication.requireSession, (_req, res) => res.json({ privateKey: 'never-for-guests' }));
  const http = createServer(app);
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => http.close(resolve)));
  const base = `http://127.0.0.1:${http.address().port}`;
  const send = (path, method = 'GET', body, token) => fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const admin = (await (await send('/session', 'POST', { username: 'admin', password: 'administrator-password' })).json()).token;
  async function invite(email = 'guest@example.test', language = 'fr') {
    const response = await send('/admin/accounts/invitations', 'POST', { email, language }, admin);
    assert.equal(response.status, 202);
    const data = await response.json();
    await accounts.deliverInvitations();
    const token = /\/join#([a-f0-9]{64})/.exec(messages.at(-1).Messages[0].TextPart)?.[1];
    return { ...data, token };
  }
  return { send, admin, invite, accounts, redis, values, messages, advance: ms => { clock += ms; }, failMail: value => { failMail = value; } };
}
const acceptBody = token => ({ token, name: 'Guest', password: 'a-long-guest-password' });

test('invitation delivery is queued, localized, secret-safe and accepted once', async t => {
  const { send, admin, invite, values, messages } = await setup(t);
  const invitation = await invite();
  assert.match(messages[0].Messages[0].Subject, /invitation Flix/);
  assert.ok(!JSON.stringify([...values.values()]).includes(invitation.token));
  const listing = await (await send('/admin/accounts', 'GET', null, admin)).json();
  assert.equal(listing.invitations[0].delivery, 'sent');
  assert.ok(!JSON.stringify(listing).includes('tokenHash'));
  const response = await send('/accounts/accept', 'POST', acceptBody(invitation.token));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const session = await response.json();
  assert.equal(session.role, 'user');
  assert.equal(session.user.email, 'guest@example.test');
  assert.ok(!JSON.stringify(session).includes('passwordHash'));
  assert.equal((await send('/accounts/accept', 'POST', acceptBody(invitation.token))).status, 410);
  assert.equal((await send('/accounts/me', 'GET', null, session.token)).status, 200);
});
test('guest sessions can never access admin routes or instance credentials and revocation is immediate', async t => {
  const { send, admin, invite } = await setup(t);
  const invitation = await invite();
  const guest = await (await send('/accounts/accept', 'POST', acceptBody(invitation.token))).json();
  assert.equal((await send('/instances', 'GET', null, guest.token)).status, 401);
  assert.equal((await send('/admin/accounts', 'GET', null, guest.token)).status, 403);
  assert.equal((await send('/auth', 'POST', { username: 'evil', password: 'password' }, guest.token)).status, 401);
  assert.equal((await send('/auth', 'DELETE', null, admin)).status, 409);
  const login = await (await send('/session', 'POST', { username: 'guest@example.test', password: 'a-long-guest-password' })).json();
  assert.equal(login.role, 'user');
  assert.equal((await (await send('/session', 'GET', null, login.token)).json()).role, 'user');
  assert.equal((await send(`/admin/accounts/users/${guest.user.id}`, 'PUT', { disabled: true }, admin)).status, 204);
  assert.equal((await send('/accounts/me', 'GET', null, guest.token)).status, 401);
  assert.equal((await send('/accounts/me', 'GET', null, login.token)).status, 401);
  assert.equal((await send('/session', 'POST', { username: 'guest@example.test', password: 'a-long-guest-password' })).status, 401);
});
test('revoked and expired invitations cannot create accounts', async t => {
  const { send, admin, invite, advance } = await setup(t);
  const first = await invite();
  assert.equal((await send(`/admin/accounts/invitations/${first.id}`, 'DELETE', null, admin)).status, 204);
  assert.equal((await send('/accounts/accept', 'POST', acceptBody(first.token))).status, 410);
  const second = await invite('second@example.test');
  advance(8 * 86400000);
  assert.equal((await send('/accounts/accept', 'POST', acceptBody(second.token))).status, 410);
});
test('concurrent invitation acceptances produce exactly one account and reject role escalation', async t => {
  const { send, admin, invite } = await setup(t);
  const invitation = await invite();
  const responses = await Promise.all([1, 2].map(() => send('/accounts/accept', 'POST', { ...acceptBody(invitation.token), role: 'admin', email: 'other@example.test' })));
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 410]);
  const listing = await (await send('/admin/accounts', 'GET', null, admin)).json();
  assert.equal(listing.users.length, 1);
  assert.equal(listing.users[0].role, 'user');
  assert.equal(listing.users[0].email, 'guest@example.test');
});
test('Mailjet message-level errors are retried durably and duplicate senders are leased', async t => {
  const { send, admin, accounts, redis, failMail, advance, messages } = await setup(t);
  await send('/admin/accounts/invitations', 'POST', { email: 'guest@example.test' }, admin);
  await redis.set('flix:invitation-mail:lock', 'another-worker', { EX: 60 });
  await accounts.deliverInvitations();
  assert.equal(messages.length, 0);
  await redis.del('flix:invitation-mail:lock');
  failMail(true);
  await accounts.deliverInvitations();
  assert.equal(messages.length, 1);
  await accounts.deliverInvitations();
  assert.equal(messages.length, 1);
  failMail(false); advance(180000);
  await accounts.deliverInvitations();
  assert.equal(messages.length, 2);
  const listing = await (await send('/admin/accounts', 'GET', null, admin)).json();
  assert.equal(listing.invitations[0].delivery, 'sent');
});
test('public mode cannot invite guests; invalid email and unconfigured Mailjet fail safely', async t => {
  const { send, admin } = await setup(t);
  assert.equal((await send('/admin/accounts/invitations', 'POST', { email: 'invalid' }, admin)).status, 400);
  assert.equal((await send('/auth', 'DELETE', null, admin)).status, 204);
  assert.equal((await send('/admin/accounts/invitations', 'POST', { email: 'guest@example.test' })).status, 403);
  assert.equal((await send('/instances')).status, 200);
  const missing = await setup(t, { env: {} });
  assert.equal((await missing.send('/admin/accounts/invitations', 'POST', { email: 'guest@example.test' }, missing.admin)).status, 503);
});
test('guest logout revokes sessions and failed acceptance is rate limited', async t => {
  const { send, invite } = await setup(t);
  const invitation = await invite();
  const guest = await (await send('/accounts/accept', 'POST', acceptBody(invitation.token))).json();
  assert.equal((await send('/session', 'DELETE', null, guest.token)).status, 204);
  assert.equal((await send('/accounts/me', 'GET', null, guest.token)).status, 401);
  for (let attempt = 0; attempt < 9; attempt++) await send('/accounts/accept', 'POST', acceptBody('bad'));
  assert.equal((await send('/accounts/accept', 'POST', acceptBody('bad'))).status, 429);
});
test('authentication cannot be disabled concurrently with invitation creation', async t => {
  const { send, admin, redis } = await setup(t);
  const [invitation, disabled] = await Promise.all([
    send('/admin/accounts/invitations', 'POST', { email: 'guest@example.test' }, admin),
    send('/auth', 'DELETE', null, admin),
  ]);
  assert.ok((invitation.status === 202 && disabled.status === 409) || (invitation.status === 403 && disabled.status === 204));
  if (disabled.status === 204) {
    await assert.rejects(accountStore(redis).change(state => { state.users.push({ id: 'unsafe' }); }, { requireAdmin: true }), { status: 403 });
  }
});
test('reenabling access never restores revoked sessions', async t => {
  const { send, admin, invite } = await setup(t);
  const invitation = await invite();
  const guest = await (await send('/accounts/accept', 'POST', acceptBody(invitation.token))).json();
  await send(`/admin/accounts/users/${guest.user.id}`, 'PUT', { disabled: true }, admin);
  await send(`/admin/accounts/users/${guest.user.id}`, 'PUT', { disabled: false }, admin);
  assert.equal((await send('/accounts/me', 'GET', null, guest.token)).status, 401);
  const response = await send('/session', 'POST', { username: 'guest@example.test', password: 'a-long-guest-password' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).role, 'user');
});
test('a missing administrator record never reopens public service access while guests exist', async t => {
  const { send, invite, redis } = await setup(t);
  await invite();
  await redis.json.del('auth');
  assert.equal((await send('/instances')).status, 401);
  assert.equal((await (await send('/session')).json()).authenticated, false);
  assert.equal((await send('/session', 'POST', { username: 'unknown', password: 'password' })).status, 503);
});
