import { Router } from 'express';

export function publicInstances(instances) {
  return (instances || []).map(({ storage_agent, ...instance }) => ({
    ...instance,
    has_storage_agent: Boolean(storage_agent?.base_url && storage_agent?.token),
  }));
}

export function publicStorage(data) {
  if (!Array.isArray(data.locations) || typeof data.collectedAt !== 'string') throw new Error('Invalid response');
  const locations = data.locations.map(location => {
    const { id, path, available } = location;
    if (!['movies', 'series', 'downloads'].includes(id) || typeof path !== 'string' || typeof available !== 'boolean') {
      throw new Error('Invalid location');
    }
    if (!available) return { id, path, available, error: 'Storage unavailable' };
    const metrics = ['totalBytes', 'usedBytes', 'availableBytes', 'reservedBytes', 'usagePercent'];
    if (typeof location.volumeId !== 'string' || metrics.some(key => !Number.isFinite(location[key]) || location[key] < 0)) {
      throw new Error('Invalid metrics');
    }
    return { id, path, available, volumeId: location.volumeId,
      ...Object.fromEntries(metrics.map(key => [key, location[key]])) };
  });
  return { collectedAt: data.collectedAt, locations };
}

export function createStorageRouter(loadInstances, fetchAgent = fetch) {
  const router = Router();
  router.get('/storage/:instance', async (request, response) => {
    response.set('Cache-Control', 'no-store');
    try {
      const instances = await loadInstances();
      const instance = (instances || []).find(item => item.name === request.params.instance);
      if (!instance) return response.status(404).json({ error: 'Instance not found' });
      const agent = instance.storage_agent;
      if (!agent?.base_url || !agent?.token) return response.status(404).json({ error: 'Storage agent not configured' });
      const url = new URL(agent.base_url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid agent URL');
      url.pathname = url.pathname.replace(/\/$/, '') + '/storage';
      url.search = '';
      url.hash = '';
      const result = await fetchAgent(url, {
        headers: { Authorization: `Bearer ${agent.token}` },
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
      });
      if (!result.ok) throw new Error('Agent unavailable');
      const data = await result.json();
      response.json(publicStorage(data));
    } catch {
      response.status(502).json({ error: 'Storage agent unavailable' });
    }
  });
  return router;
}
