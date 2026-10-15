const keys = ['name', 'state', 'progress', 'is_finished', 'total_size', 'save_path', 'ratio'];
export const validTorrentId = id => typeof id === 'string' && /^[a-f0-9]{40}$/i.test(id);

export async function connectDeluge(config, fetchClient = fetch) {
  const url = new URL(config.base_url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !config.password) throw new Error('Invalid client configuration');
  url.pathname = url.pathname.replace(/\/$/, '') + '/json';
  let cookie = '';
  let id = 0;
  const signal = AbortSignal.timeout(20000);
  async function rpc(method, params) {
    const requestId = ++id;
    const response = await fetchClient(url, { method: 'POST', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify({ id: requestId, method, params }) });
    if (!response.ok) throw new Error('Client unavailable');
    const cookies = response.headers.getSetCookie?.() ?? [response.headers.get('set-cookie') ?? ''];
    const session = cookies.find(value => value.startsWith('_session_id='));
    if (session) cookie = session.split(';')[0];
    const data = await response.json();
    if (data?.id !== requestId || data.error) throw new Error('Invalid client response');
    return data.result;
  }
  if (await rpc('auth.login', [config.password]) !== true || !cookie) throw new Error('Client authentication failed');
  if (await rpc('web.connected', []) !== true) throw new Error('Connect the Deluge Web UI to its daemon first');
  return {
    async list() {
      const data = await rpc('core.get_torrents_status', [{}, keys]);
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid torrent list');
      return Object.entries(data).map(([id, item]) => {
        if (!validTorrentId(id) || typeof item?.name !== 'string' || !item.name.trim()
          || typeof item.state !== 'string' || !Number.isFinite(item.progress) || item.progress < 0 || item.progress > 100
          || typeof item.is_finished !== 'boolean' || !Number.isFinite(item.total_size) || item.total_size < 0) throw new Error('Invalid torrent');
        return { id: id.toLowerCase(), name: item.name, state: item.state, progress: item.progress,
          completed: item.is_finished && item.progress === 100 && ['Seeding', 'Paused'].includes(item.state), sizeBytes: item.total_size,
          path: typeof item.save_path === 'string' ? item.save_path : '',
          ratio: Number.isFinite(item.ratio) && item.ratio >= 0 ? item.ratio : null };
      });
    },
    async remove(id, deleteData) {
      if (!validTorrentId(id) || typeof deleteData !== 'boolean') throw new Error('Invalid removal');
      // Never retry a destructive JSON-RPC request: a lost reply is an uncertain outcome.
      if (await rpc('core.remove_torrent', [id, deleteData]) !== true) throw new Error('Removal not confirmed');
    },
  };
}
