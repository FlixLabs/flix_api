import { Router } from 'express';
import { configuredClients, connectors, downloadProtection } from './index.js';

export function createDownloadClientsRouter(loadInstances, fetchRemote = fetch) {
  const router = Router();
  const locks = new Set();
  router.use('/download-clients/:instance', async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    try {
      const instances = await loadInstances();
      const instance = instances?.find(item => item.name === req.params.instance);
      if (!instance) return res.status(404).json({ error: 'Instance not found.' });
      res.locals.instances = instances;
      res.locals.clients = configuredClients(instance);
      next();
    } catch { res.status(503).json({ error: 'Download clients configuration unavailable.' }); }
  });
  router.get('/download-clients/:instance', async (req, res) => {
    try {
      const protection = await downloadProtection(res.locals.instances, fetchRemote);
      const { tracked } = protection;
      const clients = await Promise.all(res.locals.clients.map(async config => {
        const adapter = await connectors[config.type].connect(config, fetchRemote);
        const torrents = (await adapter.list()).map(item => ({ ...item, tracked: tracked.has(item.id),
          removalBlockedReason: protection.reason(item.id),
          removable: item.completed && !tracked.has(item.id) && !protection.reason(item.id) }));
        return { id: config.id, name: config.name, type: config.type, allowDeleteData: config.allow_delete_data === true, allowForceRemoval: true, torrents };
      }));
      res.json({ clients });
    } catch { res.status(502).json({ error: 'Unable to inspect clients or verify Radarr/Sonarr queues. No cleanup is allowed.' }); }
  });
  router.delete('/download-clients/:instance/:client/:torrent', async (req, res) => {
    const config = res.locals.clients.find(item => item.id === req.params.client);
    const { deleteData, name, force = false } = req.body ?? {};
    if (typeof force !== 'boolean' || !config || typeof deleteData !== 'boolean' || typeof name !== 'string' || !connectors[config.type].validId(req.params.torrent)) return res.status(400).json({ error: 'Invalid removal request.' });
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
      const protection = await downloadProtection(res.locals.instances, fetchRemote);
      if (protection.reason(item.id)) return res.status(409).json({ error: `${protection.reason(item.id)}. Removal is blocked, including forced removal.` });
      const { tracked } = protection;
      if (tracked.has(item.id) && !force) return res.status(409).json({ error: 'Radarr or Sonarr still tracks this torrent. Use its download actions instead.' });
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
