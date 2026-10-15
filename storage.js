import { Router } from 'express';
import { storageFailure } from './storage-agent/diagnostics.js';

export function publicInstances(instances) {
  return (instances || []).map(({ storage_agent, download_clients, download_clients_token, ...instance }) => ({
    ...instance,
    ...(Array.isArray(download_clients) && download_clients.length ? { has_download_clients: true } : {}),
    has_storage_agent: Boolean(storage_agent?.base_url && storage_agent?.token),
  }));
}

export function publicStorage(data) {
  if (!Array.isArray(data.locations) || typeof data.collectedAt !== 'string') throw new Error('Invalid response');
  if (new Set(data.locations.map(location => location?.id)).size !== data.locations.length) throw new Error('Duplicate locations');
  const locations = data.locations.map(location => {
    const { id, path, available } = location;
    if (!['movies', 'series', 'downloads'].includes(id) || typeof path !== 'string' || typeof available !== 'boolean') {
      throw new Error('Invalid location');
    }
    if (!available) return { id, path, available, ...storageFailure({ code: location.code }) };
    const metrics = ['totalBytes', 'usedBytes', 'availableBytes', 'reservedBytes', 'usagePercent'];
    if (typeof location.volumeId !== 'string' || metrics.some(key => !Number.isFinite(location[key]) || location[key] < 0)
      || location.totalBytes <= 0 || location.availableBytes > location.totalBytes || location.usedBytes > location.totalBytes || location.usagePercent > 100) {
      return { id, path, available: false, ...storageFailure({ code: 'INVALID_METRICS' }) };
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
    let failureCode = 'INSTANCE_DATA_UNAVAILABLE';
    try {
      const instances = await loadInstances();
      const instance = (instances || []).find(item => item.name === request.params.instance);
      if (!instance) return response.status(404).json({ error: 'Instance not found', code: 'INSTANCE_NOT_FOUND' });
      const agent = instance.storage_agent;
      if (!agent?.base_url || !agent?.token) return response.status(404).json({ error: 'Storage agent not configured', code: 'AGENT_NOT_CONFIGURED' });
      failureCode = 'AGENT_CONFIG_INVALID';
      const url = new URL(agent.base_url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid agent URL');
      url.pathname = url.pathname.replace(/\/$/, '') + '/storage';
      url.search = '';
      url.hash = '';
      failureCode = 'AGENT_UNREACHABLE';
      const result = await fetchAgent(url, {
        headers: { Authorization: `Bearer ${agent.token}` },
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
      });
      if (!result.ok) {
        failureCode = [401, 403].includes(result.status) ? 'AGENT_AUTH_FAILED'
          : result.status === 404 ? 'AGENT_ENDPOINT_NOT_FOUND'
            : result.status === 503 ? 'AGENT_MEASUREMENT_FAILED' : 'AGENT_UNREACHABLE';
        throw new Error('Agent unavailable');
      }
      failureCode = 'AGENT_RESPONSE_INVALID';
      const data = await result.json();
      response.json(publicStorage(data));
    } catch (error) {
      if (failureCode === 'AGENT_UNREACHABLE' && ['TimeoutError', 'AbortError'].includes(error?.name)) failureCode = 'AGENT_TIMEOUT';
      response.status(failureCode === 'INSTANCE_DATA_UNAVAILABLE' ? 503 : 502).json({ error: 'Storage agent unavailable', code: failureCode });
    }
  });
  return router;
}
