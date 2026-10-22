import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const ci = readFileSync(new URL('../../.gitlab-ci.yml', import.meta.url), 'utf8');
for (const job of ['mirror-gitlab', 'mirror-github']) {
  const config = ci.split(`\n${job}:\n`)[1].split(/\n[a-z][a-z-]*:\n/)[0];
  test(`${job} filters annotated tags and branches before publication`, () => {
    const prefix = config.match(/git filter-branch[^\n]*?(?= --tree-filter)/)?.[0];
    assert.equal(prefix, 'git filter-branch --tag-name-filter cat');
    const filter = config.match(/git filter-branch[\s\S]*? -- --all/)?.[0];
    assert.ok(filter, 'Use the actual CI tree filter, including its shell quoting');
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
      mkdirSync(join(cwd, 'deploy-agent'));
      writeFileSync(join(cwd, 'deploy-agent/deploy.sh'), 'private deployment script\n');
      writeFileSync(join(cwd, 'docker-compose.yml'), 'services:\n  app:\n    image: public\n  deploy-agent:\n    image: private\n  redis:\n    image: redis\n');
      const session = '## Codex Session\n\nResume the development session:\n\n```sh\ncodex resume private-session-id\n```\n\n';
      const publicReadme = '# Project\n\nPublic description without a following heading.\n\n## Features\n\n```sh\nyarn install\n```\n';
      const cases = [
        { source: publicReadme, expected: publicReadme },
        { source: '# Project\n\n' + session + publicReadme.slice('# Project\n\n'.length), expected: '# Project\n\n\n' + publicReadme.slice('# Project\n\n'.length) },
        { source: publicReadme + '\n' + session, expected: publicReadme },
        { source: '# Project\n\n## Codex Session\n\n## Features\n\nPublic features\n', expected: '# Project\n\n## Features\n\nPublic features\n' },
        { source: '# Project\n\n## Codex Session\n\ncodex resume private-session-id\n\nPublic description\n', expected: '# Project\n\n\nPublic description\n' },
      ];
      const originals = [];
      for (const [index, entry] of cases.entries()) {
        writeFileSync(join(cwd, 'README.md'), entry.source);
        git('add', '.'); git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Synthetic source ' + index);
        originals.push(git('rev-parse', 'HEAD'));
        if (index === 1) git('branch', 'feature');
      }
      git('-c', 'tag.gpgsign=false', 'tag', '-a', 'v1.0.0', '-m', 'Synthetic release');
      const result = spawnSync('sh', ['-c', filter], { cwd, env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      for (const ref of ['master', 'feature', 'v1.0.0']) {
        const probe = spawnSync('git', ['cat-file', '-e', `${ref}:.gitlab-ci.yml`], { cwd, env });
        assert.notEqual(probe.status, 0);
        const deploy = spawnSync('git', ['cat-file', '-e', `${ref}:deploy-agent/deploy.sh`], { cwd, env });
        assert.notEqual(deploy.status, 0);
        assert.doesNotMatch(git('show', `${ref}:README.md`), /Codex Session|private-session-id|codex resume/);
        assert.equal(git('show', `${ref}:docker-compose.yml`), 'services:\n  app:\n    image: public\n  redis:\n    image: redis');
      }
      const history = git('rev-list', '--reverse', 'master').split('\n');
      assert.equal(history.length, cases.length);
      for (const [index, ref] of history.entries()) {
        assert.equal(git('show', `${ref}:README.md`), cases[index].expected.trim());
        assert.equal(git('show', `${originals[index]}:README.md`), cases[index].source.trim(), 'Original source objects must remain unchanged');
      }
      assert.equal(git('cat-file', '-t', 'v1.0.0'), 'tag');
      assert.equal(git('rev-parse', 'master'), git('rev-parse', 'v1.0.0^{}'));
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
  test(`${job} leaves a checkout without README.md unchanged`, () => {
    const block = config.match(/if \[ -f README\.md \]; then[\s\S]*?\n\s*fi/)?.[0];
    assert.ok(block);
    const cwd = mkdtempSync(join(tmpdir(), 'flix-filter-missing-readme-'));
    try {
      const result = spawnSync('sh', ['-c', block.replaceAll(`'"'"'`, "'")], { cwd, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
  test(`${job} uses a CI skip option only for the GitLab mirror`, () => {
    const push = config.split('\n').find(line => line.includes('git push'));
    assert.match(push, /\+refs\/heads\/\*:refs\/heads\/\* \+refs\/tags\/\*:refs\/tags\/\*/);
    if (job === 'mirror-gitlab') assert.match(push, / -o ci\.skip /);
    else assert.doesNotMatch(push, /ci\.skip/);
  });
}
