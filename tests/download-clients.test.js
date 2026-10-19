import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import express from 'express';
import { createDownloadClientsRouter } from '../download-clients/router.js';
import { publicInstances } from '../storage.js';
import { downloadProtection, configuredClients } from '../download-clients/index.js';
import { connectDeluge } from '../download-clients/connectors/deluge.js';
import { createAuthentication, passwordRecord, authenticationFingerprint } from '../auth.js';
import { authStore } from './helpers/auth-store.js';
import { createHash } from 'node:crypto';

const token = 'a'.repeat(64);
const hash = 'b'.repeat(40);
const service = { base_url: 'http://service.test', api_key: 'private-key' };
const client = { id: 'main', name: 'My client', type: 'deluge', base_url: 'http://deluge.test', password: 'private-password' };
const instance = { name: 'Test', download_clients_token: token, download_clients: [client], radarr: service, sonarr: service };
const torrent = { name: 'Completed film', state: 'Seeding', progress: 100, is_finished: true, total_size: 1e9, save_path: '/downloads', ratio: 2 };
const auth = await passwordRecord('User', 'password');
function remote(settings = {}) {
  const calls = [];
  const fetchRemote = async (url, options) => {
    url = new URL(url);
    if (url.pathname !== '/json') {
      if (url.pathname.endsWith('/command')) {
        calls.push({ commands: true, url });
        if (settings.commandFailure) return new Response('private upstream error', { status: 503 });
        return Response.json(settings.commands ?? []);
      }
      calls.push({ queue: true, url });
      if (settings.queueFailure) return new Response('private upstream error', { status: 503 });
      return Response.json({ totalRecords: settings.tracked ? 1 : 0, records: settings.tracked ? [{ id: 1, downloadId: hash.toUpperCase(), trackedDownloadState: settings.state ?? 'importBlocked' }] : [] });
    }
    const body = JSON.parse(options.body); calls.push(body);
    assert.equal(options.redirect, 'error');
    if (body.method !== 'auth.login') assert.equal(options.headers.Cookie, '_session_id=test-session');
    if (body.method === 'core.remove_torrent' && settings.uncertain) throw new Error('private credentials');
    const results = { 'auth.login': settings.login !== false, 'web.connected': settings.connected !== false,
      'core.get_torrents_status': settings.empty ? {} : { [hash]: { ...torrent, ...settings.torrent } }, 'core.remove_torrent': true };
    return Response.json({ id: body.id, result: results[body.method], error: null }, {
      headers: body.method === 'auth.login' ? { 'Set-Cookie': '_session_id=test-session; Path=/json; HttpOnly' } : {},
    });
  };
  return { calls, fetchRemote };
}
async function server(t, settings = {}, instances = [instance]) {
  const mock = remote(settings);
  const app = express(); app.use(express.json());
  const store = authStore(auth);
  const digest = value => createHash('sha256').update(value).digest('hex');
  await store.set(`flix:session:${digest(token)}`, authenticationFingerprint(auth), { EX: 60 });
  app.use('/download-clients', createAuthentication(store).requireSession);
  app.use(createDownloadClientsRouter(async () => instances, mock.fetchRemote));
  const http = createServer(app);
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => http.close(resolve)));
  const url = `http://127.0.0.1:${http.address().port}/download-clients/Test`;
  const send = (body = { name: torrent.name, deleteData: false }, access = token) => fetch(`${url}/main/${hash}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { ...mock, url, send };
}
test('public instances strip every client credential and access token', () => {
  const data = publicInstances([instance]);
  assert.equal(data[0].has_download_clients, true);
  assert.equal(data[0].download_clients, undefined);
  assert.equal(data[0].download_clients_token, undefined);
  assert.ok(!JSON.stringify(data).includes('private-password'));
});
test('client types and identities must be explicitly supported and unique', () => {
  for (const clients of [[{ ...client, type: 'constructor' }], [client, client], [{ ...client, id: '../x' }]]) {
    assert.throws(() => configuredClients({ download_clients: clients }));
  }
});
test('unauthenticated reads and writes never contact upstream services', async t => {
  const { url, send, calls } = await server(t);
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await send(undefined, 'wrong')).status, 401);
  assert.deepEqual(calls, []);
});
test('lists safe normalized capabilities without leaking passwords or cookies', async t => {
  const { url } = await server(t);
  const result = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  const data = await result.json();
  assert.equal(data.clients[0].allowDeleteData, false);
  assert.equal(data.clients[0].torrents[0].removable, true);
  assert.ok(!JSON.stringify(data).includes('private'));
  assert.ok(!JSON.stringify(data).includes('test-session'));
});
test('removes only the selected torrent and keeps data by default', async t => {
  const { send, calls } = await server(t);
  assert.equal((await send()).status, 204);
  assert.deepEqual(calls.filter(call => call.method === 'core.remove_torrent').map(call => call.params), [[hash, false]]);
  assert.equal(calls.filter(call => call.queue).length, 2);
});
test('data removal needs both explicit boolean consent and server permission', async t => {
  const denied = await server(t);
  assert.equal((await denied.send({ name: torrent.name, deleteData: true })).status, 403);
  assert.deepEqual(denied.calls, []);
  const enabled = await server(t, {}, [{ ...instance, download_clients: [{ ...client, allow_delete_data: true }] }]);
  assert.equal((await enabled.send({ name: torrent.name, deleteData: true })).status, 204);
  assert.deepEqual(enabled.calls.find(call => call.method === 'core.remove_torrent').params, [hash, true]);
  for (const deleteData of [undefined, 'false', 0]) assert.equal((await enabled.send({ name: torrent.name, deleteData })).status, 400);
});
test('changed or disappeared torrents cannot be removed', async t => {
  const changed = await server(t);
  assert.equal((await changed.send({ name: 'Different name', deleteData: false })).status, 409);
  assert.ok(!changed.calls.some(call => call.method === 'core.remove_torrent'));
  const missing = await server(t, { empty: true });
  assert.equal((await missing.send()).status, 409);
});
test('incomplete torrents are never removable', async t => {
  const { send, calls } = await server(t, { torrent: { progress: 50, is_finished: false } });
  assert.equal((await send()).status, 409);
  assert.ok(!calls.some(call => call.method === 'core.remove_torrent'));
});
test('tracked torrents are blocked even after the browser displayed an untracked snapshot', async t => {
  const { send, calls } = await server(t, { tracked: true });
  assert.equal((await send()).status, 409);
  assert.ok(!calls.some(call => call.method === 'core.remove_torrent'));
});
test('forcing removal requires an explicit boolean and still validates the torrent and queues', async t => {
  const tracked = await server(t, { tracked: true });
  assert.equal((await tracked.send({ name: torrent.name, deleteData: false, force: 'true' })).status, 400);
  assert.equal((await tracked.send({ name: torrent.name, deleteData: false, force: true })).status, 204);
  assert.deepEqual(tracked.calls.find(call => call.method === 'core.remove_torrent').params, [hash, false]);
  for (const settings of [{ queueFailure: true }, { torrent: { progress: 50, is_finished: false } }, { empty: true }]) {
    const blocked = await server(t, settings);
    assert.notEqual((await blocked.send({ name: torrent.name, deleteData: false, force: true })).status, 204);
    assert.ok(!blocked.calls.some(call => call.method === 'core.remove_torrent'));
  }
  const forbiddenData = await server(t, { tracked: true });
  assert.equal((await forbiddenData.send({ name: torrent.name, deleteData: true, force: true })).status, 403);
});
test('queue or daemon failures fail closed with sanitized errors', async t => {
  for (const settings of [{ queueFailure: true }, { connected: false }, { login: false }, { torrent: { progress: null } }]) {
    const { send, calls } = await server(t, settings);
    const response = await send();
    assert.equal(response.status, 502);
    assert.ok(!(await response.text()).includes('private'));
    assert.ok(!calls.some(call => call.method === 'core.remove_torrent'));
  }
});
test('uncertain removals are not retried and are reported explicitly', async t => {
  const { send, calls } = await server(t, { uncertain: true });
  const response = await send();
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /uncertain/);
  assert.equal(calls.filter(call => call.method === 'core.remove_torrent').length, 1);
});
test('tracking checks all instances and all queue pages', async () => {
  let reads = 0;
  const records = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, downloadId: `download-${i}` }));
  const result = await downloadProtection([instance, instance], async url => {
    if (new URL(url).pathname.endsWith('/command')) return Response.json([]);
    reads++;
    return Response.json({ totalRecords: 101, records: new URL(url).searchParams.get('page') === '1' ? records : [{ id: 101, downloadId: hash }] });
  });
  assert.equal(reads, 8); assert.equal(result.tracked.has(hash), true);
  assert.equal(result.reason(hash), 'Import status unavailable');
});
test('unverifiable or incomplete tracking never grants cleanup permission', async () => {
  for (const data of [{ records: [], totalRecords: 1 }, { records: [{}], totalRecords: 1 }, { records: [] }]) {
    await assert.rejects(downloadProtection([instance], async () => Response.json(data)));
  }
});
test('Deluge URLs cannot redirect credentials or use unsupported schemes', async () => {
  for (const base_url of ['file:///private', 'http://user:password@host', 'http://host?key=secret']) {
    await assert.rejects(connectDeluge({ ...client, base_url }, async () => { throw new Error('Must not fetch'); }));
  }
});

test('queue imports and unknown states block even forced removal, with or without data deletion', async t => {
  for (const state of ['importing', 'importPending', 'unknown']) {
    const settings = { tracked: true, state };
    const { url, send, calls } = await server(t, settings, [{ ...instance, download_clients: [{ ...client, allow_delete_data: true }] }]);
    const data = await (await fetch(url, { headers: { Authorization: `Bearer ${token}` } })).json();
    assert.ok(data.clients[0].torrents[0].removalBlockedReason);
    assert.equal(data.clients[0].torrents[0].removable, false);
    for (const deleteData of [false, true]) assert.equal((await send({ name: torrent.name, deleteData, force: true })).status, 409);
    assert.ok(!calls.some(call => call.method === 'core.remove_torrent'));
  }
});

test('queued and running manual imports protect even untracked torrents', async t => {
  for (const status of ['queued', 'started']) {
    const { send, calls } = await server(t, { commands: [{ name: 'ManualImport', status, body: { files: [{ downloadId: hash.toUpperCase() }] } }] });
    assert.equal((await send({ name: torrent.name, deleteData: false, force: true })).status, 409);
    assert.ok(!calls.some(call => call.method === 'core.remove_torrent'));
  }
});

test('completed and failed commands do not permanently lock cleanup', async t => {
  for (const status of ['completed', 'failed', 'aborted', 'cancelled']) {
    const { send } = await server(t, { commands: [{ name: 'ManualImport', status, body: { files: [{ downloadId: hash }] } }] });
    assert.equal((await send()).status, 204);
  }
});

test('unidentified imports, unknown command states and unavailable command reads fail closed', async t => {
  for (const settings of [
    { commands: [{ name: 'ManualImport', status: 'started', body: { files: [{ path: '/remote/path/film.mkv' }] } }] },
    { commands: [{ name: 'DownloadedMoviesScan', status: 'queued', body: { path: '/remote/downloads' } }] },
    { commands: [{ name: 'ManualImport', status: 'unknown' }] },
    { commands: [{ name: 'ManualImport', status: 'orphaned' }] },
    { commandFailure: true }, { commands: {} },
  ]) {
    const { send, calls } = await server(t, settings);
    assert.notEqual((await send({ name: torrent.name, deleteData: false, force: true })).status, 204);
    assert.ok(!calls.some(call => call.method === 'core.remove_torrent'));
  }
});

test('download scans protect only the identified torrent, not unrelated imports', async t => {
  for (const name of ['DownloadedMoviesScan', 'DownloadedEpisodesScan']) {
    const active = await server(t, { commands: [{ name, status: 'started', body: { downloadClientId: hash } }] });
    assert.equal((await active.send()).status, 409);
    const unrelated = await server(t, { commands: [{ name, status: 'started', body: { downloadClientId: 'other-download' } }] });
    assert.equal((await unrelated.send()).status, 204);
  }
});

test('all configured services are checked and removal revalidates after the displayed snapshot', async t => {
  const settings = { commands: [] };
  const { url, send, calls } = await server(t, settings);
  const data = await (await fetch(url, { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.equal(data.clients[0].torrents[0].removalBlockedReason, null);
  settings.commands = [{ name: 'ManualImport', status: 'queued', body: { files: [{ downloadId: hash }] } }];
  assert.equal((await send({ name: torrent.name, deleteData: false, force: true })).status, 409);
  assert.equal(calls.filter(call => call.commands).length, 4);
  assert.ok(!calls.some(call => call.method === 'core.remove_torrent'));
});
