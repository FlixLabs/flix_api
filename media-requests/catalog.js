import { positiveId, problem } from './store.js';

const text = (value, limit = 1000) => typeof value === 'string' ? value.slice(0, limit) : '';
export const mediaType = type => {
  if (!['movies', 'series'].includes(type)) throw problem(400, 'Invalid media type.');
  return type;
};
export function catalogMedia(item, type, original = false) {
  if (!item || !positiveId(item.id) || item.adult === true) return null;
  const title = text(original ? (type === 'movies' ? item.original_title ?? item.title : item.original_name ?? item.name) : type === 'movies' ? item.title : item.name, 300);
  if (!title) return null;
  const translations = Array.isArray(item.translations?.translations) ? item.translations.translations : [];
  const originalOverview = original ? translations.find(translation => translation?.iso_639_1 === item.original_language)?.data?.overview : '';
  return { tmdbId: item.id, type, title, overview: text(originalOverview || item.overview, 4000),
    year: text(type === 'movies' ? item.release_date : item.first_air_date, 10).slice(0, 4),
    poster: typeof item.poster_path === 'string' && /^\/[\w.-]+$/.test(item.poster_path) ? `https://image.tmdb.org/t/p/w342${item.poster_path}` : '',
    ...(type === 'series' ? {
      tvdbId: positiveId(item.external_ids?.tvdb_id) ? item.external_ids.tvdb_id : null,
      seasons: Array.isArray(item.seasons) ? item.seasons.filter(season => Number.isSafeInteger(season.season_number) && season.season_number > 0)
        .map(season => ({ number: season.season_number, name: text(season.name, 200), episodeCount: Number.isSafeInteger(season.episode_count) ? season.episode_count : 0 })) : [],
    } : {}),
  };
}
export function createCatalog({ env, fetcher }) {
  const cache = new Map();
  async function read(path, params) {
    if (!env.TMDB_API_KEY) throw problem(503, 'Configure TMDB_API_KEY on the API to enable media requests.');
    const url = new URL(`https://api.themoviedb.org/3/${path}`);
    url.search = new URLSearchParams({ ...params, api_key: env.TMDB_API_KEY }).toString();
    try {
      const response = await fetcher(url.href, { redirect: 'error', signal: AbortSignal.timeout(12000) });
      if (response.status === 404) throw problem(404, 'Media not found.');
      if (!response.ok) throw problem(502, 'Media catalog unavailable.');
      return await response.json();
    } catch (error) { throw error.status ? error : problem(502, 'Media catalog unavailable.'); }
  }
  async function details(type, id, language) {
    mediaType(type);
    if (!positiveId(id)) throw problem(400, 'Invalid media identifier.');
    const key = `${type}:${id}:${language}`;
    const cached = cache.get(key);
    if (cached?.expires > Date.now()) return cached.data;
    const append = [type === 'series' ? 'external_ids' : '', language === 'original' ? 'translations' : ''].filter(Boolean).join(',');
    const data = await read(`${type === 'movies' ? 'movie' : 'tv'}/${id}`, { language: language === 'original' ? 'en' : language, ...(append ? { append_to_response: append } : {}) });
    const result = catalogMedia(data, type, language === 'original');
    if (!result || result.tmdbId !== id) throw problem(404, 'Media not found.');
    if (cache.size >= 200) cache.delete(cache.keys().next().value);
    cache.set(key, { expires: Date.now() + 300000, data: result });
    return result;
  }
  async function search(type, query, page, language) {
    mediaType(type);
    if (typeof query !== 'string' || query.trim().length < 2 || query.length > 200 || !Number.isInteger(page) || page < 1 || page > 50) throw problem(400, 'Enter a search of 2 to 200 characters.');
    const data = await read(`search/${type === 'movies' ? 'movie' : 'tv'}`, { query: query.trim(), page: String(page), language: language === 'original' ? 'en' : language, include_adult: 'false' });
    if (!Array.isArray(data?.results)) throw problem(502, 'Media catalog unavailable.');
    return { results: data.results.map(item => catalogMedia(item, type, language === 'original')).filter(Boolean), page,
      totalPages: Math.min(50, Number.isInteger(data.total_pages) ? Math.max(0, data.total_pages) : 0) };
  }
  return { details, search };
}
