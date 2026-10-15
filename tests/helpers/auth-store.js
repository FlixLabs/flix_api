export function authStore(initial = null) {
  let auth = initial;
  const values = new Map();
  return {
    values,
    json: {
      get: async () => auth,
      set: async (_key, _path, value) => { auth = value; },
      del: async () => { auth = null; },
    },
    get: async key => {
      const entry = values.get(key);
      return entry && (!entry.expiresAt || entry.expiresAt > Date.now()) ? entry.value : null;
    },
    set: async (key, value, options = {}) => { values.set(key, { value, expiresAt: options.EX ? Date.now() + options.EX * 1000 : 0 }); },
    del: async key => values.delete(key),
    eval: async (_script, { arguments: args }) => {
      if (!auth || auth.username !== args[0] || auth.password !== args[1]) return 0;
      auth = JSON.parse(args[2]); return 1;
    },
    incr: async key => { const value = Number(values.get(key)?.value ?? 0) + 1; values.set(key, { value }); return value; },
    expire: async (key, seconds) => { values.get(key).expiresAt = Date.now() + seconds * 1000; },
  };
}
