import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const ci = readFileSync(new URL('../../.gitlab-ci.yml', import.meta.url), 'utf8');
const commands = ci.split('\n').filter(line => line.trim().startsWith('- git for-each-ref')).map(line => line.trim().slice(2));

test('both mirrors use batch deletion for pipeline references', () => {
  assert.equal(commands.length, 2);
  for (const command of commands) {
    assert.match(command, /--format="delete %\(refname\)" refs\/pipelines\//);
    assert.match(command, /git update-ref --stdin$/);
    assert.doesNotMatch(command, /xargs/);
  }
});

for (const [index, command] of commands.entries()) for (const count of [0, 1, 2, 3]) {
  test(`mirror ${index + 1} deletes ${count} pipeline refs without touching branches, tags or merge requests`, () => {
    const cwd = mkdtempSync(join(tmpdir(), 'flix-mirror-refs-'));
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Test', GIT_COMMITTER_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
    function git(...args) {
      const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    }
    try {
      git('init', '--initial-branch=master');
      git('-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'First test commit');
      const first = git('rev-parse', 'HEAD');
      git('-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Second test commit');
      const second = git('rev-parse', 'HEAD');
      git('update-ref', 'refs/tags/v1.0.0', first);
      git('update-ref', 'refs/merge-requests/1/head', second);
      for (let n = 0; n < count; n++) git('update-ref', `refs/pipelines/${n + 1}`, n % 2 ? second : first);
      const result = spawnSync('sh', ['-c', command], { cwd, env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(git('for-each-ref', '--format=%(refname)', 'refs/pipelines/'), '');
      assert.equal(git('rev-parse', 'refs/heads/master'), second);
      assert.equal(git('rev-parse', 'refs/tags/v1.0.0'), first);
      assert.equal(git('rev-parse', 'refs/merge-requests/1/head'), second);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
}
