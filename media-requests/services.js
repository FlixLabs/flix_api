import { positiveId, problem } from './store.js';

function list(value) {
  if (!Array.isArray(value) || value.some(item => !item || typeof item !== 'object')) throw problem(502, 'Media service returned invalid data.');
  return value;
}
export function createMediaServices({ readInstances, fetcher }) {
  async function instances() {
    return list(await readInstances());
  }
  async function client(name, type, timeout = 15000) {
    const matches = (await instances()).filter(instance => instance.name === name);
    const config = matches.length === 1 ? matches[0][type === 'movies' ? 'radarr' : 'sonarr'] : null;
    let base;
    try { base = new URL(config.base_url); } catch { throw problem(400, 'Choose a configured instance.'); }
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || !config.api_key) throw problem(400, 'Choose a configured instance.');
    return async (path, method = 'GET', body) => {
      const url = `${base.href.replace(/\/$/, '')}/api/v3/${path}`;
      try {
        const response = await fetcher(url, { method, redirect: 'error', signal: AbortSignal.timeout(timeout),
          headers: { 'X-Api-Key': config.api_key, 'Content-Type': 'application/json' },
          ...(body ? { body: JSON.stringify(body) } : {}) });
        if (!response.ok) throw problem(502, 'Media service request failed.');
        const data = await response.json();
        if (!data || typeof data !== 'object') throw problem(502, 'Media service returned invalid data.');
        return data;
      } catch { throw problem(502, 'Media service request failed.'); }
    };
  }
  async function options(name, type) {
    if (!name) return { instances: (await instances()).filter(item => typeof item.name === 'string').map(item => item.name) };
    const call = await client(name, type);
    const [profiles, folders] = await Promise.all([call('qualityprofile'), call('rootfolder')]);
    return { profiles: list(profiles).filter(item => positiveId(item.id) && typeof item.name === 'string').map(({ id, name }) => ({ id, name })),
      folders: list(folders).filter(item => typeof item.path === 'string' && item.accessible !== false).map(({ path }) => path) };
  }
  const resource = type => type === 'movies' ? 'movie' : 'series';
  function matches(item, request) {
    return request.type === 'movies' ? item.tmdbId === request.tmdbId : item.tvdbId === request.tvdbId && positiveId(request.tvdbId);
  }
  async function find(call, request) {
    const found = list(await call(resource(request.type))).filter(item => matches(item, request));
    if (found.length > 1 || found.some(item => !positiveId(item.id))) throw problem(502, 'Media service returned invalid data.');
    return found[0] ?? null;
  }
  function seasonNumbers(request, item) {
    const native = list(item.seasons).map(season => season.seasonNumber).filter(number => Number.isSafeInteger(number) && number > 0);
    const selected = request.seasons ?? native;
    if (selected.some(number => !native.includes(number))) throw problem(409, 'Selected seasons are not available in Sonarr yet.');
    return selected;
  }
  async function inspect(call, request, item) {
    if (!item) return { exists: false, available: false, monitored: false };
    if (request.type === 'movies') return { exists: true, available: item.hasFile === true, monitored: item.monitored === true };
    const selected = seasonNumbers(request, item);
    const allEpisodes = list(await call(`episode?seriesId=${item.id}`));
    if (allEpisodes.some(episode => !positiveId(episode.id) || episode.seriesId !== item.id || !Number.isSafeInteger(episode.seasonNumber))) throw problem(502, 'Media service returned invalid data.');
    const episodes = allEpisodes.filter(episode => selected.includes(episode.seasonNumber));
    // Future episodes count as missing too; an empty/partial season is never declared available.
    const completeSeasons = selected.length > 0 && selected.every(number => {
      const expected = item.seasons.find(season => season.seasonNumber === number)?.statistics?.totalEpisodeCount;
      const found = episodes.filter(episode => episode.seasonNumber === number);
      return found.length > 0 && (!Number.isSafeInteger(expected) || expected <= found.length) && found.every(episode => episode.hasFile === true);
    });
    return { exists: true, available: completeSeasons, monitored: item.monitored === true && (request.seasons !== null || item.monitorNewItems === 'all')
      && selected.every(number => item.seasons.some(season => season.seasonNumber === number && season.monitored === true))
      && episodes.every(episode => episode.monitored === true || episode.hasFile === true), episodes, selected };
  }
  async function observe(request) {
    const call = await client(request.target.instance, request.type);
    const item = await find(call, request);
    return inspect(call, request, item);
  }
  async function availability(item) {
    let unknown = false;
    const configured = (await instances()).filter(instance => instance[item.type === 'movies' ? 'radarr' : 'sonarr']?.api_key);
    let available = false;
    // Bound both concurrency and latency; an uninspected instance means unknown, never missing.
    const remaining = configured.slice(0, 16);
    if (configured.length > 16) unknown = true;
    await Promise.all(Array.from({ length: Math.min(4, remaining.length) }, async () => {
      let instance;
      while (!available && (instance = remaining.shift())) {
      try {
        const call = await client(instance.name, item.type, 3000);
        const existing = await find(call, item);
        if (!existing) continue;
        if (item.type === 'movies' && existing.hasFile === true) available = true;
        if (item.type === 'series' && positiveId(item.tvdbId) && (await inspect(call, { ...item, seasons: null }, existing)).available) available = true;
      } catch { unknown = true; }
      }
    }));
    if (available) return 'available';
    return !configured.length || unknown ? 'unknown' : 'missing';
  }
  async function approve(request, target, guard = async () => {}) {
    const settings = await options(target.instance, request.type);
    if (!settings.profiles.some(item => item.id === target.profileId) || !settings.folders.includes(target.rootFolder)) throw problem(400, 'Choose a valid quality profile and root folder.');
    const service = await client(target.instance, request.type);
    const call = async (path, method = 'GET', body) => {
      if (method !== 'GET') await guard();
      return service(path, method, body);
    };
    let item = await find(call, request);
    let wrote = false;
    try {
      if (!item) {
        const identity = request.type === 'movies' ? `tmdb:${request.tmdbId}` : `tvdb:${request.tvdbId}`;
        const lookup = list(await call(`${resource(request.type)}/lookup?term=${encodeURIComponent(identity)}`)).filter(item => matches(item, request));
        if (lookup.length !== 1) throw problem(409, 'Media could not be identified in Radarr or Sonarr.');
        const native = lookup[0];
        const selected = request.type === 'series' ? seasonNumbers(request, native) : [];
        const metadata = { ...native };
        delete metadata.id;
        delete metadata.path;
        const body = { ...metadata, monitored: true, qualityProfileId: target.profileId, rootFolderPath: target.rootFolder,
          ...(request.type === 'movies' ? { minimumAvailability: 'released', addOptions: { searchForMovie: true } }
            : { seasons: native.seasons.map(season => ({ ...season, monitored: selected.includes(season.seasonNumber) })), monitorNewItems: request.seasons === null ? 'all' : 'none', addOptions: { monitor: 'skip', searchForMissingEpisodes: true } }) };
        wrote = true;
        item = await call(resource(request.type), 'POST', body);
        if (!positiveId(item.id) || !matches(item, request)) throw problem(502, 'Media service returned invalid data.');
        return { available: false };
      }
      const state = await inspect(call, request, item);
      if (state.available && (request.type === 'movies' || state.monitored && (request.seasons !== null || item.monitorNewItems === 'all'))) return state;
      if (request.type === 'movies') {
        if (!item.monitored) { wrote = true; await call(`movie/${item.id}`, 'PUT', { ...item, monitored: true }); }
        wrote = true;
        const command = await call('command', 'POST', { name: 'MoviesSearch', movieIds: [item.id] });
        if (!positiveId(command.id)) throw problem(502, 'Media service returned invalid data.');
      } else {
        // Preserve every unrequested season and the existing quality/path settings.
        wrote = true;
        await call(`series/${item.id}`, 'PUT', { ...item, monitored: true, seasons: item.seasons.map(season => ({ ...season, monitored: state.selected.includes(season.seasonNumber) ? true : season.monitored })), ...(request.seasons === null ? { monitorNewItems: 'all' } : {}) });
        const ids = state.episodes.map(episode => episode.id);
        if (ids.some(id => !positiveId(id))) throw problem(502, 'Media service returned invalid data.');
        if (ids.length) await call('episode/monitor', 'PUT', { episodeIds: ids, monitored: true });
        const missing = state.episodes.filter(episode => !episode.hasFile).map(episode => episode.id);
        if (missing.length) {
          const command = await call('command', 'POST', { name: 'EpisodeSearch', episodeIds: missing });
          if (!positiveId(command.id)) throw problem(502, 'Media service returned invalid data.');
        }
      }
      return { available: state.available };
    } catch (error) { error.uncertain = wrote; throw error; }
  }
  return { options, approve, observe, availability };
}
