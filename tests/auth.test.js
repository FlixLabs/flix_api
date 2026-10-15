import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import express from 'express';
import CryptoJS from 'crypto-js';
import { createAuthentication, passwordRecord } from '../auth.js';
import { authStore } from './helpers/auth-store.js';

const credentials = { username: 'User', password: 'test-password' };
const account = await passwordRecord(credentials.username, credentials.password);
async function server(t, auth = account, options = {}) {
  const store = authStore(auth);
  const authentication = createAuthentication(store, options);
  const app = express(); app.use(express.json()); app.use(authentication.router);
  app.get('/private', authentication.requireSession, (_req, res) => res.json({ ok: true }));
  const http = createServer(app);
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => http.close(resolve)));
  const base = `http://127.0.0.1:${http.address().port}`;
  const send = (path, method = 'GET', body, token) => fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { store, send };
}
test('only authenticated sessions unlock protected routes; credentials are never returned', async t => {
  const { send, store } = await server(t);
  assert.deepEqual(await (await send('/auth')).json(), { enabled: true });
  assert.equal((await send('/private')).status, 401);
  assert.equal((await send('/session', 'POST', { ...credentials, password: 'wrong' })).status, 401);
  const response = await send('/session', 'POST', credentials);
  const session = await response.json();
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(session.token, /^[a-f0-9]{64}$/);
  assert.equal(session.expiresIn, 2592000);
  assert.ok(![...store.values.keys()].some(key => key.includes(session.token)));
  assert.equal((await send('/private', 'GET', null, session.token)).status, 200);
  const config = await (await send('/auth', 'GET', null, session.token)).json();
  assert.deepEqual(config, { enabled: true, username: credentials.username });
  const key = `flix:session:${createHash('sha256').update(session.token).digest('hex')}`;
  store.values.get(key).expiresAt = Date.now() - 1;
  assert.equal((await send('/private', 'GET', null, session.token)).status, 401);
});
test('sign out revokes the session, password changes revoke other sessions and settings require login', async t => {
  const { send } = await server(t);
  assert.equal((await send('/auth', 'POST', credentials)).status, 401);
  assert.equal((await send('/auth', 'DELETE')).status, 401);
  const first = await (await send('/session', 'POST', credentials)).json();
  const second = await (await send('/session', 'POST', credentials)).json();
  assert.equal((await send('/session', 'DELETE', null, first.token)).status, 204);
  assert.equal((await send('/private', 'GET', null, first.token)).status, 401);
  const updated = await (await send('/auth', 'POST', { ...credentials, password: 'new' }, second.token)).json();
  assert.equal((await send('/private', 'GET', null, second.token)).status, 401);
  assert.equal((await send('/private', 'GET', null, updated.token)).status, 200);
});
test('legacy credentials migrate only after successful server-side verification', async t => {
  const legacyKey = 'test-only-migration-key';
  const legacy = { username: credentials.username, password: CryptoJS.AES.encrypt(credentials.password, legacyKey).toString() };
  const missing = await server(t, legacy, { legacyKey: '' });
  assert.equal((await missing.send('/session', 'POST', credentials)).status, 503);
  const { send, store } = await server(t, legacy, { legacyKey });
  assert.equal((await send('/session', 'POST', { ...credentials, password: 'wrong' })).status, 401);
  assert.deepEqual(await store.json.get(), legacy);
  const session = await (await send('/session', 'POST', credentials)).json();
  const migrated = await store.json.get();
  assert.equal(migrated.password, undefined);
  assert.match(migrated.passwordHash, /^[a-f0-9]{128}$/);
  assert.ok(!JSON.stringify(migrated).includes(credentials.password));
  assert.equal((await send('/private', 'GET', null, session.token)).status, 200);
});
test('public mode needs no extra token and enabling authentication closes it immediately', async t => {
  const { send } = await server(t, null);
  assert.deepEqual(await (await send('/session')).json(), { enabled: false, authenticated: true });
  assert.equal((await send('/private')).status, 200);
  const session = await (await send('/auth', 'POST', credentials)).json();
  assert.equal((await send('/private')).status, 401);
  assert.equal((await send('/private', 'GET', null, session.token)).status, 200);
});
test('repeated failed sign-ins are rate limited', async t => {
  const { send } = await server(t);
  for (let i = 0; i < 10; i++) assert.equal((await send('/session', 'POST', { ...credentials, password: 'wrong' })).status, 401);
  assert.equal((await send('/session', 'POST', credentials)).status, 429);
});
test('migration cannot overwrite a concurrently changed password and Redis errors fail closed', async t => {
  const legacyKey = 'migration-key';
  const legacy = { username: credentials.username, password: CryptoJS.AES.encrypt(credentials.password, legacyKey).toString() };
  const { send, store } = await server(t, legacy, { legacyKey });
  store.eval = async () => { await store.json.set('auth', '$', account); return 0; };
  assert.equal((await send('/session', 'POST', credentials)).status, 409);
  assert.deepEqual(await store.json.get(), account);
  store.json.get = async () => { throw new Error('private redis credentials'); };
  const response = await send('/private');
  assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes('private redis'));
  assert.equal((await send('/session', 'POST', credentials)).status, 503);
});
