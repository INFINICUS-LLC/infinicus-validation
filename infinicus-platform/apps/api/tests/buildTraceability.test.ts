/**
 * S-3 - the running API must be traceable to a commit. No database needed.
 *
 * Root cause found: infrastructure/deployment/oci/ IS the production deployment directory (its runbook says so), and its Compose file never passed the
 * GIT_SHA build argument (only hetzner/ did), so GET /v1/health reported "unknown" however the image was built. These tests pin: the chain
 * (Dockerfile ARG -> ENV -> health), both Compose definitions, the smoke test's running-build check, and deploy.sh's traceability policy.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const exec = promisify(execFile);
const PLATFORM = resolve(__dirname, '..', '..', '..');
const SCRIPTS = join(PLATFORM, 'infrastructure', 'deployment', 'scripts');
const SMOKE = join(SCRIPTS, 'smoke-test.sh');
const FULL = '842f2bb80347d90e77184a5f2394a31c92df7161';

describe('image build chain: Dockerfile ARG -> ENV -> /v1/health', () => {
  const docker = readFileSync(join(PLATFORM, 'apps/api/Dockerfile'), 'utf8').split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  it('the runtime stage declares ARG GIT_SHA and stamps it into INFINICUS_BUILD_SHA', () => {
    const runtime = docker.slice(docker.indexOf('AS runtime'));
    expect(runtime).toMatch(/ARG GIT_SHA/);
    expect(runtime).toMatch(/ENV INFINICUS_BUILD_SHA=\$GIT_SHA/);
    expect(runtime.indexOf('ARG GIT_SHA')).toBeLessThan(runtime.indexOf('ENV INFINICUS_BUILD_SHA'));
  });
});

describe.each(['hetzner', 'oci'] as const)('%s docker-compose.yml passes GIT_SHA to the api image build', (stack) => {
  const file = join(PLATFORM, 'infrastructure', 'deployment', stack, 'docker-compose.yml');
  const text = readFileSync(file, 'utf8');
  it('the api build lists the GIT_SHA argument with an "unknown" default (never required, never a literal commit)', () => {
    const api = text.slice(text.indexOf('\n  api:'), text.indexOf('\n  tools:'));
    expect(api).toMatch(/build:[\s\S]*?args:[\s\S]*?GIT_SHA: \$\{GIT_SHA:-unknown\}/);
  });

  const composeOk = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0;
  it.skipIf(!composeOk)('Docker Compose resolves the argument to the commit given in the environment', () => {
    const res = spawnSync('docker', ['compose', '-f', file, '--project-directory', join(file, '..'), '--profile', 'tools', 'config', '--format', 'json'], {
      encoding: 'utf8', timeout: 60_000,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '/tmp', POSTGRES_ADMIN_PASSWORD: 'x', POSTGRES_APP_PASSWORD: 'y', SUPABASE_URL: 'https://p.example', SUPABASE_ANON_KEY: 'k', GIT_SHA: FULL },
    });
    expect(res.status, res.stderr).toBe(0);
    const cfg = JSON.parse(res.stdout) as { services: { api: { build: { args?: Record<string, string> } } } };
    expect(cfg.services.api.build.args?.GIT_SHA).toBe(FULL);
  });
});

describe('smoke-test.sh running-build check (EXPECTED_BUILD_SHA)', () => {
  let server: Server; let base = ''; let version: string | null = FULL; let omitVersion = false;
  beforeAll(async () => {
    server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/health') res.end(JSON.stringify(omitVersion ? { status: 'ok' } : { status: 'ok', version }));
      else res.end('{}');
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

  const smoke = async (env: Record<string, string>) => {
    try {
      const r = await exec('bash', [SMOKE], { env: { PATH: process.env.PATH ?? '', BASE_URL: base, ...env } });
      return { code: 0, out: r.stdout, err: r.stderr };
    } catch (e) {
      const x = e as { code?: number; stdout?: string; stderr?: string };
      return { code: x.code ?? 1, out: x.stdout ?? '', err: x.stderr ?? '' };
    }
  };

  it('without EXPECTED_BUILD_SHA nothing changes (an "unknown" build still passes the plain smoke test)', async () => {
    version = 'unknown'; omitVersion = false;
    expect((await smoke({})).code).toBe(0);
    expect((await smoke({ EXPECTED_BUILD_SHA: '' })).code).toBe(0);
  });
  it('passes when the running build equals the expected commit (case-insensitive) and says so', async () => {
    version = FULL; omitVersion = false;
    const r = await smoke({ EXPECTED_BUILD_SHA: FULL.toUpperCase() });
    expect(r.code).toBe(0);
    expect(r.out).toContain(`running build ${FULL} matches`);
  });
  it('accepts a short-sha build that is a prefix of the expected commit', async () => {
    version = FULL.slice(0, 12);
    expect((await smoke({ EXPECTED_BUILD_SHA: FULL })).code).toBe(0);
  });
  it('FAILS when the running API reports "unknown" (built without GIT_SHA), with a message that says how to fix it', async () => {
    version = 'unknown';
    const r = await smoke({ EXPECTED_BUILD_SHA: FULL });
    expect(r.code).toBe(1);
    expect(r.err).toContain('built without GIT_SHA');
    expect(r.err).toContain('GIT_SHA=$(git rev-parse HEAD)');
  });
  it('FAILS on a different commit, printing both ids', async () => {
    version = 'a'.repeat(40);
    const r = await smoke({ EXPECTED_BUILD_SHA: FULL });
    expect(r.code).toBe(1);
    expect(r.err).toContain(`reports version ${'a'.repeat(40)}; expected ${FULL}`);
  });
  it('FAILS when the reported id is too short or not a prefix, or when health reports no version at all', async () => {
    version = FULL.slice(0, 6);
    expect((await smoke({ EXPECTED_BUILD_SHA: FULL })).code).toBe(1);
    version = '0123456';
    expect((await smoke({ EXPECTED_BUILD_SHA: FULL })).code).toBe(1);
    omitVersion = true;
    const r = await smoke({ EXPECTED_BUILD_SHA: FULL });
    expect(r.code).toBe(1);
    expect(r.err).toContain('did not report a version');
  });
  it('FAILS on a malformed EXPECTED_BUILD_SHA instead of passing vacuously', async () => {
    version = FULL; omitVersion = false;
    for (const bad of ['unknown', 'xyz', 'abc123', FULL + 'a', 'HEAD']) expect((await smoke({ EXPECTED_BUILD_SHA: bad })).code, bad).toBe(1);
  });
});

describe('deploy.sh traceability policy (runs the real script in a throwaway git checkout; stops at or before the database)', () => {
  let root = ''; let scriptDir = '';
  const git = (...args: string[]) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.test' } });
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'deploy-policy-'));
    scriptDir = join(root, 'infrastructure/deployment/scripts');
    mkdirSync(scriptDir, { recursive: true });
    mkdirSync(join(root, 'packages/database/dist'), { recursive: true });
    for (const f of ['deploy.sh', 'version.sh', 'smoke-test.sh', 'migration-gate.sh', 'deployment-audit.cjs']) copyFileSync(join(SCRIPTS, f), join(scriptDir, f));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.1' }));
    writeFileSync(join(root, 'packages/database/dist/index.js'), 'module.exports = {};\n');
    git('init', '-q'); git('add', '-A'); git('commit', '-q', '-m', 'fixture');
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const deploy = (env: Record<string, string>) => {
    const r = spawnSync('bash', [join(scriptDir, 'deploy.sh')], { encoding: 'utf8', timeout: 60_000, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '/tmp', DATABASE_URL: 'postgresql://u:p@127.0.0.1:1/none', ...env } });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const started = (r: { out: string }) => r.out.includes('=== Deploying');          // printed only after every policy check passed

  it('production cannot waive the requirement, and the refusal happens before anything is recorded', () => {
    const r = deploy({ ENVIRONMENT: 'production', REQUIRE_TRACEABLE_BUILD: 'false' });
    expect(r.code).toBe(1);
    expect(r.err).toContain('REQUIRE_TRACEABLE_BUILD=false is not allowed for production');
    expect(started(r)).toBe(false);
  });
  it('a value other than true/false is refused', () => {
    const r = deploy({ ENVIRONMENT: 'staging', REQUIRE_TRACEABLE_BUILD: 'maybe' });
    expect(r.code).toBe(1);
    expect(r.err).toContain('must be true or false');
  });
  it.each(['production', 'staging'])('%s: tracked files with uncommitted changes are refused before anything is recorded', (environment) => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.2' }));
    try {
      const r = deploy({ ENVIRONMENT: environment });
      expect(r.code).toBe(1);
      expect(r.err).toContain('tracked files have uncommitted changes');
      expect(started(r)).toBe(false);
    } finally { git('checkout', '--', 'package.json'); }
  });
  it.each(['production', 'staging'])('%s: a clean tree passes the policy (and an untracked file does not block it); the run then proceeds to the database step', (environment) => {
    writeFileSync(join(root, 'untracked.env'), 'X=1\n');
    try {
      const r = deploy({ ENVIRONMENT: environment });
      expect(started(r)).toBe(true);                                                   // policy passed; the unreachable database stops it afterwards
      expect(r.err).not.toContain('uncommitted');
      expect(r.out).toContain(git('rev-parse', 'HEAD').stdout.trim());
    } finally { rmSync(join(root, 'untracked.env'), { force: true }); }
  });
  it('local/test do not require it by default (a dirty tree proceeds), but REQUIRE_TRACEABLE_BUILD=true enforces it there too', () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.3' }));
    try {
      expect(started(deploy({ ENVIRONMENT: 'test' }))).toBe(true);
      const r = deploy({ ENVIRONMENT: 'test', REQUIRE_TRACEABLE_BUILD: 'true' });
      expect(r.code).toBe(1);
      expect(r.err).toContain('uncommitted changes');
    } finally { git('checkout', '--', 'package.json'); }
  });
});
