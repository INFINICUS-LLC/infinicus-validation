// Tests for the GitHub Pages "published files only" deployment (stageGithubPages + .github/workflows/github-pages.yml).
// Run: node --test scripts/tests/github-pages.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest, PublicOutputError, stageGithubPages, treeDigest } from '../build-public.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmp = () => mkdtempSync(join(tmpdir(), 'gh-pages-'));
const list = (dir) => {
  const out = [];
  const visit = (d) => readdirSync(d).forEach((n) => { const p = join(d, n); lstatSync(p).isDirectory() ? visit(p) : out.push(relative(dir, p).split('\\').join('/')); });
  visit(dir);
  return out.sort();
};
const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'github-pages.yml'), 'utf8');

test('the staged site is exactly the manifest\'s declared files: no Cloudflare-only files, nothing internal', () => {
  const out = tmp();
  try {
    const manifest = loadManifest(ROOT);
    const { files } = stageGithubPages({ root: ROOT, outDir: join(out, 'site') });
    const staged = list(join(out, 'site'));
    assert.equal(files, manifest.files.length);
    assert.deepEqual(staged, [...manifest.files].sort());
    assert.ok(staged.includes('404.html'));
    for (const f of ['_headers', '_routes.json', 'CNAME']) assert.ok(!staged.includes(f), `${f} is not part of the GitHub Pages site`);
    const internal = ['schema.sql', 'wrangler.toml', 'package.json', 'package-lock.json', 'public-manifest.json', 'bol.html', 'dal.html', 'pitch deck.html', 'icon.svg', 'push.bat', 'gate.txt',
      'INFINICUS-REPOSITORY-READY-MASTER-IMPLEMENTATION-QUEUE.zip', 'infinicusenginev3.zip', 'QUEUE-INTEGRITY-SHA256.json', 'CLAUDE-MASTER-EXECUTION-INSTRUCTIONS.md', 'scripts/build-public.mjs'];
    for (const f of internal) assert.ok(!staged.includes(f), f);
    for (const dir of ['docs', '.claude', '.github', 'infinicus-platform', 'functions', 'scripts', 'templates', 'pitch deck_files']) assert.ok(!staged.some((p) => p === dir || p.startsWith(`${dir}/`)), dir);
    for (const f of staged) assert.ok(readFileSync(join(ROOT, f)).equals(readFileSync(join(out, 'site', f))), `${f} is copied byte for byte`);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('staging is deterministic and refuses unsafe or non-empty targets', () => {
  const a = tmp(); const b = tmp();
  try {
    const first = stageGithubPages({ root: ROOT, outDir: join(a, 's') });
    const second = stageGithubPages({ root: ROOT, outDir: join(b, 's') });
    assert.equal(first.digest, second.digest);
    assert.equal(treeDigest(join(a, 's')), first.digest);
    assert.throws(() => stageGithubPages({ root: ROOT }), PublicOutputError);
    assert.throws(() => stageGithubPages({ root: ROOT, outDir: ROOT }), PublicOutputError);
    assert.throws(() => stageGithubPages({ root: ROOT, outDir: join(ROOT, 'dist') }), PublicOutputError);
    mkdirSync(join(a, 'full'));
    writeFileSync(join(a, 'full', 'keep.txt'), 'x');
    assert.throws(() => stageGithubPages({ root: ROOT, outDir: join(a, 'full') }), PublicOutputError);
    assert.ok(existsSync(join(a, 'full', 'keep.txt')), 'a non-empty directory is left untouched');
  } finally { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); }
});

test('staging inherits the allowlist checks: an undeclared referenced file or a missing 404.html stops the deployment', () => {
  const root = tmp(); const out = tmp();
  try {
    const write = (rel, text) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };
    write('index.html', '<a href="./secret.sql">x</a>');
    write('secret.sql', 'CREATE TABLE t(x);');
    write('404.html', '<p>404</p>');
    write('functions/api/x.js', 'export async function onRequestGet() { return new Response("x"); }');
    write('public-manifest.json', JSON.stringify({
      schemaVersion: 1, outputDir: 'dist', files: ['404.html', 'index.html'], knownMissingReferences: [], deny: { directories: ['functions'], extensions: ['.sql'], basenames: [] },
      headers: [{ pattern: '/*', values: { 'X-Content-Type-Options': 'nosniff' } }], routes: { version: 1, include: ['/api/*'], exclude: [] },
    }));
    assert.throws(() => stageGithubPages({ root, outDir: join(out, 's') }), (e) => e instanceof PublicOutputError && /secret\.sql/.test(e.message));
    assert.ok(!existsSync(join(out, 's')), 'nothing is written on failure');
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true }); }
});

// ── the workflow itself ────────────────────────────────────────────────────────────────────────────

test('the workflow uploads only the staged directory, never the repository', () => {
  assert.match(workflow, /node scripts\/build-public\.mjs --stage-github-pages "\$RUNNER_TEMP\/pages"/);
  assert.match(workflow, /uses: actions\/upload-pages-artifact@v3\s+with:\s+path: \$\{\{ runner\.temp \}\}\/pages\s*$/m);
  assert.ok(!/path:\s*\.?\/?\s*$/m.test(workflow), 'the artifact path must not be the repository root');
  assert.ok(!/path:\s*(?:dist|\.)\s*$/m.test(workflow), 'the artifact must not be dist/ (it carries Cloudflare-only files) or the root');
});

test('deployment is inert until the owner opts in, and only ever from main', () => {
  const deploy = workflow.slice(workflow.indexOf('  deploy:'));
  assert.match(deploy, /if: github\.ref == 'refs\/heads\/main' && vars\.PAGES_DEPLOY_FROM_ACTIONS == 'true'/);
  assert.match(deploy, /needs: stage/);
  assert.match(deploy, /environment:\s+name: github-pages/);
  assert.equal((workflow.match(/actions\/deploy-pages@/g) ?? []).length, 1);
  assert.ok(!/pull_request_target/.test(workflow), 'no pull_request_target');
  assert.match(workflow, /on:\s+push:\s+branches:\s+- "main"/);
});

test('permissions are least-privilege: read-only by default, pages/id-token write only on the deploy job', () => {
  assert.match(workflow, /^permissions:\s+contents: read\s*$/m);
  const stage = workflow.slice(workflow.indexOf('  stage:'), workflow.indexOf('  deploy:'));
  assert.ok(!/permissions:/.test(stage), 'the stage job inherits read-only');
  const deploy = workflow.slice(workflow.indexOf('  deploy:'));
  assert.match(deploy, /permissions:\s+pages: write\s+id-token: write\s+environment:/);
  assert.ok(!/secrets\./.test(workflow), 'no secrets are used');
  assert.ok(!/contents: write|packages: write|actions: write/.test(workflow));
});

test('actions are pinned to major versions and the stage job runs the allowlist tests', () => {
  for (const use of [...workflow.matchAll(/uses: ([^\s]+)/g)].map((m) => m[1])) assert.match(use, /^actions\/[a-z-]+@v\d+$/, use);
  assert.match(workflow, /node --test scripts\/tests\/build-public\.test\.mjs scripts\/tests\/github-pages\.test\.mjs/);
  assert.match(workflow, /concurrency:\s+group: github-pages\s+cancel-in-progress: false/);
});

test('the report documents every option and the rollout order', () => {
  const report = readFileSync(join(ROOT, 'docs', 'deployment', 'GITHUB_PAGES_EXPOSURE_REPORT.md'), 'utf8');
  for (const needle of ['Option 1', 'Option 2', 'Option 3', 'PAGES_DEPLOY_FROM_ACTIONS', 'GitHub Actions', 'Rollback', 'schema.sql', 'repository visibility']) assert.ok(report.includes(needle), needle);
});
