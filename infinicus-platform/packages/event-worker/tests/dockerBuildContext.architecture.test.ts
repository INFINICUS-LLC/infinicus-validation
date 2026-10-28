import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

/**
 * SEC-DOCKER-1 guard: real environment files, operator backups and key material must never enter the API image.
 *
 * Root cause (found on the production host, RP-12B): the API Dockerfile runs `COPY . .` on the whole workspace, and Docker matches
 * .dockerignore patterns against the build-context ROOT. A bare ".env" therefore only excluded the root file; the compose environment file
 * infrastructure/deployment/oci/.env (and backups next to it) were copied into the image layers.
 *
 * Three layers of proof, all with DUMMY values only:
 *   1. a small re-implementation of Docker's ignore matching (last matching pattern wins, a matching parent directory excludes its children)
 *      shows the committed .dockerignore excludes the sensitive paths and keeps the legitimate ones;
 *   2. the same matcher shows the OLD patterns did NOT exclude the nested files (the documented root cause);
 *   3. when a Docker daemon is available, a real BuildKit build of a throwaway context confirms the matcher against Docker itself.
 */
const PLATFORM = resolve(__dirname, '../../..');
const DOCKERIGNORE = join(PLATFORM, '.dockerignore');
const lines = readFileSync(DOCKERIGNORE, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

type Rule = { negate: boolean; re: RegExp };

function toRule(raw: string): Rule {
  const negate = raw.startsWith('!');
  const p = (negate ? raw.slice(1) : raw).replace(/^\/+/, '').replace(/\/+$/, '');
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*' && p[i + 1] === '*') {
      if (p[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '\\' && i + 1 < p.length) { re += p[i + 1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); i += 1; }
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  // The pattern text comes from the committed .dockerignore (repository-controlled), and every regex metacharacter is escaped above.
  // eslint-disable-next-line security/detect-non-literal-regexp
  return { negate, re: new RegExp(`^${re}$`) };
}

/** Docker semantics: patterns are applied in order; a pattern matches the path or any of its parent directories; the last match decides. */
function isIgnored(path: string, patterns: string[]): boolean {
  const rules = patterns.map(toRule);
  const parts = path.split('/');
  const candidates = parts.map((_, i) => parts.slice(0, i + 1).join('/'));
  let ignored = false;
  for (const r of rules) if (candidates.some((c) => r.re.test(c))) ignored = !r.negate;
  return ignored;
}

/** The patterns that were in place before SEC-DOCKER-1 (kept verbatim to document the root cause). */
const OLD_SECRET_PATTERNS = ['.env', '.env.local', '.env.*.local'];

const MUST_BE_EXCLUDED = [
  '.env',
  '.env.local',
  '.env.production',
  'apps/web/.env.local',
  'infrastructure/deployment/oci/.env',
  'infrastructure/deployment/oci/.env.backup-before-preview-cors',
  'infrastructure/deployment/hetzner/.env',
  'infrastructure/deployment/oci/infinicus-oci-env-backup-20261014T185738Z',
  'infrastructure/deployment/oci/discovery-20261012T201153Z.txt',
  'infrastructure/deployment/oci/rp12a-20261028T134608Z.txt',
  'config/prod.env',
  'secrets/server.pem',
  'secrets/tls.key',
  'secrets/client.p12',
  'deploy/id_ed25519',
  'deploy/id_rsa',
  '.git-credentials',
  'tools/.netrc',
  '.aws/credentials',
  'ops/.ssh/authorized_keys',
  'ops/.gnupg/pubring.kbx',
];

const MUST_BE_KEPT = [
  '.env.example',
  'apps/web/.env.example',
  'infrastructure/deployment/oci/.env.example',
  'infrastructure/deployment/hetzner/.env.example',
  '.npmrc',
  'package.json',
  'pnpm-lock.yaml',
  'apps/api/Dockerfile',
  'apps/api/src/server.ts',
  'packages/configuration/src/environment.ts',
  'packages/configuration/src/env.ts',
  'infrastructure/deployment/oci/docker-compose.yml',
  'infrastructure/deployment/scripts/production-readonly-discovery.sh',
];

describe('SEC-DOCKER-1 — .dockerignore keeps secrets out of the image build context', () => {
  it('excludes real environment files, operator backups and key material at any depth', () => {
    const leaked = MUST_BE_EXCLUDED.filter((p) => !isIgnored(p, lines));
    expect(leaked).toEqual([]);
  });

  it('keeps the legitimate files the image build needs (templates, .npmrc, source, compose files)', () => {
    const lost = MUST_BE_KEPT.filter((p) => isIgnored(p, lines));
    expect(lost).toEqual([]);
  });

  it('documents the root cause: the previous root-anchored patterns did not exclude the nested files', () => {
    expect(isIgnored('.env', OLD_SECRET_PATTERNS)).toBe(true);
    expect(isIgnored('infrastructure/deployment/oci/.env', OLD_SECRET_PATTERNS)).toBe(false);
    expect(isIgnored('infrastructure/deployment/oci/.env.backup-before-preview-cors', OLD_SECRET_PATTERNS)).toBe(false);
  });

  it('does not hide any tracked source file (the secret patterns must not swallow repository content)', () => {
    const repoRoot = resolve(PLATFORM, '..');
    const ls = spawnSync('git', ['ls-files', '-z', '--', PLATFORM], { cwd: repoRoot, encoding: 'utf8' });
    if (ls.status !== 0) return; // not a git checkout (for example an exported source tree): nothing to compare
    const tracked = ls.stdout.split('\0').filter(Boolean).map((p) => relative(PLATFORM, resolve(repoRoot, p)).split('\\').join('/'));
    expect(tracked.length).toBeGreaterThan(100);
    const secretBlock = lines.slice(lines.indexOf('**/.env'), lines.indexOf('**/rp12*.txt') + 1);
    const swallowed = tracked.filter((p) => isIgnored(p, secretBlock));
    expect(swallowed).toEqual([]);
  });
});

function dockerAvailable(): boolean {
  const r = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8', timeout: 15_000 });
  return r.status === 0;
}

function listFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFiles(full, base));
    else out.push(relative(base, full).split('\\').join('/'));
  }
  return out;
}

describe.runIf(dockerAvailable())('SEC-DOCKER-1 — confirmed against a real BuildKit build (dummy files only)', () => {
  it('a throwaway context built with the committed .dockerignore exports none of the sensitive files and all of the kept ones', () => {
    const ctx = mkdtempSync(join(tmpdir(), 'sec-docker-1-ctx-'));
    const out = mkdtempSync(join(tmpdir(), 'sec-docker-1-out-'));
    try {
      writeFileSync(join(ctx, '.dockerignore'), readFileSync(DOCKERIGNORE, 'utf8'));
      writeFileSync(join(ctx, 'Dockerfile'), 'FROM scratch\nCOPY . /ctx/\n');
      for (const p of [...MUST_BE_EXCLUDED, ...MUST_BE_KEPT]) {
        mkdirSync(dirname(join(ctx, p)), { recursive: true });
        writeFileSync(join(ctx, p), 'DUMMY-NOT-A-SECRET\n');
      }
      const r = spawnSync('docker', ['build', '--no-cache', '--output', `type=local,dest=${out}`, ctx], {
        encoding: 'utf8', env: { ...process.env, DOCKER_BUILDKIT: '1' }, timeout: 110_000,
      });
      expect(r.status, r.stderr?.slice(-400)).toBe(0);
      const exported = new Set(listFiles(join(out, 'ctx')));
      expect(MUST_BE_EXCLUDED.filter((p) => exported.has(p))).toEqual([]);
      expect(MUST_BE_KEPT.filter((p) => !exported.has(p))).toEqual([]);
      // the matcher above and Docker itself agree on every path used in this test
      for (const p of [...MUST_BE_EXCLUDED, ...MUST_BE_KEPT]) expect(exported.has(p), p).toBe(!isIgnored(p, lines));
    } finally {
      rmSync(ctx, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    }
  }, 120_000);
});
