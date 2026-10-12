import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import express from 'express';
import { createStorageRouter, publicInstances, publicStorage } from '../storage.js';
import { createStorageServer } from '../storage-agent/server.js';
import { collectStorage, filesystemMetrics, volumeIdentity } from '../storage-agent/storage.js';
import { storageFailure } from '../storage-agent/diagnostics.js';

const token = 'a'.repeat(64);
const result = { collectedAt: new Date().toISOString(), locations: [{
  id: 'movies', path: '/storage/movies', available: true, volumeId: 'test',
  totalBytes: 100, usedBytes: 70, availableBytes: 20, reservedBytes: 10, usagePercent: 78,
}] };

for (const [code, expected] of [['EIO', 'IO_ERROR'], ['ESTALE', 'STALE_MOUNT'], ['ENOTCONN', 'MOUNT_DISCONNECTED'],
  ['ENOENT', 'PATH_NOT_FOUND'], ['EACCES', 'PERMISSION_DENIED'], ['EPERM', 'PERMISSION_DENIED'], ['ENOTDIR', 'NOT_DIRECTORY']]) {
  test(`agent maps ${code} without exposing filesystem errors`, () => {
    const data = storageFailure(Object.assign(new Error('private host password'), { code, path: '/private' }));
    assert.equal(data.code, expected);
    assert.ok(!JSON.stringify(data).includes('private'));
  });
}

test('an I/O failure affects only its own location and preserves safe diagnostics', async () => {
  const data = await collectStorage([{ id: 'movies', path: '/storage/movies' }, { id: 'downloads', path: '/storage/downloads' }], {
    readFile: async () => '1 0 0:1 / / rw - ext4 /dev/test rw',
    stat: async path => {
      if (path.endsWith('/movies')) throw Object.assign(new Error('secret credentials'), { code: 'EIO' });
      return { isDirectory: () => true };
    },
    statfs: async () => ({ blocks: 100n, bsize: 1024n, bfree: 30n, bavail: 20n }),
  });
  assert.equal(data.locations[0].code, 'IO_ERROR');
  assert.equal(data.locations[1].available, true);
  assert.ok(!JSON.stringify(data).includes('secret'));
});

test('API preserves approved volume codes and strips unsafe diagnostics', () => {
  const data = publicStorage({ collectedAt: result.collectedAt, locations: [
    { id: 'movies', path: '/storage/movies', available: false, code: 'IO_ERROR', error: 'secret password', source: 'private source' },
    { id: 'series', path: '/storage/series', available: false, code: 'unknown secret' },
  ] });
  assert.equal(data.locations[0].code, 'IO_ERROR');
  assert.equal(data.locations[1].code, 'STORAGE_UNAVAILABLE');
  assert.ok(!JSON.stringify(data).includes('secret'));
  assert.ok(!JSON.stringify(data).includes('private'));
});

test('API marks invalid metrics without discarding valid locations or exposing NaN', () => {
  const broken = { ...result.locations[0], id: 'series', totalBytes: -1 };
  const data = publicStorage({ ...result, locations: [result.locations[0], broken] });
  assert.equal(data.locations[0].available, true);
  assert.equal(data.locations[1].available, false);
  assert.equal(data.locations[1].code, 'INVALID_METRICS');
  assert.throws(() => publicStorage({ ...result, locations: [result.locations[0], result.locations[0]] }));
});

for (const [status, code] of [[401, 'AGENT_AUTH_FAILED'], [403, 'AGENT_AUTH_FAILED'], [404, 'AGENT_ENDPOINT_NOT_FOUND'], [503, 'AGENT_MEASUREMENT_FAILED']]) {
  test(`API reports agent HTTP ${status} safely`, async t => {
    const app = express();
    app.use(createStorageRouter(async () => [{ name: 'Test', storage_agent: { base_url: 'http://agent.test', token } }],
      async () => new Response('private error', { status })));
    const url = await listen(createServer(app), t);
    const response = await fetch(url + '/storage/Test');
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: 'Storage agent unavailable', code });
  });
}

test('API does not expose timeout, configuration or Redis errors', async t => {
  for (const [instances, agentFetch, code] of [
    [async () => { throw new Error('Redis password'); }, fetch, 'INSTANCE_DATA_UNAVAILABLE'],
    [async () => [{ name: 'Test', storage_agent: { base_url: 'file:///private', token } }], fetch, 'AGENT_CONFIG_INVALID'],
    [async () => [{ name: 'Test', storage_agent: { base_url: 'http://agent.test', token } }], async () => { throw new DOMException('private URL', 'TimeoutError'); }, 'AGENT_TIMEOUT'],
  ]) {
    const app = express(); app.use(createStorageRouter(instances, agentFetch));
    const url = await listen(createServer(app), t);
    const response = await fetch(url + '/storage/Test');
    assert.equal((await response.json()).code, code);
  }
});

async function listen(server, t) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('calculates usage like df, accounting for reserved blocks', () => {
  assert.deepEqual(filesystemMetrics({ blocks: 100n, bsize: 1024n, bfree: 30n, bavail: 20n }), {
    totalBytes: 102400, usedBytes: 71680, availableBytes: 20480, reservedBytes: 10240, usagePercent: 78,
  });
  assert.throws(() => filesystemMetrics({ blocks: 0n, bsize: 1n, bfree: 0n, bavail: 0n }));
});

test('matches reference df figures, including reserved space and 98% usage', () => {
  const blocks = 7747884668n;
  const used = 7203485988n;
  const available = 153851736n;
  const metrics = filesystemMetrics({ blocks, bsize: 1024n, bfree: blocks - used, bavail: available });
  assert.equal(metrics.totalBytes, Number(blocks * 1024n));
  assert.equal(metrics.availableBytes, Number(available * 1024n));
  assert.equal(metrics.usagePercent, 98);
});

test('recognizes bind mounts of the same volume without exposing its source', () => {
  const mounts = [
    '1 0 0:1 / / rw - overlay overlay rw',
    '2 1 0:42 /movies /storage/movies ro - fuse.sshfs secret@example:plex rw',
    '3 1 0:42 /tv /storage/series ro - fuse.sshfs secret@example:plex rw',
    '4 1 8:2 / /storage/downloads ro - ext4 /dev/sda2 rw',
  ].join('\n');
  const movie = volumeIdentity(mounts, '/storage/movies');
  assert.equal(movie, volumeIdentity(mounts, '/storage/series'));
  assert.notEqual(movie, volumeIdentity(mounts, '/storage/downloads'));
  assert.match(movie, /^[a-f0-9]{64}$/);
});

test('decodes escaped mount paths and respects path boundaries', () => {
  const mounts = '1 0 0:1 / / rw - overlay overlay rw\n2 1 0:2 / /media\\040files ro - ext4 /dev/sda2 rw';
  assert.notEqual(volumeIdentity(mounts, '/media files/movie'), volumeIdentity(mounts, '/media files-backup'));
});

test('reads a real filesystem without modifying it', async t => {
  const path = await mkdtemp(join(tmpdir(), 'flix-storage-'));
  t.after(() => rm(path, { recursive: true }));
  const info = await statfs(path, { bigint: true });
  const metrics = filesystemMetrics(info);
  assert.ok(metrics.totalBytes > 0);
  assert.ok(metrics.availableBytes <= metrics.totalBytes);
  if (process.platform === 'linux') {
    const data = await collectStorage([{ id: 'movies', path }, { id: 'downloads', path: path + '/missing' }]);
    assert.equal(data.locations[0].totalBytes, metrics.totalBytes);
    assert.equal(data.locations[1].available, false);
  }
});

test('agent requires a strong token', () => {
  assert.throws(() => createStorageServer({ token: 'short', locations: [] }));
});

test('agent protects access, rejects writes and arbitrary paths, and caches collection', async t => {
  let calls = 0;
  const server = createStorageServer({ token, locations: [], collect: async () => { calls++; return result; } });
  const url = await listen(server, t);
  assert.equal((await fetch(url + '/storage')).status, 401);
  const headers = { Authorization: `Bearer ${token}` };
  assert.equal((await fetch(url + '/storage', { headers: { Authorization: 'Bearer ' + 'b'.repeat(64) } })).status, 401);
  assert.equal((await fetch(url + '/storage', { method: 'POST', headers })).status, 405);
  assert.equal((await fetch(url + '/storage?path=/etc', { headers })).status, 404);
  for (let i = 0; i < 2; i++) {
    const response = await fetch(url + '/storage', { headers });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), result);
  }
  assert.equal(calls, 1);
});

test('API never exposes the agent credentials in instances', () => {
  const instances = publicInstances([{ name: 'Example', storage_agent: { base_url: 'http://private', token }, radarr: {} }]);
  assert.deepEqual(instances, [{ name: 'Example', radarr: {}, has_storage_agent: true }]);
  assert.ok(!JSON.stringify(instances).includes(token));
});

test('API strips unexpected fields from agent responses', () => {
  const data = structuredClone(result);
  data.token = token;
  data.locations[0].source = 'secret';
  assert.deepEqual(publicStorage(data), result);
});

test('API proxies the configured agent and safely reports failures', async t => {
  const agent = createStorageServer({ token, locations: [], collect: async () => result });
  const agentUrl = await listen(agent, t);
  const instances = [{ name: 'Example', storage_agent: { base_url: agentUrl, token } }, { name: 'Unconfigured' }];
  const app = express();
  app.use(createStorageRouter(async () => instances));
  const url = await listen(createServer(app), t);
  assert.deepEqual(await (await fetch(url + '/storage/Example')).json(), result);
  assert.equal((await fetch(url + '/storage/Missing')).status, 404);
  assert.equal((await fetch(url + '/storage/Unconfigured')).status, 404);
  instances[0].storage_agent.token = 'invalid';
  const response = await fetch(url + '/storage/Example');
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: 'Storage agent unavailable', code: 'AGENT_AUTH_FAILED' });
});
