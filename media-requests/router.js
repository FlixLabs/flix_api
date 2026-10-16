import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { requestStore, publicRequest, positiveId, problem } from './store.js';
import { mediaType, createCatalog } from './catalog.js';
import { createMediaServices } from './services.js';

const requestLanguage = req => req.query.language === 'original' ? 'original' : typeof req.query.language === 'string' && /^(en|fr)(-[A-Z]{2})?$/.test(req.query.language) ? req.query.language : 'en';
const missingRequest = () => problem(404, 'Request not found.');

export function createMediaRequests(redis, { accounts, authentication, readInstances, env = process.env, fetcher = fetch, now = Date.now }) {
  const router = Router();
  const store = requestStore(redis);
  const catalog = createCatalog({ env, fetcher });
  const services = createMediaServices({ readInstances, fetcher });
  router.use(async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    try {
      const user = await accounts.principal(req);
      if (user) { req.requestActor = user; return next(); }
      return authentication.requireAdministrator(req, res, () => { req.requestActor = { id: 'administrator', name: 'Administrator', role: 'admin' }; next(); });
    } catch { res.status(503).json({ error: 'Requests unavailable.' }); }
  });
  const admin = (req, res, next) => req.requestActor.role === 'admin' ? next() : res.status(403).json({ error: 'Administrator access required.' });
  async function limit(req, group, max, seconds) {
    const key = `flix:request-limit:${group}:${req.requestActor.id}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, seconds);
    if (count > max) throw problem(429, 'Too many requests. Please try again later.');
  }
  router.get('/catalog/search', async (req, res) => {
    await limit(req, 'catalog', 120, 60);
    res.json(await catalog.search(req.query.type, req.query.query, Number(req.query.page ?? 1), requestLanguage(req)));
  });
  router.get('/catalog/:type/:id', async (req, res) => {
    await limit(req, 'catalog', 120, 60);
    const item = await catalog.details(req.params.type, Number(req.params.id), requestLanguage(req));
    const { requests } = await store.read();
    const related = requests.filter(request => request.type === item.type && request.tmdbId === item.tmdbId);
    // Other users' identities and service targets never leave the admin API.
    const availability = await services.availability(item).catch(() => 'unknown');
    res.json({ ...item, availability, requests: related.map(request => ({ id: request.id, seasons: request.seasons, status: request.status, following: request.subscribers.some(user => user.id === req.requestActor.id) })) });
  });
  router.get('/options', admin, async (req, res) => {
    const type = mediaType(req.query.type ?? 'movies');
    if (req.query.instance !== undefined && typeof req.query.instance !== 'string') throw problem(400, 'Choose a configured instance.');
    res.json(await services.options(req.query.instance, type));
  });
  router.get('/', async (req, res) => {
    const { requests } = await store.read();
    const admin = req.requestActor.role === 'admin';
    const page = Number(req.query.page ?? 1);
    if (!Number.isInteger(page) || page < 1 || page > 1000) throw problem(400, 'Invalid request page.');
    const filtered = requests.filter(request => admin || request.subscribers.some(user => user.id === req.requestActor.id))
      .sort((a, b) => b.createdAt - a.createdAt);
    res.json({ items: filtered.slice((page - 1) * 20, page * 20).map(item => publicRequest(item, admin)), total: filtered.length, page });
  });
  router.post('/', async (req, res) => {
    await limit(req, 'create', 30, 3600);
    const { type, tmdbId, seasons } = req.body ?? {};
    mediaType(type);
    if (!positiveId(tmdbId)) throw problem(400, 'Invalid media identifier.');
    const item = await catalog.details(type, tmdbId, requestLanguage(req));
    if (type === 'movies' && await services.availability(item).catch(() => 'unknown') === 'available') throw problem(409, 'This movie is already available.');
    let selected = null;
    if (type === 'series') {
      if (!positiveId(item.tvdbId)) throw problem(409, 'This series has no TVDB identifier yet.');
      if (seasons !== null) {
        if (!Array.isArray(seasons) || !seasons.length || seasons.length > 100 || seasons.some(number => !Number.isSafeInteger(number) || number <= 0 || !item.seasons.some(season => season.number === number))) throw problem(400, 'Choose at least one valid season or the entire series.');
        selected = [...new Set(seasons)].sort((a, b) => a - b);
      }
    } else if (seasons !== undefined && seasons !== null) throw problem(400, 'Movies cannot have requested seasons.');
    const identity = `${type}:${tmdbId}:${selected?.join(',') ?? 'all'}`;
    const request = await store.change(requests => {
      let request = requests.find(request => request.identity === identity);
      if (!request) {
        if (requests.length >= 5000) throw problem(409, 'Request limit reached.');
        request = { id: randomUUID(), identity, type, tmdbId, tvdbId: item.tvdbId, title: item.title, year: item.year, poster: item.poster, seasons: selected,
          status: 'pending', reason: '', subscribers: [], createdAt: now(), updatedAt: now() };
        requests.push(request);
      }
      if (!request.subscribers.some(user => user.id === req.requestActor.id)) request.subscribers.push({ id: req.requestActor.id, name: req.requestActor.name });
      return request;
    });
    res.status(201).json(publicRequest(request, req.requestActor.role === 'admin'));
  });
  router.post('/:id/reject', admin, async (req, res) => {
    const reason = req.body?.reason ?? '';
    if (typeof reason !== 'string' || reason.length > 1000) throw problem(400, 'The refusal reason must not exceed 1000 characters.');
    const request = await store.change(requests => {
      const request = requests.find(item => item.id === req.params.id);
      if (!request) throw missingRequest();
      if (request.status !== 'pending') throw problem(409, 'This request can no longer be changed.');
      Object.assign(request, { status: 'rejected', reason: reason.trim(), updatedAt: now() });
      return request;
    });
    res.json(publicRequest(request, true));
  });
  router.post('/:id/approve', admin, async (req, res) => {
    const { instance, profileId, rootFolder } = req.body ?? {};
    if (typeof instance !== 'string' || instance.length > 200 || !positiveId(profileId) || typeof rootFolder !== 'string' || rootFolder.length > 2000) throw problem(400, 'Choose an instance, quality profile and root folder.');
    const operation = randomUUID();
    const target = { instance, profileId, rootFolder };
    const request = await store.change(requests => {
      const request = requests.find(item => item.id === req.params.id);
      if (!request) throw missingRequest();
      if (request.status !== 'pending') throw problem(409, 'This request can no longer be changed.');
      Object.assign(request, { status: 'processing', operation, target, updatedAt: now(), actionError: '' });
      return request;
    });
    let result;
    const lockKey = `flix:request-approval:${request.type}:${request.tmdbId}`;
    let locked = false;
    try {
      locked = !!await redis.set(lockKey, operation, { NX: true, EX: 180 });
      if (!locked) throw problem(409, 'Another request for this media is being processed. Try again shortly.');
      result = await services.approve(request, target, async () => {
        // Different season scopes must not overwrite each other's native monitoring changes.
        const owned = await redis.eval("if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end redis.call('EXPIRE', KEYS[1], 180) return 1", { keys: [lockKey], arguments: [operation] });
        if (owned !== 1) throw problem(409, 'Approval lock expired. Check service before trying again.');
      });
    }
    catch (error) {
      await store.change(requests => {
        const current = requests.find(item => item.id === request.id && item.operation === operation);
        if (current) Object.assign(current, { status: error.uncertain ? 'needs-review' : 'pending', updatedAt: now(), actionError: error.status ? error.message : 'Media service request failed.' });
      });
      throw error;
    } finally {
      if (locked) await redis.eval("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0", { keys: [lockKey], arguments: [operation] }).catch(() => {});
    }
    const saved = await store.change(requests => {
      const current = requests.find(item => item.id === request.id && item.operation === operation);
      if (!current) throw problem(409, 'Requests changed. Please try again.');
      Object.assign(current, { status: result.available ? 'available' : 'approved', availabilityKnown: true, checkedAt: now(), updatedAt: now() });
      return current;
    });
    res.json(publicRequest(saved, true));
  });
  async function reconcile(id, explicit = false) {
    const { requests } = await store.read();
    const request = requests.find(item => item.id === id);
    if (!request?.target) throw missingRequest();
    if (!['approved', 'available', 'needs-review'].includes(request.status)) throw problem(409, 'This request can no longer be changed.');
    const state = await services.observe(request);
    return store.change(requests => {
      const current = requests.find(item => item.id === id);
      if (!current || current.operation !== request.operation || current.updatedAt !== request.updatedAt) throw problem(409, 'Requests changed. Please try again.');
      let status = current.status;
      if (!state.exists) status = explicit ? 'pending' : 'needs-review';
      else if (state.available) status = 'available';
      else if (state.monitored) status = 'approved';
      else if (status === 'available') status = 'approved';
      const actionError = !state.exists && status === 'needs-review' ? 'Media is no longer present in the service.' : status === 'needs-review' ? current.actionError : '';
      Object.assign(current, { status, actionError, availabilityKnown: true, checkedAt: now(), ...(status !== current.status ? { updatedAt: now() } : {}) });
      return current;
    });
  }
  router.post('/:id/check', admin, async (req, res) => res.json(publicRequest(await reconcile(req.params.id, true), true)));
  router.use((error, _req, res, _next) => res.status(error.status ?? 503).json({ error: error.status ? error.message : 'Requests unavailable.' }));

  async function refresh() {
    const lease = randomUUID();
    if (!await redis.set('flix:request-refresh:lock', lease, { NX: true, EX: 240 })) return;
    try {
      await store.change(requests => {
        for (const request of requests) if (request.status === 'processing' && request.updatedAt < now() - 180000) Object.assign(request, { status: 'needs-review', actionError: 'Approval interrupted. Check the service before trying again.', updatedAt: now() });
      });
      const { requests } = await store.read();
      const due = requests.filter(item => ['approved', 'available'].includes(item.status) && (item.checkedAt ?? 0) < now() - 60000).sort((a, b) => (a.checkedAt ?? 0) - (b.checkedAt ?? 0)).slice(0, 5);
      for (const request of due) {
        try { await reconcile(request.id); }
        catch {
          await store.change(requests => {
            const current = requests.find(item => item.id === request.id);
            if (current && current.operation === request.operation) Object.assign(current, { availabilityKnown: false, checkedAt: now() });
          });
        }
      }
    } finally {
      await redis.eval("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0", { keys: ['flix:request-refresh:lock'], arguments: [lease] });
    }
  }
  return { router, refresh };
}
