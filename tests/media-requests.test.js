import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { createMediaRequests } from '../media-requests/router.js';
import { requestStore } from '../media-requests/store.js';
import { catalogMedia } from '../media-requests/catalog.js';

async function setup(t) {
  const values = new Map();
  const redis = {
    get: async key => values.get(key) ?? null,
    set: async (key, value, options = {}) => { if (options.NX && values.has(key)) return null; values.set(key, value); return 'OK'; },
    incr: async key => { const next = Number(values.get(key) ?? 0) + 1; values.set(key, String(next)); return next; },
    expire: async () => {},
    eval: async (script, { keys, arguments: args }) => {
      if (script.includes("redis.call('DEL'")) return values.get(keys[0]) === args[0] ? Number(values.delete(keys[0])) : 0;
      if (script.includes("redis.call('EXPIRE'")) return values.get(keys[0]) === args[0] ? 1 : 0;
      if ((values.get(keys[0]) ?? '') !== args[0]) return 0;
      values.set(keys[0], args[1]); return 1;
    },
  };
  const calls = [];
  let movies = [], series = [], episodes = [];
  let failReads = false, failWrites = false;
  let writeBarrier = null;
  let now = Date.now();
  const nativeMovie = { tmdbId: 10, title: 'Native movie', year: 2027, images: [], monitored: true, hasFile: false };
  const nativeSeries = { tvdbId: 200, tmdbId: 20, title: 'Native series', seasons: [{ seasonNumber: 0, monitored: false }, { seasonNumber: 1, monitored: false }, { seasonNumber: 2, monitored: false }], monitored: true };
  const fetcher = async (urlString, init = {}) => {
    const url = new URL(urlString);
    const path = url.pathname.replace('/api/v3/', '');
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: urlString, path, method, body, headers: init.headers });
    if (url.hostname === 'api.themoviedb.org') {
      if (failReads) throw new Error('private-tmdb-credentials');
      const tv = url.pathname.includes('/tv');
      const item = tv ? { id: 20, name: 'Catalog series', first_air_date: '2027-01-01', external_ids: { tvdb_id: 200 }, seasons: [{ season_number: 1, name: 'Season 1', episode_count: 1 }, { season_number: 2, name: 'Season 2', episode_count: 1 }] }
        : { id: 10, title: 'Catalog movie', release_date: '2027-01-01', overview: 'A synopsis', poster_path: '/poster.jpg' };
      return Response.json(url.pathname.includes('/search/') ? { results: [item], total_pages: 2 } : item);
    }
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers['X-Api-Key'], url.hostname === 'radarr.test' ? 'radarr-private' : 'sonarr-private');
    if (method !== 'GET' && failWrites) throw new Error('private-password-or-path');
    if (method !== 'GET' && writeBarrier) await writeBarrier;
    if (method === 'GET') {
      if (failReads) throw new Error('private-service-error');
      if (path === 'qualityprofile') return Response.json([{ id: 1, name: 'HD' }]);
      if (path === 'rootfolder') return Response.json([{ path: url.hostname === 'radarr.test' ? '/movies' : '/series', accessible: true }]);
      if (path === 'movie') return Response.json(movies);
      if (path === 'series') return Response.json(series);
      if (path === 'movie/lookup') return Response.json([nativeMovie]);
      if (path === 'series/lookup') return Response.json([nativeSeries]);
      if (path === 'episode') return Response.json(episodes);
    }
    if (method === 'POST' && path === 'movie') { const item = { ...body, id: 101 }; movies.push(item); return Response.json(item); }
    if (method === 'POST' && path === 'series') { const item = { ...body, id: 202 }; series.push(item); return Response.json(item); }
    if (method === 'PUT' && path.startsWith('movie/')) { movies = [body]; return Response.json(body); }
    if (method === 'PUT' && path.startsWith('series/')) { series = [body]; return Response.json(body); }
    return Response.json({ id: 1 });
  };
  const accounts = { principal: async req => {
    const header = req.get('Authorization');
    return header === 'Bearer guest' || header === 'Bearer other' ? { id: header.endsWith('guest') ? 'guest' : 'other', name: 'Guest', role: 'user' } : null;
  } };
  const authentication = { requireAdministrator: (req, res, next) => req.get('Authorization') === 'Bearer admin' ? next() : res.status(403).json({ error: 'Administrator access required.' }) };
  const instances = [{ name: 'Primary', radarr: { base_url: 'http://radarr.test', api_key: 'radarr-private' }, sonarr: { base_url: 'http://sonarr.test', api_key: 'sonarr-private' } }];
  const feature = createMediaRequests(redis, { accounts, authentication, fetcher, readInstances: async () => instances, env: { TMDB_API_KEY: 'tmdb-private' }, now: () => now });
  const app = express(); app.use(express.json()); app.use('/requests', feature.router);
  const http = createServer(app); await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => http.close(resolve)));
  const base = `http://127.0.0.1:${http.address().port}/requests`;
  const send = (path = '', method = 'GET', body, token = 'guest') => fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const create = async (type = 'movies', seasons = null, token = 'guest') => {
    const response = await send('', 'POST', { type, tmdbId: type === 'movies' ? 10 : 20, seasons, title: 'Untrusted title', target: 'untrusted-service' }, token);
    assert.equal(response.status, 201); return response.json();
  };
  const approve = (id, type = 'movies', overrides = {}) => send(`/${id}/approve`, 'POST', { instance: 'Primary', profileId: 1, rootFolder: type === 'movies' ? '/movies' : '/series', ...overrides }, 'admin');
  return { send, create, approve, calls, feature, redis, holdWrites: barrier => { writeBarrier = barrier; }, setMovies: value => { movies = value; }, setSeries: value => { series = value; }, setEpisodes: value => { episodes = value; }, failReads: value => { failReads = value; }, failWrites: value => { failWrites = value; }, advance: ms => { now += ms; } };
}

test('catalog is authenticated, localized and contains no provider credentials', async t => {
  const { send, calls } = await setup(t);
  assert.equal((await send('/catalog/search?type=movies&query=Film', 'GET', null, '')).status, 403);
  assert.equal(calls.length, 0);
  const response = await send('/catalog/search?type=movies&query=Film&language=fr-FR');
  const body = await response.json();
  assert.equal(body.results[0].title, 'Catalog movie');
  assert.equal(new URL(calls[0].url).searchParams.get('language'), 'fr-FR');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.ok(!JSON.stringify(body).includes('private'));
});
test('request identity and metadata are server-owned; identical requests group subscribers atomically', async t => {
  const { send, create, redis } = await setup(t);
  const first = await create();
  const second = await create('movies', null, 'other');
  assert.equal(first.id, second.id);
  assert.equal(first.title, 'Catalog movie');
  const admin = await (await send('', 'GET', null, 'admin')).json();
  assert.equal(admin.items.length, 1);
  assert.equal(admin.items[0].subscribers.length, 2);
  const guest = await (await send()).json();
  assert.equal(guest.items[0].subscribers, undefined);
  assert.equal(guest.items[0].target, undefined);
  assert.equal((await requestStore(redis).read()).requests.length, 1);
});
test('guest lists are isolated and approval/options/refusal/check are admin-only', async t => {
  const { send, create, calls } = await setup(t);
  const item = await create();
  assert.equal((await (await send('', 'GET', null, 'other')).json()).items.length, 0);
  for (const [path, method] of [['/options', 'GET'], [`/${item.id}/approve`, 'POST'], [`/${item.id}/reject`, 'POST'], [`/${item.id}/check`, 'POST']]) assert.equal((await send(path, method, method === 'GET' ? undefined : {})).status, 403);
  assert.equal(calls.filter(call => call.method !== 'GET').length, 0);
});
test('series scopes are canonical and unavailable or malformed seasons are rejected', async t => {
  const { send, create } = await setup(t);
  const item = await create('series', [2, 1, 2]);
  assert.deepEqual(item.seasons, [1, 2]);
  assert.equal((await create('series', [1, 2])).id, item.id);
  for (const seasons of [[], [0], [-1], [99], ['1'], undefined]) {
    assert.equal((await send('', 'POST', { type: 'series', tmdbId: 20, seasons })).status, 400);
  }
});
test('approval adds a movie once with validated settings and automatic search', async t => {
  const { create, approve, calls, send } = await setup(t);
  const item = await create();
  assert.equal((await approve(item.id, 'movies', { rootFolder: '/arbitrary' })).status, 400);
  assert.equal(calls.filter(call => call.method !== 'GET').length, 0);
  const responses = await Promise.all([approve(item.id), approve(item.id)]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  const add = calls.find(call => call.method === 'POST' && call.path === 'movie');
  assert.equal(add.body.tmdbId, 10);
  assert.equal(add.body.qualityProfileId, 1);
  assert.equal(add.body.minimumAvailability, 'released');
  assert.equal(add.body.addOptions.searchForMovie, true);
  assert.equal(calls.filter(call => call.method === 'POST' && call.path === 'movie').length, 1);
  const guest = await (await send()).json();
  assert.equal(guest.items[0].status, 'approved');
  assert.ok(!JSON.stringify(guest).includes('/movies'));
});
test('partial series approval monitors only selected seasons and not future seasons', async t => {
  const { create, approve, calls } = await setup(t);
  const item = await create('series', [2]);
  assert.equal((await approve(item.id, 'series')).status, 200);
  const add = calls.find(call => call.path === 'series' && call.method === 'POST');
  assert.equal(add.body.tvdbId, 200);
  assert.deepEqual(add.body.seasons.map(season => [season.seasonNumber, season.monitored]), [[0, false], [1, false], [2, true]]);
  assert.equal(add.body.monitorNewItems, 'none');
  assert.equal(add.body.addOptions.monitor, 'skip');
});
test('whole-series approval monitors future seasons and accepts upcoming media', async t => {
  const { create, approve, calls } = await setup(t);
  const item = await create('series', null);
  assert.equal((await approve(item.id, 'series')).status, 200);
  const add = calls.find(call => call.path === 'series' && call.method === 'POST');
  assert.equal(add.body.monitorNewItems, 'all');
  assert.deepEqual(add.body.seasons.filter(season => season.monitored).map(season => season.seasonNumber), [1, 2]);
});
test('existing series preserve other seasons, quality and paths; only missing requested episodes are searched', async t => {
  const { setSeries, setEpisodes, create, approve, calls } = await setup(t);
  setSeries([{ id: 202, tvdbId: 200, monitored: false, qualityProfileId: 99, path: '/existing', seasons: [{ seasonNumber: 1, monitored: true }, { seasonNumber: 2, monitored: false }] }]);
  setEpisodes([{ id: 1, seriesId: 202, seasonNumber: 1, hasFile: true }, { id: 2, seriesId: 202, seasonNumber: 2, hasFile: false }, { id: 3, seriesId: 202, seasonNumber: 2, hasFile: true }]);
  const item = await create('series', [2]);
  assert.equal((await approve(item.id, 'series')).status, 200);
  const update = calls.find(call => call.path === 'series/202' && call.method === 'PUT');
  assert.equal(update.body.qualityProfileId, 99);
  assert.equal(update.body.path, '/existing');
  assert.equal(update.body.seasons[0].monitored, true);
  const search = calls.find(call => call.path === 'command');
  assert.deepEqual(search.body, { name: 'EpisodeSearch', episodeIds: [2] });
});
test('uncertain writes require read-only reconciliation, not automatic reapproval', async t => {
  const { create, approve, failWrites, send, calls } = await setup(t);
  const item = await create();
  failWrites(true);
  const response = await approve(item.id);
  assert.equal(response.status, 502);
  assert.ok(!JSON.stringify(await response.json()).includes('private'));
  assert.equal((await (await send()).json()).items[0].status, 'needs-review');
  assert.equal((await approve(item.id)).status, 409);
  const count = calls.filter(call => call.method !== 'GET').length;
  assert.equal((await send(`/${item.id}/check`, 'POST', {}, 'admin')).status, 200);
  assert.equal((await (await send()).json()).items[0].status, 'pending');
  assert.equal(calls.filter(call => call.method !== 'GET').length, count);
});
test('availability refresh is read-only and failed reads do not erase the last confirmed status', async t => {
  const { create, approve, setMovies, feature, advance, send, calls, failReads } = await setup(t);
  const item = await create(); await approve(item.id);
  setMovies([{ id: 101, tmdbId: 10, hasFile: true, monitored: true }]); advance(61000);
  const writes = calls.filter(call => call.method !== 'GET').length;
  await feature.refresh();
  assert.equal((await (await send()).json()).items[0].status, 'available');
  assert.equal(calls.filter(call => call.method !== 'GET').length, writes);
  failReads(true); advance(61000); await feature.refresh();
  const saved = (await (await send()).json()).items[0];
  assert.equal(saved.status, 'available'); assert.equal(saved.availabilityKnown, false);
});
test('refusal stores the reason and never contacts Radarr or Sonarr', async t => {
  const { create, send, calls } = await setup(t);
  const item = await create();
  const response = await send(`/${item.id}/reject`, 'POST', { reason: 'Not for this library' }, 'admin');
  assert.equal(response.status, 200);
  const saved = (await (await send()).json()).items[0];
  assert.equal(saved.status, 'rejected'); assert.equal(saved.reason, 'Not for this library');
  assert.equal(calls.filter(call => call.method !== 'GET').length, 0);
});
test('already available movies are visible but cannot create redundant download requests', async t => {
  const { send, setMovies } = await setup(t);
  setMovies([{ id: 101, tmdbId: 10, hasFile: true }]);
  assert.equal((await (await send('/catalog/movies/10')).json()).availability, 'available');
  assert.equal((await send('', 'POST', { type: 'movies', tmdbId: 10 })).status, 409);
});
test('interrupted approvals require review and worker recovery never replays the write', async t => {
  const { create, redis, advance, feature, send, calls } = await setup(t);
  const item = await create();
  await requestStore(redis).change(requests => Object.assign(requests.find(request => request.id === item.id), { status: 'processing', operation: 'interrupted', target: { instance: 'Primary' } }));
  advance(181000); await feature.refresh();
  assert.equal((await (await send()).json()).items[0].status, 'needs-review');
  assert.equal(calls.filter(call => call.method !== 'GET').length, 0);
});
test('foreign-series episode data cannot trigger monitoring or search changes', async t => {
  const { setSeries, setEpisodes, create, approve, calls } = await setup(t);
  setSeries([{ id: 202, tvdbId: 200, monitored: false, seasons: [{ seasonNumber: 2, monitored: false }] }]);
  setEpisodes([{ id: 999, seriesId: 999, seasonNumber: 2, hasFile: false }]);
  const item = await create('series', [2]);
  assert.equal((await approve(item.id, 'series')).status, 502);
  assert.equal(calls.filter(call => call.method !== 'GET').length, 0);
});
test('whole-series approval still enables future-season monitoring when current files already exist', async t => {
  const { create, approve, setSeries, setEpisodes, calls } = await setup(t);
  setSeries([{ id: 202, tvdbId: 200, monitored: true, monitorNewItems: 'none', seasons: [{ seasonNumber: 1, monitored: true }] }]);
  setEpisodes([{ id: 1, seriesId: 202, seasonNumber: 1, hasFile: true }]);
  const item = await create('series', null);
  assert.equal((await approve(item.id, 'series')).status, 200);
  assert.equal(calls.find(call => call.method === 'PUT' && call.path === 'series/202').body.monitorNewItems, 'all');
  assert.equal(calls.filter(call => call.path === 'command').length, 0);
});
test('catalog normalization supports original titles and rejects unsafe poster URLs or adult items', () => {
  assert.equal(catalogMedia({ id: 10, adult: true, title: 'Adult' }, 'movies'), null);
  const item = catalogMedia({ id: 10, title: 'Translated', original_title: 'Original', original_language: 'ja', translations: { translations: [{ iso_639_1: 'ja', data: { overview: 'Original synopsis' } }] }, poster_path: 'https://private.test/token' }, 'movies', true);
  assert.equal(item.title, 'Original'); assert.equal(item.overview, 'Original synopsis'); assert.equal(item.poster, '');
});
test('removed media require review instead of silently remaining approved or being readded', async t => {
  const { create, approve, setMovies, advance, feature, send, calls } = await setup(t);
  const item = await create(); await approve(item.id);
  setMovies([]); advance(61000);
  const writes = calls.filter(call => call.method !== 'GET').length;
  await feature.refresh();
  assert.equal((await (await send()).json()).items[0].status, 'needs-review');
  const response = await send(`/${item.id}/check`, 'POST', {}, 'admin');
  const reconciled = await response.json();
  assert.equal(reconciled.status, 'pending'); assert.equal(reconciled.actionError, '');
  assert.equal(calls.filter(call => call.method !== 'GET').length, writes);
});
test('different season requests for the same media cannot clobber monitoring concurrently', async t => {
  const { create, approve, calls, holdWrites } = await setup(t);
  const first = await create('series', [1]);
  const second = await create('series', [2]);
  let release;
  holdWrites(new Promise(resolve => { release = resolve; }));
  const running = approve(first.id, 'series');
  try {
    for (let attempt = 0; attempt < 200 && !calls.some(call => call.method === 'POST' && call.path === 'series'); attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal((await approve(second.id, 'series')).status, 409);
  } finally { release(); }
  assert.equal((await running).status, 200);
  assert.equal(calls.filter(call => call.method === 'POST' && call.path === 'series').length, 1);
});
