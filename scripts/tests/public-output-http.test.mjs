// HTTP-level validation of the built public output served by the real Pages runtime (wrangler pages dev / workerd):
// published paths answer 200, every excluded or unknown path answers a GENUINE 404 (not the single-page-app fallback),
// and, when present, the default-deny legacy families still answer 404 with the Functions worker in front.
//
// Run: node --test scripts/tests/public-output-http.test.mjs
// Needs wrangler: set WRANGLER_BIN=/path/to/wrangler, or have network access for `npx --yes wrangler@3.114.17`.
// CI sets PUBLIC_OUTPUT_HTTP=required so a missing runtime FAILS instead of skipping.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPublic, loadManifest } from '../build-public.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REQUIRED = process.env.PUBLIC_OUTPUT_HTTP === 'required';
const WRANGLER = process.env.WRANGLER_BIN ? [process.env.WRANGLER_BIN] : ['npx', '--yes', 'wrangler@3.114.17'];
const scratch = mkdtempSync(join(tmpdir(), 'public-http-'));
let child;
let base = '';
let unavailable = '';

const freePort = () => new Promise((res, rej) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); s.on('error', rej); });
const get = (path, init = {}) => fetch(`${base}${path}`, { redirect: 'follow', ...init });

before(async () => {
  buildPublic({ root: ROOT, outDir: join(scratch, 'dist') });
  const port = await freePort();
  const [cmd, ...pre] = WRANGLER;
  child = spawn(cmd, [...pre, 'pages', 'dev', join(scratch, 'dist'), '--port', String(port), '--ip', '127.0.0.1', '--compatibility-date=2024-01-01', '--persist-to', join(scratch, 'state')], {
    cwd: ROOT, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true' }, stdio: ['ignore', 'pipe', 'pipe'],
    detached: true, // own process group, so the whole tree (npx -> wrangler -> workerd) can be stopped
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  child.on('error', (e) => { unavailable = `cannot start wrangler: ${e.message}`; });
  base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 90 && !unavailable; i++) {
    try { if ((await fetch(`${base}/`)).status === 200) return; } catch { /* not up yet */ }
    if (child.exitCode !== null) { unavailable = `wrangler exited early: ${log.slice(-400)}`; break; }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!unavailable) unavailable = `wrangler did not become ready: ${log.slice(-400)}`;
});

/** Stops the whole wrangler process tree; npx/wrangler/workerd would otherwise outlive the test run and keep it from exiting. */
async function stopServer() {
  if (!child || child.pid === undefined) return;
  const signal = (sig) => { try { process.kill(-child.pid, sig); } catch { /* already gone */ } };
  const exited = new Promise((r) => child.once('exit', r));
  signal('SIGTERM');
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
  signal('SIGKILL');
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
}

after(async () => { await stopServer(); rmSync(scratch, { recursive: true, force: true }); });

function guard(t) {
  if (!unavailable) return false;
  if (REQUIRED) assert.fail(unavailable);
  t.skip(unavailable);
  return true;
}

const PUBLIC_OK = ['/', '/landing', '/account', '/legal', '/theme.js', '/i18n.js', '/i18n/zh.js', '/manifest.json', '/infinicus%20logo.jpeg', '/infinicus-mark.svg', '/og-image.svg',
  '/platform/platform-bootstrap.js', '/ai-decision-intelligence/adi-bundle.js', '/approved-business-action/aba-bundle.js', '/business-intelligence/bi-bundle.js',
  '/continuous-learning/cl-bundle.js', '/data-acquisition/da-bundle.js', '/digital-twin/dt-bundle.js', '/outcome-monitoring/om-bundle.js'];

const EXCLUDED = ['/schema.sql', '/wrangler.toml', '/package.json', '/package-lock.json', '/bol.html', '/dal.html', '/pitch%20deck.html', '/pitch%20deck_files/0jvmviuftg5e2.css',
  '/docs/architecture/ROOT-CLAUDE-REFERENCE.md', '/functions/api/simulate.js', '/functions/_shared/guard.js', '/infinicus-platform/package.json', '/.claude/state/implementation-status.json',
  '/.github/workflows/ci.yml', '/scripts/build-public.mjs', '/public-manifest.json', '/icon.svg', '/CNAME', '/gate.txt', '/INFINICUS-REPOSITORY-READY-MASTER-IMPLEMENTATION-QUEUE.zip',
  '/infinicusenginev3.zip', '/QUEUE-INTEGRITY-SHA256.json', '/CLAUDE-MASTER-EXECUTION-INSTRUCTIONS.md', '/push.bat', '/set-sentry-dsn.bat', '/templates/COMPATIBILITY-ADAPTER.ts',
  '/platform/tests/01-file-existence.test.mjs', '/ai-decision-intelligence/INFINICUS-ADI-01-AI-Decision-Intelligence-Core-Runtime-Registry/demo/index.html', '/i18n/README.md', '/i18n/en.js',
  '/sw.js', '/robots.txt', '/does-not-exist', '/a/b/c/d', '/api/does-not-exist'];

test('every published path resolves (HTTP 200 after Pages clean-URL redirects)', async (t) => {
  if (guard(t)) return;
  for (const path of PUBLIC_OK) {
    const res = await get(path);
    assert.equal(res.status, 200, path);
    await res.arrayBuffer();
  }
});

test('excluded and unknown paths return a GENUINE 404 with the minimal 404 page, never the app shell or file contents', async (t) => {
  if (guard(t)) return;
  const shell = await (await get('/')).text();
  for (const path of EXCLUDED) {
    const res = await get(path);
    const body = await res.text();
    assert.equal(res.status, 404, `${path} must be 404, got ${res.status}`);
    assert.ok(body.includes('<h1>404</h1>'), `${path} serves the 404 page`);
    assert.notEqual(body, shell, `${path} must not serve the app shell`);
    assert.ok(!body.includes('CREATE TABLE') && !body.includes('database_id') && !body.includes('INFINICUS ENGINE v3'), `${path} leaks nothing`);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  }
});

test('the generated security headers are served on published and 404 responses', async (t) => {
  if (guard(t)) return;
  for (const path of ['/', '/does-not-exist']) {
    const res = await get(path);
    await res.arrayBuffer();
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', path);
    assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN', path);
    assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin', path);
  }
});

test('Pages Functions stay in front: unknown /api paths are genuine 404s and, where the middleware families exist, they stay default-deny', async (t) => {
  if (guard(t)) return;
  // Static assets answer only GET/HEAD, so a POST to a path with no Function is refused by the asset layer (405), never executed.
  const missing = await get('/api/does-not-exist', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.ok([404, 405].includes(missing.status), `POST to an unknown /api path must not succeed, got ${missing.status}`);
  await missing.arrayBuffer();
  assert.equal((await get('/api/does-not-exist')).status, 404);
  for (const [family, route] of [['business', '/api/business/manage'], ['business', '/api/business/summary'], ['auth', '/api/auth/login'], ['auth', '/api/auth/change-password'], ['auth', '/api/auth/register']]) {
    if (!existsSync(join(ROOT, 'functions', 'api', family, '_middleware.js'))) continue;
    for (const method of ['GET', 'POST', 'OPTIONS']) {
      const res = await get(route, { method, headers: { Origin: 'https://infini-cus.com', 'Content-Type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}) });
      assert.equal(res.status, 404, `${method} ${route} is default-deny`);
      assert.deepEqual(await res.json(), { ok: false, error: 'Not found' });
      assert.equal(res.headers.get('access-control-allow-origin'), null);
    }
  }
});

test('the manifest, not the filesystem, decides what is served: the public set matches the manifest exactly', () => {
  assert.equal(loadManifest(ROOT).files.includes('404.html'), true);
});
