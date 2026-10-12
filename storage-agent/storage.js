import { statfs, stat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { storageFailure } from './diagnostics.js';

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
  if (!mount) throw Object.assign(new Error('Mount unavailable'), { code: 'MOUNT_NOT_FOUND' });
  // The source may contain SSH usernames: only publish an opaque volume identifier.
  return createHash('sha256').update(mount.identity).digest('hex');
}

export function filesystemMetrics(info) {
  const total = info.blocks * info.bsize;
  const free = info.bfree * info.bsize;
  const available = info.bavail * info.bsize;
  const used = total - free;
  if (total <= 0n || available < 0n || free < available || used < 0n || total > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw Object.assign(new Error('Invalid filesystem metrics'), { code: 'INVALID_METRICS' });
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

export async function collectStorage(locations, filesystem = { stat, statfs, readFile }) {
  const mountInfo = await filesystem.readFile('/proc/self/mountinfo', 'utf8');
  const records = await Promise.all(locations.map(async ({ id, path }) => {
    try {
      if (!(await filesystem.stat(path)).isDirectory()) throw Object.assign(new Error('Not a directory'), { code: 'ENOTDIR' });
      const metrics = filesystemMetrics(await filesystem.statfs(path, { bigint: true }));
      return { id, path, available: true, volumeId: volumeIdentity(mountInfo, path), ...metrics };
    } catch (error) {
      return { id, path, available: false, ...storageFailure(error) };
    }
  }));
  return { collectedAt: new Date().toISOString(), locations: records };
}
