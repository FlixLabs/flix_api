import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';

const require = createRequire(import.meta.url);
const expressRequire = createRequire(require.resolve('express'));
const proxyaddr = expressRequire('proxy-addr');
const routerRequire = createRequire(expressRequire.resolve('router'));
const { pathToRegexp } = routerRequire('path-to-regexp');

// Exercise the dependency used by Express, not an unrelated copy from tooling.
test('a malformed mapped IPv6 trust subnet does not trust an unrelated IPv4 client', () => {
  let trust;
  try { trust = proxyaddr.compile(['::ffff:10.0.0.0/8']); }
  catch (error) { assert.ok(error instanceof Error); return; }
  assert.equal(trust('203.0.113.25', 0), false);
});

test('ordinary IPv4 proxy subnets retain their expected trust boundary', () => {
  const trust = proxyaddr.compile(['10.0.0.0/8']);
  assert.equal(trust('10.2.3.4', 0), true);
  assert.equal(trust('203.0.113.25', 0), false);
});

test('JSON parsers reject invalid limits instead of disabling request size enforcement', () => {
  for (const limit of ['not-a-size', NaN]) assert.throws(() => express.json({ limit }));
  assert.equal(typeof express.json(), 'function');
});

test('compressed trailing bytes cannot terminate the HTTP process', () => {
  // An unhandled decoder error must fail only the disposable child, not this test runner.
  const program = `
    import assert from 'node:assert/strict';
    import express from 'express';
    import { gzipSync } from 'node:zlib';
    import { setImmediate } from 'node:timers/promises';
    const app = express();
    app.use(express.json());
    app.get('/health', (_req, res) => res.json({ ok: true }));
    app.post('/', (req, res) => res.json(req.body));
    app.use((error, _req, res, _next) => res.status(error.status || 500).end());
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const url = 'http://127.0.0.1:' + server.address().port;
    try {
      const body = Buffer.concat([gzipSync(Buffer.from(JSON.stringify({ probe: 'test' }))), Buffer.from([0x1f, 0x8b])]);
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }, body, signal: AbortSignal.timeout(3000) });
      await response.text();
      assert.ok(response.status === 200 || response.status === 400);
      await setImmediate();
      await setImmediate();
      const health = await fetch(url + '/health', { signal: AbortSignal.timeout(3000) });
      assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), { ok: true });
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

test('excessive optional path combinations are bounded before regex expansion', () => {
  assert.throws(() => pathToRegexp('/' + '{a}'.repeat(20) + ':value'), /Too many path combinations/);
});
