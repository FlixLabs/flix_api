import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, cpSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '../..');
function fixture(t, version = '3.0.0') {
  const dir = mkdtempSync(join(tmpdir(), 'flix-release-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(join(root, 'scripts'), join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version }, null, 2));
  mkdirSync(join(dir, 'bin'));
  return dir;
}
function run(dir, command, args = [], env = {}) {
  return spawnSync(command, args, { cwd: dir, encoding: 'utf8', env: {
    ...process.env, PATH: `${dir}/bin:${process.env.PATH}`,
    CI_COMMIT_BRANCH: 'master', CI_DEFAULT_BRANCH: 'master',
    CI_JOB_TOKEN: 'test-only', CI_API_V4_URL: 'https://gitlab.invalid/api/v4', CI_PROJECT_ID: '1',
    ...env,
  } });
}
function git(dir, ...args) {
  const result = run(dir, 'git', args);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function repository(t) {
  const dir = fixture(t);
  git(dir, 'init', '-b', 'master');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@flix.invalid');
  git(dir, 'add', '.');
  git(dir, '-c', 'commit.gpgSign=false', 'commit', '-m', 'Initial');
  git(dir, 'init', '--bare', 'remote.git');
  git(dir, 'remote', 'add', 'origin', join(dir, 'remote.git'));
  writeFileSync(join(dir, 'bin/curl'), '#!/bin/sh\nprintf "%s\\n" "$*" >> trigger.log\nprintf 201\n', { mode: 0o755 });
  return dir;
}

test('reads stable SemVer and rejects invalid versions', t => {
  for (const version of ['3.0.0', '1.0.2', '0.1.0']) {
    const result = run(fixture(t, version), 'sh', ['scripts/read-version.sh']);
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), version);
  }
  for (const version of ['', '03.0.0', '3.0', '3.0.0-beta', 'latest']) {
    assert.notEqual(run(fixture(t, version), 'sh', ['scripts/read-version.sh']).status, 0);
  }
});

test('creates an annotated tag and explicitly triggers its pipeline', t => {
  const dir = repository(t);
  const result = run(dir, 'sh', ['scripts/create-release-tag.sh']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(git(dir, 'cat-file', '-t', 'v3.0.0'), 'tag');
  assert.equal(git(dir, 'rev-list', '-n', '1', 'v3.0.0'), git(dir, 'rev-parse', 'HEAD'));
  assert.match(readFileSync(join(dir, 'trigger.log'), 'utf8'), /ref=v3\.0\.0/);
});

test('retries an existing tag pipeline without moving the tag', t => {
  const dir = repository(t);
  assert.equal(run(dir, 'sh', ['scripts/create-release-tag.sh']).status, 0);
  const tag = git(dir, 'rev-parse', 'v3.0.0');
  assert.equal(run(dir, 'sh', ['scripts/create-release-tag.sh']).status, 0);
  assert.equal(git(dir, 'rev-parse', 'v3.0.0'), tag);
  assert.equal(readFileSync(join(dir, 'trigger.log'), 'utf8').trim().split('\n').length, 2);
});

test('does not rerelease a version on a different commit', t => {
  const dir = repository(t);
  assert.equal(run(dir, 'sh', ['scripts/create-release-tag.sh']).status, 0);
  const tag = git(dir, 'rev-parse', 'v3.0.0');
  git(dir, '-c', 'commit.gpgSign=false', 'commit', '--allow-empty', '-m', 'Another change');
  assert.equal(run(dir, 'sh', ['scripts/create-release-tag.sh']).status, 0);
  assert.equal(git(dir, 'rev-parse', 'v3.0.0'), tag);
  assert.equal(readFileSync(join(dir, 'trigger.log'), 'utf8').trim().split('\n').length, 1);
});

test('refuses release tagging outside the default branch', t => {
  const dir = fixture(t);
  const result = run(dir, 'sh', ['scripts/create-release-tag.sh'], { CI_COMMIT_BRANCH: 'feature/test' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /default branch/);
});

test('deployment validates the token and release tag before using Docker', t => {
  const dir = fixture(t);
  const script = join(root, 'deploy-agent/deploy.sh');
  for (const args of [['wrong', 'v3.0.0'], ['secret'], ['secret', 'latest'], ['secret', 'v03.0.0']]) {
    const result = run(dir, 'sh', [script, ...args], { DEPLOY_TOKEN: 'secret' });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stderr, /docker/);
  }
});

test('deployment overrides only the image tag, including registry ports', t => {
  const dir = fixture(t);
  writeFileSync(join(dir, 'bin/docker'), `#!/bin/sh
printf '%s|%s|%s\n' "$*" "\${APP_IMAGE:-}" "\${API_IMAGE:-}" >> docker.log
case "$*" in
  'compose config --images '* ) printf '%s\n' "$TEST_IMAGE" ;;
  'compose ps -q api') printf '\n' ;;
esac
`, { mode: 0o755 });
  const isApi = JSON.parse(readFileSync(join(root, 'package.json'))).name === 'flix_api';
  const service = isApi ? 'api' : 'app';
  for (const image of ['registry.test:5050/flix/image:latest', 'registry.test:5050/flix/image', 'registry.test:5050/flix/image@sha256:abcdef']) {
    const result = run(dir, 'sh', [join(root, 'deploy-agent/deploy.sh'), 'secret', 'v3.0.0'], {
      DEPLOY_TOKEN: 'secret', TEST_IMAGE: image, REGISTRY_URL: '',
    });
    // API copying must fail safely when Docker reports no container.
    assert.equal(result.status, isApi ? 1 : 0, result.stderr);
    const log = readFileSync(join(dir, 'docker.log'), 'utf8');
    assert.match(log, new RegExp(`compose pull ${service}\\|.*registry.test:5050/flix/image:v3.0.0`));
    assert.match(log, new RegExp(`compose up -d --no-deps ${service}\\|`));
    writeFileSync(join(dir, 'docker.log'), '');
  }
});

test('quality is independent from production secrets and image publishing', () => {
  const ci = readFileSync(join(root, '.gitlab-ci.yml'), 'utf8');
  const quality = ci.split('\nquality:\n')[1].split('\ncreate_release_tag:')[0];
  assert.match(quality, /sh scripts\/build-quality\.sh/);
  assert.doesNotMatch(quality, /extends:|VITE_|docker login|docker push/);
  const dockerfile = readFileSync(join(root, 'Dockerfile.quality'), 'utf8');
  assert.doesNotMatch(dockerfile, /ARG VITE_|ENV VITE_|COPY .*\.env/);
  assert.match(dockerfile, /yarn test:ci && yarn test/);
  const build = ci.split('\nbuild:\n')[1].split('\ndeploy:')[0];
  assert.match(build, /extends: \.build-image/);
  assert.match(build, /CI_COMMIT_TAG/);
  assert.doesNotMatch(build, /merge_request_event|CI_COMMIT_BRANCH/);
});

test('quality restores the root ignore file after successful and failed builds', t => {
  const dir = fixture(t);
  const original = '.env\ndeploy-agent\n';
  const quality = '.env\ndeploy-agent/*\n!deploy-agent/deploy.sh\n';
  writeFileSync(join(dir, '.dockerignore'), original);
  writeFileSync(join(dir, 'Dockerfile.quality.dockerignore'), quality);
  writeFileSync(join(dir, 'bin/docker'), '#!/bin/sh\ncp .dockerignore observed-ignore\nexit "$BUILD_EXIT"\n', { mode: 0o755 });
  for (const status of [0, 1]) {
    const result = run(dir, 'sh', ['scripts/build-quality.sh'], { BUILD_EXIT: String(status) });
    assert.equal(result.status, status, result.stderr);
    assert.equal(readFileSync(join(dir, 'observed-ignore'), 'utf8'), quality);
    assert.equal(readFileSync(join(dir, '.dockerignore'), 'utf8'), original);
  }
});
