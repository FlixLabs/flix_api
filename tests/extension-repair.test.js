import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createExtensionRepair } from '../download-clients/extension-repair.js';
import { createDownloadClientsRouter } from '../download-clients/router.js';
import { publicInstances } from '../storage.js';
import { createStorageServer } from '../storage-agent/server.js';
import { rejectedExtension } from '../download-clients/extension-rejection.js';
import { createServer } from 'node:http';
import express from 'express';

const hash = 'a'.repeat(40);
const filename = 'Movie.2026-Groupe';
const rejection = { id: 1, downloadId: hash.toUpperCase(), status: 'completed', trackedDownloadState: 'importPending',
  trackedDownloadStatus: 'warning', statusMessages: [{ title: filename, messages: ["Invalid video file, unsupported extension: '.2026-Groupe'"] }] };
const client = { id: 'deluge', type: 'deluge', name: 'Deluge', base_url: 'http://deluge.test', password: 'secret', downloads_root: '/remote/downloads' };
const instance = { name: 'Test', radarr: { base_url: 'http://radarr.test', api_key: 'secret' },
  sonarr: { base_url: 'http://sonarr.test', api_key: 'secret' }, download_clients: [client],
  storage_agent: { base_url: 'http://agent.test', token: 's'.repeat(64) } };
function setup() {
  const calls = [];
  const settings = { queue: rejection, commands: [], path: filename, savePath: '/remote/downloads',
    progress: 100, identity: 'f'.repeat(64), size: 1024, inspectionSize: 1024, renamed: false, uncertain: false, retained: false, count: 1 };
  const fetchRemote = async (value, init = {}) => {
    const url = new URL(value);
    if (url.pathname.endsWith('/queue')) {
      const record = url.hostname === 'radarr.test' ? settings.queue : settings.sonarrQueue;
      return Response.json({ totalRecords: record ? 1 : 0, records: record ? [record] : [] });
    }
    if (url.pathname.endsWith('/command')) return Response.json(settings.commands);
    if (url.hostname === 'agent.test') {
      if (settings.oldAgent) return Response.json({}, { status: 404 });
      calls.push({ inspection: url.searchParams.get('path') });
      assert.equal(init.headers.Authorization, `Bearer ${instance.storage_agent.token}`);
      assert.equal(init.redirect, 'error');
      return Response.json({ format: 'matroska', extension: '.mkv', identity: settings.identity, sizeBytes: settings.inspectionSize });
    }
    const rpc = JSON.parse(init.body); calls.push(rpc);
    let result;
    if (rpc.method === 'auth.login') result = true;
    else if (rpc.method === 'web.connected') result = true;
    else if (rpc.method === 'core.get_torrents_status') result = { [hash]: { name: settings.customName ?? settings.path.split('/')[0], state: 'Queued', progress: settings.progress,
      is_finished: true, total_size: settings.size, save_path: settings.savePath, ratio: 1 } };
    else if (rpc.method === 'core.get_torrent_status') result = { save_path: settings.savePath, name: settings.customName ?? settings.path.split('/')[0],
      files: Array.from({ length: settings.count }, (_, index) => ({ index, path: settings.path, size: settings.size })) };
    else if (rpc.method === 'core.rename_files') {
      if (settings.uncertain) throw new Error('lost response with secret');
      if (!settings.retained) settings.path = rpc.params[1][0][1];
      settings.renamed = true;
      result = null;
    } else throw new Error('Unexpected RPC ' + rpc.method);
    return Response.json({ id: rpc.id, result, error: null }, { headers: { 'Set-Cookie': '_session_id=test; Path=/' } });
  };
  let clock = 1000;
  const actions = createExtensionRepair({ fetchRemote, locks: new Set(), now: () => clock });
  const review = (i = instance, clients = i.download_clients) => actions.review(i, clients, [i], { downloadId: hash, mediaType: 'movies' });
  const repair = proposal => actions.repair(instance, [client], [instance], { reviewId: proposal.reviewId });
  const writes = () => calls.filter(call => call.method === 'core.rename_files');
  return { actions, settings, calls, writes, review, repair, fetchRemote, expire: () => { clock += 300001; } };
}
test('recognizes only explicit unsupported-extension rejections, not filenames or active imports', () => {
  assert.equal(rejectedExtension(rejection), '.2026-Groupe');
  for (const changes of [{ status: 'downloading' }, { trackedDownloadState: 'importing' }, { trackedDownloadStatus: 'ok' },
    { errorMessage: 'active' }, { statusMessages: [{ title: rejection.statusMessages[0].messages[0], messages: [] }] },
    { statusMessages: [{ messages: [rejection.statusMessages[0].messages[0], 'Waiting for import'] }] }]) {
    assert.equal(rejectedExtension({ ...rejection, ...changes }), null);
  }
});
test('review reads only, confirmation renames once via Deluge and never imports or deletes', async () => {
  const { review, repair, calls, writes } = setup();
  const proposal = await review();
  assert.equal(proposal.originalName, filename);
  assert.equal(proposal.proposedName, filename + '.mkv');
  assert.equal(writes().length, 0);
  assert.deepEqual(await repair(proposal), { status: 'renamed' });
  assert.deepEqual(writes().map(call => call.params), [[hash, [[0, filename + '.mkv']]]]);
  await assert.rejects(repair(proposal), { code: 'REVIEW_EXPIRED' });
  assert.equal(writes().length, 1);
  assert.ok(calls.every(call => !['core.remove_torrent'].includes(call.method)));
});
test('capability is opt-in and never publishes mappings or secrets', () => {
  const publicData = publicInstances([instance])[0];
  assert.equal(publicData.has_download_extension_repair, true);
  assert.equal(publicData.storage_agent, undefined);
  assert.equal(publicData.download_clients, undefined);
  assert.equal(publicInstances([{ ...instance, download_clients: [{ ...client, downloads_root: undefined }] }])[0].has_download_extension_repair, undefined);
});
const skippedSonarr = { ...rejection, trackedDownloadState: 'downloading', statusMessages: [{
  title: filename, messages: ["Download wasn't grabbed by Sonarr and not in a category, Skipping."],
}] };
test('an explicitly skipped unknown Sonarr download does not block a verified Radarr extension repair', async () => {
  const mock = setup();
  mock.settings.sonarrQueue = skippedSonarr;
  const proposal = await mock.review();
  assert.equal(mock.writes().length, 0);
  assert.deepEqual(await mock.repair(proposal), { status: 'renamed' });
  assert.equal(mock.writes().length, 1);
});
test('other tracked resources, ambiguous states and active imports still block a shared download repair', async () => {
  for (const changes of [{ seriesId: 2 }, { movieId: 1 }, { episodeId: 3 }, { series: {} },
    { status: 'downloading' }, { trackedDownloadState: 'importPending' }, { trackedDownloadState: 'importing' },
    { trackedDownloadState: 'unknown' }, { trackedDownloadStatus: 'ok' }, { errorMessage: 'Import unavailable' },
    { statusMessages: [] }, { statusMessages: [{ messages: ["Download wasn't grabbed by Sonarr and not in a category, Skipping.", 'Waiting for import'] }] }]) {
    const mock = setup();
    mock.settings.sonarrQueue = { ...skippedSonarr, ...changes };
    await assert.rejects(mock.review(), { code: 'IMPORT_PROTECTED' });
    assert.equal(mock.writes().length, 0);
  }
  for (const command of [{ name: 'DownloadedEpisodesScan', status: 'queued', body: { downloadClientId: hash } },
    { name: 'ManualImport', status: 'started', body: {} }]) {
    const mock = setup();
    mock.settings.sonarrQueue = skippedSonarr;
    const proposal = await mock.review();
    mock.settings.commands = [command];
    await assert.rejects(mock.repair(proposal), { code: 'IMPORT_PROTECTED' });
    assert.equal(mock.writes().length, 0);
  }
});
test('also supports a filename with no suffix at all, without interpreting it as pending', async () => {
  const { settings, review, repair, writes } = setup();
  settings.path = 'Movie';
  settings.queue = { ...rejection, statusMessages: [{ title: 'Movie', messages: ["Invalid video file, unsupported extension: ''"] }] };
  assert.equal(rejectedExtension(settings.queue), '');
  const proposal = await review();
  assert.equal(proposal.proposedName, 'Movie.mkv');
  assert.deepEqual(await repair(proposal), { status: 'renamed' });
  assert.equal(writes().length, 1);
});
test('refuses missing mappings, outside paths, multiple files, wrong sizes and already repaired names', async () => {
  const { review, settings, writes } = setup();
  await assert.rejects(review({ ...instance, download_clients: [{ ...client, downloads_root: undefined }] }), { code: 'REPAIR_NOT_CONFIGURED' });
  settings.savePath = '/remote/downloads-other';
  await assert.rejects(review(), { code: 'PATH_OUTSIDE_DOWNLOADS' });
  settings.savePath = '/remote/downloads'; settings.count = 2;
  await assert.rejects(review(), { code: 'SINGLE_FILE_REQUIRED' });
  settings.count = 1; settings.path = '../Movie.2026-Groupe';
  await assert.rejects(review(), { code: 'FILE_IDENTITY_CHANGED' });
  settings.path = filename; settings.inspectionSize = 2;
  await assert.rejects(review(), { code: 'FILE_FORMAT_UNSUPPORTED' });
  settings.inspectionSize = 1024; settings.path = filename + '.mkv';
  await assert.rejects(review(), { code: 'FILE_IDENTITY_CHANGED' });
  settings.path = filename; settings.customName = 'Custom torrent name';
  await assert.rejects(review(), { code: 'FILE_IDENTITY_CHANGED' });
  assert.equal(writes().length, 0);
});
test('rechecks identity, rejection, completion, expiration and commands before writing', async () => {
  for (const change of [s => { s.identity = 'e'.repeat(64); }, s => { s.queue = null; },
    s => { s.path = 'Other.2026-Groupe'; }, s => { s.progress = 99; },
    s => { s.queue = { ...rejection, trackedDownloadState: 'importing' }; },
    s => { s.commands = [{ name: 'ManualImport', status: 'started', body: { files: [{ downloadId: hash }] } }]; },
    s => { s.commands = [{ name: 'DownloadedMoviesScan', status: 'queued', body: {} }]; }]) {
    const { settings, review, repair, writes } = setup();
    const proposal = await review(); change(settings);
    await assert.rejects(repair(proposal));
    assert.equal(writes().length, 0);
  }
  const expired = setup(); const proposal = await expired.review(); expired.expire();
  await assert.rejects(expired.repair(proposal), { code: 'REVIEW_EXPIRED' });
});
test('uncertain RPC results never retry the write or reuse the confirmation', async () => {
  const { settings, review, repair, writes } = setup();
  const proposal = await review(); settings.uncertain = true;
  await assert.rejects(repair(proposal), { code: 'RENAME_UNCERTAIN' });
  await assert.rejects(repair(proposal), { code: 'REVIEW_EXPIRED' });
  assert.equal(writes().length, 1);
});
test('old agents, changed configurations and concurrent client mutations fail closed', async () => {
  const old = setup(); old.settings.oldAgent = true;
  await assert.rejects(old.review(), { code: 'FILE_INSPECTION_UNAVAILABLE' });
  assert.equal(old.writes().length, 0);
  const changed = setup(); const proposal = await changed.review();
  await assert.rejects(changed.actions.repair({ ...instance, radarr: { ...instance.radarr, api_key: 'changed' } },
    [client], [instance], { reviewId: proposal.reviewId }), { code: 'CONFIGURATION_CHANGED' });
  assert.equal(changed.writes().length, 0);
  const mock = setup(); const locks = new Set();
  const actions = createExtensionRepair({ fetchRemote: mock.fetchRemote, locks });
  const review = await actions.review(instance, [client], [instance], { downloadId: hash, mediaType: 'movies' });
  locks.add(`${client.type}:${client.base_url}`);
  await assert.rejects(actions.repair(instance, [client], [instance], { reviewId: review.reviewId }), { code: 'CLIENT_BUSY' });
  assert.equal(mock.writes().length, 0);
});
test('commands that start after file inspection block the final rename', async () => {
  const mock = setup();
  let inspections = 0;
  const fetchRemote = async (url, init) => {
    const response = await mock.fetchRemote(url, init);
    if (new URL(url).hostname === 'agent.test' && ++inspections === 2) {
      mock.settings.commands = [{ name: 'ManualImport', status: 'queued', body: { files: [{ downloadId: hash }] } }];
    }
    return response;
  };
  const actions = createExtensionRepair({ fetchRemote, locks: new Set() });
  const proposal = await actions.review(instance, [client], [instance], { downloadId: hash, mediaType: 'movies' });
  await assert.rejects(actions.repair(instance, [client], [instance], { reviewId: proposal.reviewId }), { code: 'IMPORT_PROTECTED' });
  assert.equal(mock.writes().length, 0);
});
async function listen(server, t) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}
test('agent inspection is authenticated and sanitized and leaves existing storage measurements intact', async t => {
  const url = await listen(createStorageServer({ token: 'x'.repeat(64), locations: [],
    collect: async () => ({ locations: [] }), inspect: async () => { throw new Error('private mount and secret'); } }), t);
  assert.equal((await fetch(url + '/media-format?path=file')).status, 401);
  const headers = { Authorization: `Bearer ${'x'.repeat(64)}` };
  assert.equal((await fetch(url + '//', { headers })).status, 400);
  const response = await fetch(url + '/media-format?path=../secret', { headers });
  assert.equal(response.status, 422);
  assert.ok(!(await response.text()).includes('private'));
  assert.equal((await fetch(url + '/storage', { headers })).status, 200);
});
test('API routes sanitize failures and consume confirmation tokens on repair', async t => {
  const mock = setup();
  const app = express(); app.use(express.json());
  app.use(createDownloadClientsRouter(async () => [instance], mock.fetchRemote));
  const url = await listen(createServer(app), t);
  const post = (action, body) => fetch(`${url}/download-clients/Test/extension-${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const response = await post('review', { downloadId: hash, mediaType: 'movies' });
  assert.equal(response.status, 200);
  const proposal = await response.json();
  mock.settings.uncertain = true;
  const failed = await post('repair', { reviewId: proposal.reviewId });
  assert.equal(failed.status, 502);
  const data = await failed.json();
  assert.equal(data.code, 'RENAME_UNCERTAIN');
  assert.ok(!JSON.stringify(data).includes('secret'));
  assert.equal((await post('repair', { reviewId: proposal.reviewId })).status, 409);
});
