import { randomBytes, createHash } from 'node:crypto';
import { posix } from 'node:path';
import { connectors, downloadProtection } from './index.js';
import { safeRelativePath } from '../storage-agent/media-format.js';

const error = (code, status = 409) => Object.assign(new Error(code), { code, status });
const configKey = (instance, client) => createHash('sha256').update(JSON.stringify([instance.storage_agent, instance.radarr, instance.sonarr, client])).digest('hex');
export function extensionRepairConfigured(instance) {
  return !!(instance.storage_agent?.base_url && instance.storage_agent?.token
    && Array.isArray(instance.download_clients) && instance.download_clients.some(client => client?.type === 'deluge'
      && typeof client.downloads_root === 'string' && posix.isAbsolute(client.downloads_root)));
}

export function createExtensionRepair({ fetchRemote, locks, now = Date.now }) {
  const reviews = new Map();
  const lockKey = client => `${client.type}:${client.base_url}`;
  function prune() {
    for (const [id, review] of reviews) if (review.expires <= now()) reviews.delete(id);
  }
  async function snapshot(instance, clients, instances, mediaType, downloadId, expectedClient) {
    if (!extensionRepairConfigured(instance)) throw error('REPAIR_NOT_CONFIGURED', 422);
    const protection = await downloadProtection(instances, fetchRemote);
    const extension = protection.rejectedExtension(instance.name, mediaType, downloadId);
    if (extension === undefined || protection.repairReason(downloadId)) throw error('IMPORT_PROTECTED');
    const matches = [];
    for (const client of clients) {
      const adapter = await connectors[client.type].connect(client, fetchRemote);
      const item = (await adapter.list()).find(item => item.id === downloadId);
      if (item) matches.push({ client, adapter, item });
    }
    if (matches.length !== 1) throw error('TORRENT_IDENTITY_CHANGED');
    const { client, adapter, item } = matches[0];
    if (!item.completed || (expectedClient && expectedClient !== client.id)) throw error('TORRENT_IDENTITY_CHANGED');
    const root = client.downloads_root;
    if (typeof root !== 'string' || !posix.isAbsolute(root) || root.includes('\\')) throw error('REPAIR_NOT_CONFIGURED', 422);
    if (locks.has(lockKey(client))) throw error('CLIENT_BUSY');
    const details = await adapter.files(downloadId);
    if (details.files.length !== 1 || !posix.isAbsolute(details.savePath) || details.savePath !== item.path) throw error('SINGLE_FILE_REQUIRED', 422);
    const file = details.files[0];
    if (!safeRelativePath(file.path) || file.index !== 0 || !Number.isSafeInteger(file.size) || file.size <= 0) throw error('FILE_IDENTITY_CHANGED');
    if (/\.(?:mkv|mp4|avi|webm|m4v|mov|ts|m2ts)$/i.test(file.path)) throw error('FILE_EXTENSION_ALREADY_VALID');
    if (posix.extname(file.path) !== extension) throw error('FILE_IDENTITY_CHANGED');
    // Radarr derives the output path from Deluge's torrent name. A custom name
    // could otherwise keep pointing at the old path after a successful rename.
    if (details.name !== item.name || item.name !== file.path.split('/')[0]) throw error('FILE_IDENTITY_CHANGED');
    const relative = posix.relative(root, posix.join(details.savePath, file.path));
    if (!safeRelativePath(relative)) throw error('PATH_OUTSIDE_DOWNLOADS', 422);
    return { client, adapter, file, relative, name: item.name, savePath: details.savePath };
  }
  async function inspect(instance, relative, size) {
    const agent = instance.storage_agent;
    const url = new URL(agent.base_url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw error('REPAIR_NOT_CONFIGURED', 422);
    url.pathname = url.pathname.replace(/\/$/, '') + '/media-format';
    url.search = new URLSearchParams({ path: relative }).toString(); url.hash = '';
    const response = await fetchRemote(url, { headers: { Authorization: `Bearer ${agent.token}` },
      redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw error('FILE_INSPECTION_UNAVAILABLE', 422);
    const data = await response.json();
    if (data?.format !== 'matroska' || data.extension !== '.mkv' || data.sizeBytes !== size
      || !/^[a-f0-9]{64}$/.test(data.identity)) throw error('FILE_FORMAT_UNSUPPORTED', 422);
    return data;
  }
  async function review(instance, clients, instances, body) {
    prune();
    if (!['movies', 'series'].includes(body?.mediaType) || typeof body?.downloadId !== 'string'
      || !/^[a-f0-9]{40}$/i.test(body.downloadId)) throw error('INVALID_REPAIR_REQUEST', 400);
    if (reviews.size >= 200) throw error('TOO_MANY_REVIEWS', 429);
    const downloadId = body.downloadId.toLowerCase();
    const state = await snapshot(instance, clients, instances, body.mediaType, downloadId);
    const inspected = await inspect(instance, state.relative, state.file.size);
    const reviewId = randomBytes(32).toString('hex');
    reviews.set(reviewId, { instance: instance.name, client: state.client.id, config: configKey(instance, state.client),
      downloadId, mediaType: body.mediaType, file: state.file, relative: state.relative, name: state.name,
      savePath: state.savePath, identity: inspected.identity, expires: now() + 300000 });
    return { reviewId, originalName: state.file.path, proposedName: state.file.path + '.mkv', format: 'matroska' };
  }
  async function repair(instance, clients, instances, body) {
    prune();
    const proposal = reviews.get(body?.reviewId);
    if (!proposal || proposal.instance !== instance.name) throw error('REVIEW_EXPIRED');
    // A confirmation token is single-use, including failed or uncertain attempts.
    reviews.delete(body.reviewId);
    const client = clients.find(client => client.id === proposal.client);
    if (!client || configKey(instance, client) !== proposal.config) throw error('CONFIGURATION_CHANGED');
    const state = await snapshot(instance, clients, instances, proposal.mediaType, proposal.downloadId, proposal.client);
    const key = lockKey(client);
    if (locks.has(key)) throw error('CLIENT_BUSY');
    locks.add(key);
    let attempted = false;
    try {
      if (state.name !== proposal.name || state.savePath !== proposal.savePath || state.relative !== proposal.relative
        || JSON.stringify(state.file) !== JSON.stringify(proposal.file)) throw error('FILE_IDENTITY_CHANGED');
      const inspected = await inspect(instance, state.relative, state.file.size);
      if (inspected.identity !== proposal.identity) throw error('FILE_IDENTITY_CHANGED');
      // Recheck queued/running imports after inspection, immediately before the write.
      const protection = await downloadProtection(instances, fetchRemote);
      if (protection.repairReason(proposal.downloadId)
        || protection.rejectedExtension(instance.name, proposal.mediaType, proposal.downloadId) === undefined) throw error('IMPORT_PROTECTED');
      attempted = true;
      await state.adapter.renameFile(proposal.downloadId, state.file.index, state.file.path + '.mkv');
      for (let attempt = 0; attempt < 5; attempt++) {
        const current = await state.adapter.files(proposal.downloadId);
        if (current.savePath === state.savePath && current.files.length === 1
          && current.name === (state.file.path + '.mkv').split('/')[0]
          && current.files[0].index === state.file.index && current.files[0].size === state.file.size
          && current.files[0].path === state.file.path + '.mkv') return { status: 'renamed' };
        if (attempt < 4) await new Promise(resolve => setTimeout(resolve, 250));
      }
      throw error('RENAME_UNCERTAIN', 502);
    } catch (cause) {
      if (attempted) throw error('RENAME_UNCERTAIN', 502);
      throw cause;
    } finally { locks.delete(key); }
  }
  return { review, repair };
}
