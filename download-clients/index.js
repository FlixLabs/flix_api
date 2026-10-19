import { connectDeluge, validTorrentId } from './connectors/deluge.js';

// Additional clients implement the same list/remove contract, without changing the UI.
export const connectors = Object.freeze({ deluge: { connect: connectDeluge, validId: validTorrentId } });

export function configuredClients(instance) {
  const clients = instance.download_clients;
  if (!Array.isArray(clients) || !clients.length) throw new Error('No download clients configured');
  const ids = new Set();
  for (const client of clients) {
    if (!client || !/^[a-z0-9-]{1,64}$/.test(client.id) || ids.has(client.id)
      || typeof client.name !== 'string' || !client.name.trim() || !Object.hasOwn(connectors, client.type)) throw new Error('Invalid download client configuration');
    ids.add(client.id);
  }
  return clients;
}

export async function downloadProtection(instances, fetchService = fetch) {
  const tracked = new Set();
  const blocked = new Map();
  let unidentifiedImport = false;
  // Check every configured instance: multiple instances can share a download client.
  for (const instance of instances) for (const service of [instance.radarr, instance.sonarr]) {
    if (!service?.base_url || !service.api_key) throw new Error('Cannot verify download tracking');
    const url = new URL(service.base_url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid service URL');
    url.pathname = url.pathname.replace(/\/$/, '') + '/api/v3/queue';
    url.search = ''; url.hash = '';
    let expected = null;
    let count = 0;
    const recordIds = new Set();
    const signal = AbortSignal.timeout(15000);
    for (let page = 1; page <= 100; page++) {
      url.search = new URLSearchParams({ page: String(page), pageSize: '100', includeUnknownMovieItems: 'true', includeUnknownSeriesItems: 'true' }).toString();
      const response = await fetchService(url, { headers: { 'X-Api-Key': service.api_key }, redirect: 'error', signal });
      if (!response.ok) throw new Error('Cannot verify download tracking');
      const data = await response.json();
      if (!Array.isArray(data?.records) || !Number.isSafeInteger(data.totalRecords) || data.totalRecords < 0
        || data.records.length > 100 || (expected !== null && expected !== data.totalRecords)) throw new Error('Invalid queue response');
      expected = data.totalRecords;
      for (const record of data.records) {
        if (!Number.isSafeInteger(record?.id) || recordIds.has(record.id)
          || typeof record.downloadId !== 'string' || !record.downloadId.trim()) throw new Error('Unknown download identity');
        recordIds.add(record.id);
        const id = record.downloadId.trim().toLowerCase();
        tracked.add(id);
        const state = typeof record.trackedDownloadState === 'string' ? record.trackedDownloadState.toLowerCase() : '';
        if (state === 'importing') blocked.set(id, 'Import in progress');
        else if (state === 'importpending') blocked.set(id, 'Import queued');
        else if (!['downloading', 'importblocked', 'imported', 'failedpending', 'failed', 'ignored', 'importfailed'].includes(state)) {
          blocked.set(id, 'Import status unavailable');
        }
      }
      count += data.records.length;
      if (count === expected) break;
      if (!data.records.length || count > expected || page === 100) throw new Error('Incomplete queue response');
    }
    url.pathname = url.pathname.replace(/\/queue$/, '/command');
    url.search = '';
    const response = await fetchService(url, { headers: { 'X-Api-Key': service.api_key }, redirect: 'error', signal });
    if (!response.ok) throw new Error('Cannot verify import commands');
    const commands = await response.json();
    if (!Array.isArray(commands)) throw new Error('Invalid import commands');
    for (const command of commands) {
      if (!command || typeof command.name !== 'string' || typeof command.status !== 'string') throw new Error('Invalid command state');
      const name = command.name.toLowerCase();
      if (!['manualimport', 'downloadedmoviesscan', 'downloadedepisodesscan'].includes(name)) continue;
      const status = command.status.toLowerCase();
      if (['completed', 'failed', 'aborted', 'cancelled'].includes(status)) continue;
      if (!['queued', 'started'].includes(status)) { unidentifiedImport = true; continue; }
      const body = command.body;
      const ids = name === 'manualimport'
        ? (Array.isArray(body?.files) && body.files.length ? body.files.map(file => file?.downloadId) : [])
        : [body?.downloadClientId];
      if (!ids.length || ids.some(id => typeof id !== 'string' || !id.trim())) {
        // Paths cannot be safely compared across different container/remote path mappings.
        unidentifiedImport = true;
        continue;
      }
      for (const id of ids) blocked.set(id.trim().toLowerCase(), status === 'queued' ? 'Import queued' : 'Import in progress');
    }
  }
  return { tracked, reason: id => blocked.get(id.toLowerCase()) ?? (unidentifiedImport ? 'Import status unavailable' : null) };
}
