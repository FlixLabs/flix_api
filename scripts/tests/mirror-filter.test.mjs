import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const ci = readFileSync(new URL('../../.gitlab-ci.yml', import.meta.url), 'utf8');
for (const job of ['mirror-gitlab', 'mirror-github']) {
  const config = ci.split(`\n${job}:\n`)[1].split(/\n[a-z][a-z-]*:\n/)[0];
  test(`${job} filters annotated tags and branches before publication`, () => {
    const prefix = config.match(/git filter-branch[^\n]*?(?= --tree-filter)/)?.[0];
    assert.equal(prefix, 'git filter-branch --tag-name-filter cat');
    const cwd = mkdtempSync(join(tmpdir(), 'flix-filter-tags-'));
    const env = { ...process.env, FILTER_BRANCH_SQUELCH_WARNING: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Test', GIT_COMMITTER_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
    function git(...args) {
      const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
    }
    try {
      git('init', '--initial-branch=master');
      writeFileSync(join(cwd, '.gitlab-ci.yml'), 'private_job: {}\n');
      writeFileSync(join(cwd, 'README.md'), 'Public project\n');
      git('add', '.'); git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Synthetic source');
      git('-c', 'tag.gpgsign=false', 'tag', '-a', 'v1.0.0', '-m', 'Synthetic release');
      const result = spawnSync('sh', ['-c', `${prefix} --tree-filter 'rm -f .gitlab-ci.yml' -- --all`], { cwd, env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      for (const ref of ['master', 'v1.0.0']) {
        const probe = spawnSync('git', ['cat-file', '-e', `${ref}:.gitlab-ci.yml`], { cwd, env });
        assert.notEqual(probe.status, 0);
        assert.equal(git('show', `${ref}:README.md`), 'Public project');
      }
      assert.equal(git('cat-file', '-t', 'v1.0.0'), 'tag');
      assert.equal(git('rev-parse', 'master'), git('rev-parse', 'v1.0.0^{}'));
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
  test(`${job} uses a CI skip option only for the GitLab mirror`, () => {
    const push = config.split('\n').find(line => line.includes('git push'));
    assert.match(push, /\+refs\/heads\/\*:refs\/heads\/\* \+refs\/tags\/\*:refs\/tags\/\*/);
    if (job === 'mirror-gitlab') assert.match(push, / -o ci\.skip /);
    else assert.doesNotMatch(push, /ci\.skip/);
  });
}
