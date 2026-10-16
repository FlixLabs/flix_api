export const requestKey = 'flix:media-requests:v1';
export const problem = (status, message) => Object.assign(new Error(message), { status });
export const positiveId = value => Number.isSafeInteger(value) && value > 0;

export function requestStore(redis) {
  const read = async () => {
    const raw = await redis.get(requestKey);
    return { raw, requests: raw ? JSON.parse(raw) : [] };
  };
  async function change(update) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const { raw, requests } = await read();
      const result = update(requests);
      const saved = await redis.eval(`
        if (redis.call('GET', KEYS[1]) or '') ~= ARGV[1] then return 0 end
        redis.call('SET', KEYS[1], ARGV[2])
        return 1
      `, { keys: [requestKey], arguments: [raw ?? '', JSON.stringify(requests)] });
      if (saved === 1) return result;
    }
    throw problem(409, 'Requests changed. Please try again.');
  }
  return { read, change };
}

export function publicRequest(item, admin = false) {
  const { id, type, tmdbId, title, year, poster, seasons, status, reason, createdAt, updatedAt, checkedAt, availabilityKnown, actionError } = item;
  return { id, type, tmdbId, title, year, poster, seasons, status, reason, createdAt, updatedAt, checkedAt, availabilityKnown, actionError,
    ...(admin ? { subscribers: item.subscribers, instance: item.target?.instance } : {}) };
}
