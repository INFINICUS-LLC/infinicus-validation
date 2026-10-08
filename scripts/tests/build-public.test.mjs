// Tests for scripts/build-public.mjs and public-manifest.json. Run: node --test scripts/tests/build-public.test.mjs
// Real-repository tests prove the actual publication set; fixture tests prove each failure mode fails closed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  analyzeClosure, buildPublic, compareRoutes, denyReason, discoverFunctionRoutes, extractReferences, languageCodes,
  loadManifest, PublicOutputError, renderHeaders, renderRoutes, routeMatches, safeRelativePath, treeDigest,
  validateAll, validateFunctionRouting, validateHeaders, validateManifest, validateRoutes, verifyOutput,
} from '../build-public.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmp = () => mkdtempSync(join(tmpdir(), 'public-output-'));
const cleanup = (...dirs) => dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
const list = (dir) => {
  const out = [];
  const visit = (d) => readdirSync(d).forEach((n) => { const p = join(d, n); lstatSync(p).isDirectory() ? visit(p) : out.push(relative(dir, p).split('\\').join('/')); });
  visit(dir);
  return out.sort();
};

/** A minimal valid repository (one page, one script, one Function) for failure-mode tests. */
function fixture(overrides = {}) {
  const root = tmp();
  const write = (rel, text) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };
  write('index.html', '<link rel="icon" href="/mark.svg"><script src="/app.js"></script><a href="./other.html">x</a>');
  write('other.html', '<p>other</p>');
  write('app.js', 'console.log(1)');
  write('mark.svg', '<svg/>');
  write('functions/api/hello.js', 'export async function onRequestGet() { return new Response("ok"); }');
  write('functions/_shared/util.js', 'export const x = 1;');
  write('secret.sql', 'CREATE TABLE t(x);');
  const manifest = {
    schemaVersion: 1,
    outputDir: 'dist',
    files: ['app.js', 'index.html', 'mark.svg', 'other.html'],
    knownMissingReferences: [],
    deny: { directories: ['docs', 'functions'], extensions: ['.sql'], basenames: ['package.json'], directoryPrefixes: [] },
    headers: [{ pattern: '/*', values: { 'X-Content-Type-Options': 'nosniff' } }],
    routes: { version: 1, include: ['/api/*'], exclude: ['/api/_shared/*'] },
    ...overrides,
  };
  write('public-manifest.json', JSON.stringify(manifest));
  return { root, write, manifest };
}

// ── the real repository ────────────────────────────────────────────────────────────────────────────

test('the real manifest and static dependency closure are valid', () => {
  assert.deepEqual(validateAll(ROOT), []);
});

test('the real build publishes exactly the declared files plus _headers and _routes.json', () => {
  const out = tmp();
  try {
    const manifest = loadManifest(ROOT);
    const { files } = buildPublic({ root: ROOT, outDir: join(out, 'dist') });
    assert.equal(files, manifest.files.length + 2);
    assert.deepEqual(list(join(out, 'dist')), [...manifest.files, '_headers', '_routes.json'].sort());
    assert.deepEqual(verifyOutput(join(out, 'dist'), manifest), []);
  } finally { cleanup(out); }
});

test('published bytes equal the source bytes (nothing is rewritten)', () => {
  const out = tmp();
  try {
    buildPublic({ root: ROOT, outDir: join(out, 'dist') });
    for (const f of loadManifest(ROOT).files) assert.ok(readFileSync(join(ROOT, f)).equals(readFileSync(join(out, 'dist', f))), f);
  } finally { cleanup(out); }
});

test('the build is deterministic and idempotent', () => {
  const a = tmp(); const b = tmp();
  try {
    const first = buildPublic({ root: ROOT, outDir: join(a, 'dist') });
    const second = buildPublic({ root: ROOT, outDir: join(b, 'dist') });
    assert.equal(first.digest, second.digest);
    assert.equal(treeDigest(join(a, 'dist')), first.digest);
  } finally { cleanup(a, b); }
});

test('the public set is the approved set: pages, localisation, bundles, branding only', () => {
  const { files } = loadManifest(ROOT);
  const approved = [
    'index.html', 'landing.html', 'account.html', 'legal.html', 'theme.js', 'i18n.js', 'manifest.json',
    'infinicus-mark.svg', 'og-image.svg', 'infinicus logo.jpeg', 'platform/platform-bootstrap.js',
  ];
  for (const f of approved) assert.ok(files.includes(f), `${f} must be public`);
  assert.equal(files.filter((f) => /^i18n\/[a-z]{2}\.js$/.test(f)).length, 19);
  assert.equal(files.filter((f) => /-bundle\.js$/.test(f)).length, 7);
  assert.equal(files.length, approved.length + 19 + 7);
});

test('internal-by-default assets are not published and cannot be declared', () => {
  const { files, deny } = loadManifest(ROOT);
  const internal = [
    'bol.html', 'dal.html', 'pitch deck.html', 'pitch deck_files/0jvmviuftg5e2.css', 'icon.svg', 'schema.sql', 'wrangler.toml',
    'package.json', 'package-lock.json', 'push.bat', 'set-sentry-dsn.bat', 'gate.txt', 'CNAME',
    'infinicusenginev3.zip', 'INFINICUS-REPOSITORY-READY-MASTER-IMPLEMENTATION-QUEUE.zip', 'QUEUE-INTEGRITY-SHA256.json',
    'CLAUDE-MASTER-EXECUTION-INSTRUCTIONS.md', 'INSTALL-INTO-REPOSITORY.md', 'public-manifest.json', 'scripts/build-public.mjs',
    'docs/architecture/ROOT-CLAUDE-REFERENCE.md', '.claude/state/implementation-status.json', '.github/workflows/ci.yml',
    'infinicus-platform/package.json', 'infinicus-platform/.env.example', 'infinicus-platform/infrastructure/database/migrations/0001_x.sql',
    'functions/api/simulate.js', 'functions/_shared/rateLimit.js', 'templates/COMPATIBILITY-ADAPTER.ts', 'platform/tests/01-file-existence.test.mjs',
    'ai-decision-intelligence/INFINICUS-ADI-01/demo/index.html', 'i18n/README.md', 'x.env',
  ];
  for (const f of internal) {
    assert.ok(!files.includes(f), `${f} must not be published`);
    if (!f.startsWith('ai-decision-intelligence/') && f !== 'public-manifest.json') assert.ok(denyReason(f, deny), `${f} must be rejected by the deny rules`);
  }
  for (const f of files) assert.equal(denyReason(f, deny), null, `${f} must pass the deny rules`);
});

test('every internal path that exists in the repository is absent from the built output', () => {
  const out = tmp();
  try {
    buildPublic({ root: ROOT, outDir: join(out, 'dist') });
    const built = new Set(list(join(out, 'dist')));
    for (const dir of ['docs', '.claude', '.github', 'infinicus-platform', 'functions', 'scripts', 'templates', 'pitch deck_files']) assert.ok(![...built].some((p) => p === dir || p.startsWith(`${dir}/`)), dir);
    for (const f of ['schema.sql', 'wrangler.toml', 'package.json', 'package-lock.json', 'bol.html', 'dal.html', 'pitch deck.html', 'icon.svg', 'CNAME', 'gate.txt']) assert.ok(!built.has(f), f);
    assert.ok([...built].every((p) => !/\.(sql|zip|bat|toml|md|ts|mjs|download)$/.test(p)));
  } finally { cleanup(out); }
});

test('shipped pages resolve every essential resource', () => {
  const manifest = loadManifest(ROOT);
  const { problems, references } = analyzeClosure(ROOT, manifest);
  assert.deepEqual(problems, []);
  const targets = new Set(references.map((r) => r.target));
  for (const t of ['theme.js', 'i18n.js', 'infinicus-mark.svg', 'og-image.svg', 'legal.html', 'landing.html', 'account.html', 'index.html', 'manifest.json', 'infinicus logo.jpeg',
    'platform/platform-bootstrap.js', 'digital-twin/dt-bundle.js', 'i18n/zh.js', 'i18n/ur.js']) assert.ok(targets.has(t), `${t} must be reached from the shipped pages`);
});

test('every localisation language declared by i18n.js has a published file, and "en" is built in', () => {
  const codes = languageCodes(readFileSync(join(ROOT, 'i18n.js'), 'utf8'));
  assert.equal(codes.length, 20);
  const { files } = loadManifest(ROOT);
  for (const c of codes.filter((x) => x !== 'en')) assert.ok(files.includes(`i18n/${c}.js`), c);
  assert.ok(!files.includes('i18n/en.js'));
});

test('the only tolerated dangling reference is the documented, pre-existing sw.js', () => {
  const manifest = loadManifest(ROOT);
  assert.deepEqual(manifest.knownMissingReferences.map((k) => k.ref), ['sw.js']);
  assert.ok(!existsSync(join(ROOT, 'sw.js')));
});

test('no shipped file links to an internal page', () => {
  for (const f of loadManifest(ROOT).files.filter((x) => x.endsWith('.html'))) {
    const text = readFileSync(join(ROOT, f), 'utf8');
    for (const internal of ['bol.html', 'dal.html', 'pitch deck']) assert.ok(!new RegExp(`(?:href|src)\\s*=\\s*["'][^"']*${internal}`, 'i').test(text), `${f} links to ${internal}`);
  }
});

test('Pages Functions stay discoverable and are covered by the generated routing', () => {
  const manifest = loadManifest(ROOT);
  const routes = discoverFunctionRoutes(ROOT);
  assert.equal(routes.length, 21);
  for (const r of ['/api/simulate', '/api/waitlist', '/api/send-email', '/api/nurture-batch', '/api/business/manage', '/api/business/decisions/recommend', '/api/auth/login']) assert.ok(routes.includes(r), r);
  assert.ok(!routes.some((r) => r.includes('_shared')));
  assert.deepEqual(validateFunctionRouting(ROOT, manifest.routes), []);
});

test('generated _routes.json preserves the existing routing contract', () => {
  const { routes } = loadManifest(ROOT);
  assert.deepEqual(routes, { version: 1, include: ['/api/*'], exclude: ['/api/_shared/*'] });
  // The repository-root _routes.json (still used by a root-published project) must stay identical to what dist/ gets.
  assert.deepEqual(JSON.parse(renderRoutes(routes)), JSON.parse(readFileSync(join(ROOT, '_routes.json'), 'utf8')));
  assert.deepEqual(validateRoutes(routes), []);
});

test('the redundant functions/_routes.json is gone and nothing refers to it', () => {
  assert.ok(!existsSync(join(ROOT, 'functions', '_routes.json')));
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
  for (const f of tracked) {
    if (f.startsWith('infinicus-platform/') || /\.(zip|jpeg|png|download)$/.test(f) || f === 'scripts/tests/build-public.test.mjs') continue;
    assert.ok(!readFileSync(join(ROOT, f), 'utf8').includes('functions/_routes.json') || f.startsWith('docs/deployment/'), `${f} refers to functions/_routes.json`);
  }
});

test('generated _headers is valid and carries the baseline security headers', () => {
  const { headers } = loadManifest(ROOT);
  assert.deepEqual(validateHeaders(headers), []);
  const text = renderHeaders(headers);
  for (const h of ['X-Content-Type-Options: nosniff', 'Referrer-Policy: strict-origin-when-cross-origin', 'X-Frame-Options: SAMEORIGIN', 'Permissions-Policy:']) assert.ok(text.includes(h), h);
  assert.ok(text.startsWith('/*\n'));
});

test('the dependency lockfile is present, v3 and pins the only dependency', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));
  assert.equal(lock.lockfileVersion, 3);
  assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies);
  assert.match(lock.packages['node_modules/@anthropic-ai/sdk'].version, /^0\.39\./);
  for (const [name, p] of Object.entries(lock.packages)) if (name) { assert.ok(p.integrity, `${name} has an integrity hash`); assert.match(p.resolved, /^https:\/\/registry\.npmjs\.org\//, name); }
});

// ── failure modes (fixtures) ───────────────────────────────────────────────────────────────────────

test('a fixture repository builds and rebuilds cleanly (control)', () => {
  const { root } = fixture();
  const out = tmp();
  try {
    assert.deepEqual(validateAll(root), []);
    assert.equal(buildPublic({ root, outDir: join(out, 'd') }).files, 6);
    assert.deepEqual(list(join(out, 'd')), ['_headers', '_routes.json', 'app.js', 'index.html', 'mark.svg', 'other.html']);
  } finally { cleanup(root, out); }
});

test('an undeclared static file referenced by a published page is rejected (internal by default)', () => {
  const { root, write } = fixture();
  write('index.html', '<script src="/app.js"></script><link rel="icon" href="/mark.svg"><a href="./other.html">x</a><a href="./secret.sql">leak</a>');
  try {
    const problems = validateAll(root);
    assert.ok(problems.some((p) => p.includes('secret.sql') && p.includes('NOT declared public')), problems.join('\n'));
    assert.throws(() => buildPublic({ root, outDir: join(root, 'o') }), PublicOutputError);
    assert.ok(!existsSync(join(root, 'o')), 'a failed build must write nothing');
  } finally { cleanup(root); }
});

test('a reference to a missing file is rejected unless documented as known-missing', () => {
  const { root, write } = fixture();
  write('index.html', '<script src="/app.js"></script><script src="/gone.js"></script><link href="/mark.svg"><a href="other.html"></a>');
  try {
    assert.ok(validateAll(root).some((p) => p.includes('gone.js') && p.includes('does not exist')));
  } finally { cleanup(root); }
  const f2 = fixture({ knownMissingReferences: [{ ref: 'gone.js', referencedFrom: ['index.html'], note: 'documented' }] });
  f2.write('index.html', '<script src="/app.js"></script><script src="/gone.js"></script><link href="/mark.svg"><a href="other.html"></a>');
  try { assert.deepEqual(validateAll(f2.root), []); } finally { cleanup(f2.root); }
});

test('a stale known-missing entry (file now exists, or no longer referenced) is rejected', () => {
  const stale = fixture({ knownMissingReferences: [{ ref: 'app.js', referencedFrom: ['index.html'], note: 'x' }] });
  const unused = fixture({ knownMissingReferences: [{ ref: 'never.js', referencedFrom: ['index.html'], note: 'x' }] });
  try {
    assert.ok(validateAll(stale.root).some((p) => p.includes('now exists')));
    assert.ok(validateAll(unused.root).some((p) => p.includes('no longer referenced')));
  } finally { cleanup(stale.root, unused.root); }
});

test('internal and sensitive files cannot be declared public', () => {
  for (const bad of ['secret.sql', 'functions/api/hello.js', 'docs/a.html', 'package.json', '.env', 'x.test.js']) {
    const { root, write } = fixture();
    write(bad, 'x');
    const manifest = loadManifest(root);
    manifest.files = [...manifest.files, bad].sort();
    try { assert.ok(validateManifest(manifest, root).some((p) => p.includes(bad) && p.includes('not publishable')), bad); } finally { cleanup(root); }
  }
});

test('unsafe, duplicate, unsorted, missing, generated and symlinked entries are rejected', () => {
  const { root } = fixture();
  symlinkSync(join(root, 'app.js'), join(root, 'link.js'));
  try {
    const m = loadManifest(root);
    const check = (files) => validateManifest({ ...m, files }, root).join('\n');
    assert.match(check(['../etc/passwd', ...m.files].sort()), /unsafe or non-normalised/);
    assert.match(check(['/abs.js']), /unsafe or non-normalised/);
    assert.match(check(['a\\b.js']), /unsafe or non-normalised/);
    assert.match(check(['./app.js']), /unsafe or non-normalised/);
    assert.match(check([...m.files, 'app.js'].sort()), /duplicate entry/);
    assert.match(check([...m.files].reverse()), /must be sorted/);
    assert.match(check([...m.files, 'ghost.js'].sort()), /does not exist/);
    assert.match(check([...m.files, '_headers'].sort()), /generated/);
    assert.match(check([...m.files, 'link.js'].sort()), /symlink/);
  } finally { cleanup(root); }
});

test('a tampered output (extra, internal or missing file) is detected', () => {
  const { root, manifest } = fixture();
  const out = tmp();
  try {
    const dist = join(out, 'd');
    buildPublic({ root, outDir: dist });
    writeFileSync(join(dist, 'extra.txt'), 'x');
    writeFileSync(join(dist, 'schema.sql'), 'x');
    rmSync(join(dist, 'app.js'));
    const problems = verifyOutput(dist, manifest).join('\n');
    assert.match(problems, /undeclared file: extra\.txt/);
    assert.match(problems, /internal file: schema\.sql|undeclared file: schema\.sql/);
    assert.match(problems, /missing app\.js/);
  } finally { cleanup(root, out); }
});

test('a Function route not covered by the generated routing is rejected', () => {
  const { root } = fixture({ routes: { version: 1, include: ['/other/*'], exclude: [] } });
  try {
    assert.ok(validateAll(root).some((p) => p.includes('/api/hello') && p.includes('not covered')));
    const excluded = fixture({ routes: { version: 1, include: ['/api/*'], exclude: ['/api/hello'] } });
    assert.ok(validateAll(excluded.root).some((p) => p.includes('matched by routes.exclude')));
    cleanup(excluded.root);
  } finally { cleanup(root); }
});

test('routing and header validators reject malformed configuration', () => {
  assert.ok(validateRoutes({ version: 2, include: ['/a'], exclude: [] }).length);
  assert.ok(validateRoutes({ version: 1, include: [], exclude: [] }).length);
  assert.ok(validateRoutes({ version: 1, include: ['api/*'], exclude: [] }).length);
  assert.ok(validateRoutes({ version: 1, include: Array.from({ length: 101 }, (_, i) => `/r${i}`), exclude: [] }).length);
  assert.ok(validateHeaders([{ pattern: '/*', values: { 'Bad Name': 'x' } }]).length);
  assert.ok(validateHeaders([{ pattern: '/*', values: { 'X-A': 'line\nbreak' } }]).length);
  assert.ok(validateHeaders([]).length);
  assert.ok(validateHeaders([{ pattern: 'no-slash', values: { 'X-A': 'b' } }]).length);
});

test('compareRoutes flags drift between our discovery and wrangler', () => {
  const { root } = fixture();
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'r.json'), JSON.stringify({ version: 1, include: ['/api/hello'], exclude: [] }));
    assert.deepEqual(compareRoutes(root, join(dir, 'r.json')), []);
    writeFileSync(join(dir, 'r.json'), JSON.stringify({ version: 1, include: ['/api/hello', '/api/new'], exclude: [] }));
    assert.equal(compareRoutes(root, join(dir, 'r.json')).length, 1);
  } finally { cleanup(root, dir); }
});

test('a new language file is not published until declared', () => {
  const { root, write } = fixture();
  write('i18n.js', 'var LANGS = [["en","English"]];');
  write('i18n/xx.js', 'x');
  const m = loadManifest(root);
  m.files = [...m.files, 'i18n.js'].sort();
  try { assert.ok(analyzeClosure(root, m).problems.some((p) => p.includes('i18n/xx.js') && p.includes('not declared'))); } finally { cleanup(root); }
});

test('the builder refuses unsafe output directories and never deletes outside dist', () => {
  const { root } = fixture();
  try {
    assert.throws(() => buildPublic({ root, outDir: root }), PublicOutputError);
    assert.throws(() => buildPublic({ root, outDir: dirname(root) }), PublicOutputError);
    mkdirSync(join(root, 'keep'));
    writeFileSync(join(root, 'keep', 'a.txt'), 'x');
    assert.throws(() => buildPublic({ root, outDir: join(root, 'keep') }), PublicOutputError);
    assert.ok(existsSync(join(root, 'keep', 'a.txt')), 'a non-empty custom directory must be left untouched');
    assert.ok(existsSync(join(root, 'secret.sql')));
  } finally { cleanup(root); }
});

test('the default build replaces stale dist content', () => {
  const { root } = fixture();
  try {
    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'dist', 'stale.html'), 'old');
    buildPublic({ root });
    assert.ok(!existsSync(join(root, 'dist', 'stale.html')));
    assert.ok(existsSync(join(root, 'dist', 'index.html')));
  } finally { cleanup(root); }
});

test('reference extraction handles relative, absolute, query, hash, data, external and API references', () => {
  const html = '<a href="./a.html?x=1#top">a</a><img src="/img/b.png"><script src="https://cdn.example/x.js"></script><link href="data:text/css,x">'
    + '<a href="#sec"></a><a href="mailto:a@b.c"></a><div style="background:url(/img/c.png)"></div><script>fetch("/api/x");navigator.serviceWorker.register("./sw.js");el.src = "/js/d.js"; canvas.toDataURL("image/png"); URL.createObjectURL(blob)</script>';
  const targets = extractReferences('sub/page.html', html).map((r) => r.target).sort();
  assert.deepEqual(targets, ['img/b.png', 'img/c.png', 'js/d.js', 'sub/a.html', 'sub/sw.js']);
  assert.ok(extractReferences('page.html', '<a href="../up.html">').some((r) => r.target.startsWith('!escapes-root')));
  assert.deepEqual(extractReferences('page.html', '<img src="/a%20b.png">').map((r) => r.target), ['a b.png']);
  assert.deepEqual(extractReferences('x.js', 'const o={bundleFile:"layer/x-bundle.js"}').map((r) => r.target), ['layer/x-bundle.js']);
});

test('path, route and deny helpers behave', () => {
  assert.equal(safeRelativePath('a/b.js'), 'a/b.js');
  for (const bad of ['', '/a', '../a', 'a/../b', 'a//b', 'a/', './a', 'a\\b', 'a\0b', 'C:/x', null, 5]) assert.equal(safeRelativePath(bad), null, String(bad));
  assert.ok(routeMatches('/api/*', '/api/a/b'));
  assert.ok(!routeMatches('/api/*', '/apix'));
  assert.ok(routeMatches('/api/a.b', '/api/a.b'));
  assert.ok(!routeMatches('/api/a.b', '/api/aXb'));
  assert.equal(denyReason('app.js', { directories: [], extensions: [], basenames: [] }), null);
  assert.ok(denyReason('x/.env.production', {}));
  assert.ok(denyReason('a/tests/b.js', {}));
});
