import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';

const limit = 65536;
function inside(root, path) {
  const value = relative(root, path);
  return value !== '' && !isAbsolute(value) && value !== '..' && !value.startsWith('../');
}
export function safeRelativePath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096
    && !/[\\\x00-\x1f\x7f]/.test(value) && !isAbsolute(value)
    && value.split('/').every(part => part && part !== '.' && part !== '..');
}

// Parse only the bounded EBML header. EBML alone could also be WebM, not Matroska.
export function isMatroskaHeader(buffer) {
  function vint(offset, id = false) {
    const first = buffer[offset];
    if (!first) throw new Error('Invalid EBML');
    let length = 1;
    while (length <= 8 && !(first & (0x80 >> (length - 1)))) length++;
    if (length > (id ? 4 : 8) || offset + length > buffer.length) throw new Error('Invalid EBML');
    let value = BigInt(id ? first : first & ((0x80 >> (length - 1)) - 1));
    for (let index = 1; index < length; index++) value = (value << 8n) | BigInt(buffer[offset + index]);
    if (!id && value === (1n << BigInt(7 * length)) - 1n) throw new Error('Unknown header size');
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Invalid EBML');
    return { length, value: Number(value) };
  }
  try {
    if (buffer.length < 5 || buffer.readUInt32BE(0) !== 0x1a45dfa3) return false;
    const size = vint(4);
    let offset = 4 + size.length;
    const end = offset + size.value;
    if (end > buffer.length || end > limit) return false;
    let docType;
    while (offset < end) {
      const id = vint(offset, true); offset += id.length;
      const length = vint(offset); offset += length.length;
      if (offset + length.value > end) return false;
      if (id.value === 0x4282) {
        if (docType !== undefined) return false;
        docType = buffer.subarray(offset, offset + length.value).toString('utf8');
      }
      offset += length.value;
    }
    return docType === 'matroska';
  } catch { return false; }
}

export async function inspectMediaFile(locations, filePath) {
  if (!safeRelativePath(filePath) || /\.mkv$/i.test(filePath)) throw new Error('Invalid inspection path');
  const location = locations.find(item => item.id === 'downloads');
  if (!location) throw new Error('Downloads unavailable');
  const root = await realpath(location.path);
  const path = resolve(root, filePath);
  if (!inside(root, path)) throw new Error('Invalid inspection path');
  let part = root;
  for (const segment of filePath.split('/')) {
    part = join(part, segment);
    if ((await lstat(part)).isSymbolicLink()) throw new Error('Symlinks are not supported');
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    // Check the opened descriptor, not only a path which could have been swapped.
    const actual = await realpath(process.platform === 'linux' ? `/proc/self/fd/${handle.fd}` : path);
    if (!inside(root, actual) || actual !== path) throw new Error('Inspection path changed');
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size <= 0n || before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Not a regular file');
    const bytes = Buffer.alloc(limit);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const header = bytes.subarray(0, bytesRead);
    if (!isMatroskaHeader(header)) throw new Error('Unsupported media format');
    const after = await handle.stat({ bigint: true });
    const identity = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
    if (identity(before) !== identity(after)) throw new Error('File changed');
    let exists = false;
    try { await lstat(path + '.mkv'); exists = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (exists) throw new Error('Target already exists');
    return { format: 'matroska', extension: '.mkv', sizeBytes: Number(after.size),
      identity: createHash('sha256').update(identity(after)).update(header).digest('hex') };
  } finally { await handle.close(); }
}
