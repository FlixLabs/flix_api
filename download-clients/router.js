import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { configuredClients, connectors, trackedDownloads } from './index.js';

function authorized(header, token) {
  if (typeof token !== 'string' || token.length < 32 || typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const value = Buffer.from(header.slice(7)); const expected = Buffer.from(token);
  return value.length === expected.length && timingSafeEqual(value, expected);
}

export function createDownloadClientsRouter(loadInstances, fetchRemote = fetch) {
  const router = Router();
  const locks = new Set();
  router.use('/download-clients/:instance', async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    try {
      const instances = await loadInstances();
      const instance = instances?.find(item => item.name === req.params.instance);
      if (!instance || !authorized(req.get('Authorization'), instance.download_clients_token)) return res.status(401).json({ error: 'A valid download clients access token is required.' });
      res.locals.instances = instances;
      res.locals.clients = configuredClients(instance);
      next();
    } catch { res.status(503).json({ error: 'Download clients configuration unavailable.' }); }
  });
  router.get('/download-clients/:instance', async (req, res) => {
    try {
      const tracked = await trackedDownloads(res.locals.instances, fetchRemote);
      const clients = await Promise.all(res.locals.clients.map(async config => {
        const adapter = await connectors[config.type].connect(config, fetchRemote);
        const torrents = (await adapter.list()).map(item => ({ ...item, tracked: tracked.has(item.id),
          removable: item.completed && !tracked.has(item.id) }));
        return { id: config.id, name: config.name, type: config.type, allowDeleteData: config.allow_delete_data === true, torrents };
      }));
      res.json({ clients });
    } catch { res.status(502).json({ error: 'Unable to inspect clients or verify Radarr/Sonarr queues. No cleanup is allowed.' }); }
  });
  router.delete('/download-clients/:instance/:client/:torrent', async (req, res) => {
    const config = res.locals.clients.find(item => item.id === req.params.client);
    const { deleteData, name } = req.body ?? {};
    if (!config || typeof deleteData !== 'boolean' || typeof name !== 'string' || !connectors[config.type].validId(req.params.torrent)) return res.status(400).json({ error: 'Invalid removal request.' });
    if (deleteData && config.allow_delete_data !== true) return res.status(403).json({ error: 'Deleting torrent data is not enabled by the server.' });
    // One removal at a time per daemon, including configurations shared across instances.
    const lock = `${config.type}:${config.base_url}`;
    if (locks.has(lock)) return res.status(409).json({ error: 'A removal is already in progress.' });
    locks.add(lock);
    let attempted = false;
    try {
      const adapter = await connectors[config.type].connect(config, fetchRemote);
      const item = (await adapter.list()).find(item => item.id === req.params.torrent);
      if (!item || item.name !== name || !item.completed) return res.status(409).json({ error: 'Torrent changed, disappeared or is not complete. Refresh the list.' });
      const tracked = await trackedDownloads(res.locals.instances, fetchRemote);
      if (tracked.has(item.id)) return res.status(409).json({ error: 'Radarr or Sonarr still tracks this torrent. Use its download actions instead.' });
      attempted = true;
      await adapter.remove(item.id, deleteData);
      res.sendStatus(204);
    } catch { res.status(502).json({ error: attempted
      ? 'Removal outcome is uncertain. Refresh the client before trying again; the request was not retried.'
      : 'Unable to revalidate this torrent and download tracking. No removal was requested.' }); }
    finally { locks.delete(lock); }
  });
  return router;
}
