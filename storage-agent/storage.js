import { statfs, stat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const unescapeMount = value => value.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));

export function volumeIdentity(mountInfo, path) {
  const mounts = mountInfo.trim().split('\n').map(line => {
    const [left, right] = line.split(' - ');
    if (!right) return null;
    const fields = left.split(' ');
    const [type, source] = right.split(' ');
    return { path: unescapeMount(fields[4]), identity: `${fields[2]}:${type}:${source}` };
  }).filter(Boolean);
  const mount = mounts.filter(mount => path === mount.path || path.startsWith(mount.path.replace(/\/$/, '') + '/'))
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (!mount) throw new Error('Mount unavailable');
  // The source may contain SSH usernames: only publish an opaque volume identifier.
  return createHash('sha256').update(mount.identity).digest('hex');
}

export function filesystemMetrics(info) {
  const total = info.blocks * info.bsize;
  const free = info.bfree * info.bsize;
  const available = info.bavail * info.bsize;
  const used = total - free;
  if (total <= 0n || available < 0n || free < available || used < 0n || total > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Invalid filesystem metrics');
  }
  return {
    totalBytes: Number(total),
    usedBytes: Number(used),
    availableBytes: Number(available),
    reservedBytes: Number(free - available),
    // Like df, exclude reserved space from the usage denominator.
    usagePercent: used + available > 0n ? Math.ceil(Number(used) / Number(used + available) * 100) : 0,
  };
}

export async function collectStorage(locations) {
  const mountInfo = await readFile('/proc/self/mountinfo', 'utf8');
  const records = await Promise.all(locations.map(async ({ id, path }) => {
    try {
      if (!(await stat(path)).isDirectory()) throw new Error('Not a directory');
      const metrics = filesystemMetrics(await statfs(path, { bigint: true }));
      return { id, path, available: true, volumeId: volumeIdentity(mountInfo, path), ...metrics };
    } catch {
      return { id, path, available: false, error: 'Storage unavailable' };
    }
  }));
  return { collectedAt: new Date().toISOString(), locations: records };
}
