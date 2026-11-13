import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isMatroskaHeader, inspectMediaFile, safeRelativePath } from '../storage-agent/media-format.js';

const matroska = Buffer.from('1a45dfa38b4282886d6174726f736b61', 'hex');
test('requires a bounded EBML header with an explicit Matroska DocType', () => {
  assert.equal(isMatroskaHeader(matroska), true);
  for (const bytes of [Buffer.alloc(0), Buffer.from('matroska'), matroska.subarray(0, 10),
    Buffer.from('1a45dfa3ff', 'hex'), Buffer.from('1a45dfa3874282847765626d', 'hex'),
    Buffer.from('1a45dfa3964282886d6174726f736b614282886d6174726f736b61', 'hex')]) {
    assert.equal(isMatroskaHeader(bytes), false);
  }
});
test('rejects traversal, absolute paths, controls and ambiguous separators', () => {
  for (const path of ['', '/etc/passwd', '../file', 'a/../../file', 'a//b', 'a/./b', 'a\\b', 'a\0b', 'a\nb']) {
    assert.equal(safeRelativePath(path), false);
  }
  assert.equal(safeRelativePath('folder/Film.2026-Groupe'), true);
});
test('reads a confined regular file without changing it and refuses collisions or symlinks', async t => {
  const root = await mkdtemp(join(tmpdir(), 'flix-media-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const locations = [{ id: 'downloads', path: root }];
  await writeFile(join(root, 'Movie-Groupe'), matroska);
  const result = await inspectMediaFile(locations, 'Movie-Groupe');
  assert.equal(result.format, 'matroska');
  assert.equal(result.sizeBytes, matroska.length);
  assert.match(result.identity, /^[a-f0-9]{64}$/);
  assert.deepEqual(await inspectMediaFile(locations, 'Movie-Groupe'), result);
  await writeFile(join(root, 'Movie-Groupe.mkv'), 'existing');
  await assert.rejects(inspectMediaFile(locations, 'Movie-Groupe'));
  await symlink(join(root, 'Movie-Groupe'), join(root, 'link'));
  await assert.rejects(inspectMediaFile(locations, 'link'));
  await mkdir(join(root, 'directory'));
  await assert.rejects(inspectMediaFile(locations, 'directory'));
  await symlink(root, join(root, 'linked-directory'));
  await assert.rejects(inspectMediaFile(locations, 'linked-directory/Movie-Groupe'));
  await assert.rejects(inspectMediaFile(locations, '../private'));
  await assert.rejects(inspectMediaFile(locations, 'missing'));
  await writeFile(join(root, 'wrong'), 'not a container');
  await assert.rejects(inspectMediaFile(locations, 'wrong'));
  await writeFile(join(root, 'changed'), matroska);
  const previous = await inspectMediaFile(locations, 'changed');
  await writeFile(join(root, 'changed'), Buffer.concat([matroska, Buffer.from('changed')]));
  assert.notEqual((await inspectMediaFile(locations, 'changed')).identity, previous.identity);
});
