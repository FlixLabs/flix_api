import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { collectStorage } from './storage.js';
import { inspectMediaFile } from './media-format.js';

export function createStorageServer({ token, locations, collect = collectStorage, inspect = inspectMediaFile }) {
  if (!token || token.length < 32) throw new Error('STORAGE_AGENT_TOKEN must contain at least 32 characters');
  const expected = Buffer.from(`Bearer ${token}`);
  let pending;
  let cached;
  let cachedAt = 0;
  let inspecting = false;

  return createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Cache-Control', 'no-store');
    const send = (status, data) => { response.writeHead(status); response.end(JSON.stringify(data)); };
    const provided = Buffer.from(request.headers.authorization || '');
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      return send(401, { error: 'Unauthorized' });
    }
    if (request.method !== 'GET') return send(405, { error: 'Method not allowed' });
    let url;
    try { url = new URL(request.url, 'http://agent.local'); }
    catch { return send(400, { error: 'Invalid request' }); }
    if (url.pathname === '/media-format') {
      if (inspecting) return send(429, { error: 'Inspection already in progress' });
      inspecting = true;
      try { return send(200, await inspect(locations, url.searchParams.get('path'))); }
      catch { return send(422, { error: 'Unable to inspect this file safely or propose an extension.' }); }
      finally { inspecting = false; }
    }
    if (request.url !== '/storage') return send(404, { error: 'Not found' });
    try {
      if (!cached || Date.now() - cachedAt >= 5000) {
        pending ??= collect(locations).then(result => {
          cached = result;
          cachedAt = Date.now();
        }).finally(() => { pending = null; });
        await pending;
      }
      send(200, cached);
    } catch {
      send(503, { error: 'Storage unavailable' });
    }
  });
}
