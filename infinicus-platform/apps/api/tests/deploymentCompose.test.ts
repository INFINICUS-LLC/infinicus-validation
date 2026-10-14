/**
 * AC-3 R1-01 - the API container must receive SUPABASE_URL and SUPABASE_ANON_KEY.
 *
 * Docker Compose passes a container ONLY the variables its `environment:` block lists; defining them in the host .env is not enough.
 * Both deployment definitions (Hetzner, and the OCI twin) are checked here, as text and - when Docker Compose is available - by
 * letting Compose itself resolve them with non-secret test values. No network, no daemon, no database.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const PLATFORM = resolve(__dirname, '..', '..', '..');
const STACKS = ['hetzner', 'oci'] as const;
const dir = (stack: string) => join(PLATFORM, 'infrastructure', 'deployment', stack);
const composeFile = (stack: string) => join(dir(stack), 'docker-compose.yml');
const raw = (stack: string) => readFileSync(composeFile(stack), 'utf8');

/** Environment keys of one service, read from the `environment:` mapping (comments ignored). */
function envEntries(text: string, service: string): Map<string, string> {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l === `  ${service}:`);
  if (start < 0) return new Map();
  const out = new Map<string, string>();
  let inEnv = false;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^\S/.test(l) || /^  \S/.test(l)) break;               // next top-level key or next service
    if (/^    \S/.test(l)) inEnv = /^    environment:\s*$/.test(l); // another service-level key
    else if (inEnv) {
      const m = /^      ([A-Z][A-Z0-9_]*):\s*(.*)$/.exec(l);
      if (m) out.set(m[1], m[2].trim());
    }
  }
  return out;
}

const SERVICES = ['postgres', 'api', 'tools', 'caddy'];
/** Variables the API service already received before this change; none may disappear. */
const EXISTING_API_ENV = ['NODE_ENV', 'DATABASE_URL', 'PORT', 'CORS_ALLOWED_ORIGINS', 'RESEND_API_KEY', 'EMAIL_FROM_ADDRESS', 'EMAIL_VERIFICATION_URL_BASE', 'ANTHROPIC_API_KEY', 'LOG_LEVEL', 'TRUST_PROXY'];

const TEST_VALUES = {
  POSTGRES_ADMIN_PASSWORD: 'test-admin-not-a-secret',
  POSTGRES_APP_PASSWORD: 'test-app-not-a-secret',
  SUPABASE_URL: 'https://test-project.supabase.example',
  SUPABASE_ANON_KEY: 'test-public-anon-key-not-real',
};

const composeAvailable = (() => {
  try { return spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0; } catch { return false; }
})();

/** Runs `docker compose config` in a clean environment so nothing from the host can leak into the resolution. */
function resolveCompose(stack: string, vars: Record<string, string>) {
  const res = spawnSync('docker', ['compose', '-f', composeFile(stack), '--project-directory', dir(stack), '--profile', 'tools', 'config', '--format', 'json'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '/tmp', ...vars },
    timeout: 60_000,
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

describe.each(STACKS)('%s docker-compose.yml passes the Supabase configuration to the API (text)', (stack) => {
  const text = raw(stack);

  it('the definition exists', () => expect(existsSync(composeFile(stack))).toBe(true));

  it('the api service lists SUPABASE_URL and SUPABASE_ANON_KEY as required interpolations with no default and no literal value', () => {
    const env = envEntries(text, 'api');
    expect(env.get('SUPABASE_URL')).toBe('${SUPABASE_URL:?set SUPABASE_URL in .env}');
    expect(env.get('SUPABASE_ANON_KEY')).toBe('${SUPABASE_ANON_KEY:?set SUPABASE_ANON_KEY in .env}');
  });

  it('no other service receives either variable', () => {
    for (const service of SERVICES.filter((s) => s !== 'api')) {
      const keys = [...envEntries(text, service).keys()];
      expect(keys, service).not.toContain('SUPABASE_URL');
      expect(keys, service).not.toContain('SUPABASE_ANON_KEY');
    }
  });

  it('no service uses env_file (which would hand the whole .env to a container)', () => {
    expect(text.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')).not.toMatch(/^\s*env_file\s*:/m);
  });

  it('every previously configured API variable is still present', () => {
    const keys = [...envEntries(text, 'api').keys()];
    for (const k of EXISTING_API_ENV) expect(keys, k).toContain(k);
  });

  it('the service set and the Caddy / networking shape are unchanged', () => {
    for (const s of SERVICES) expect(text, s).toMatch(new RegExp(`^  ${s}:\\s*$`, 'm'));
    expect(text).toMatch(/reverse_proxy|caddy:2-alpine/);
    expect(text).toMatch(/- "80:80"/);
    expect(text).toMatch(/- "443:443"/);
    expect(text).toMatch(/expose:\s*\n\s*- "3000"/);
  });

  it('commits no Supabase value: no URL, JWT or key literal appears in non-comment lines', () => {
    const code = text.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    expect(code).not.toMatch(/supabase\.co/i);
    expect(code).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);        // a JWT-shaped key
    expect(code).not.toMatch(/sb_(?:publishable|secret)_/i);
    expect(code).not.toMatch(/service_role/i);
  });
});

describe('.env.example files document the names with empty placeholders only', () => {
  it.each(['.env.example', 'infrastructure/deployment/hetzner/.env.example'])('%s', (rel) => {
    const lines = readFileSync(join(PLATFORM, rel), 'utf8').split('\n');
    expect(lines).toContain('SUPABASE_URL=');
    expect(lines).toContain('SUPABASE_ANON_KEY=');
  });
});

describe.each(STACKS)('%s docker-compose.yml resolved by Docker Compose', (stack) => {
  const run = it.skipIf(!composeAvailable); // BLOCKED (skipped) rather than PASS when Compose cannot be executed

  run('resolves with test values: the api service gets both variables and nothing else does', () => {
    const res = resolveCompose(stack, TEST_VALUES);
    expect(res.status, res.stderr).toBe(0);
    const cfg = JSON.parse(res.stdout) as { services: Record<string, { environment?: Record<string, string> }> };
    expect(Object.keys(cfg.services).sort()).toEqual([...SERVICES].sort());
    const api = cfg.services.api.environment ?? {};
    expect(api.SUPABASE_URL).toBe(TEST_VALUES.SUPABASE_URL);
    expect(api.SUPABASE_ANON_KEY).toBe(TEST_VALUES.SUPABASE_ANON_KEY);
    for (const k of EXISTING_API_ENV) expect(Object.keys(api), k).toContain(k);
    expect(api.TRUST_PROXY).toBe('1');
    expect(api.DATABASE_URL).toContain('@postgres:5432/infinicus');
    for (const s of SERVICES.filter((x) => x !== 'api')) {
      expect(Object.keys(cfg.services[s].environment ?? {}), s).not.toContain('SUPABASE_URL');
      expect(Object.keys(cfg.services[s].environment ?? {}), s).not.toContain('SUPABASE_ANON_KEY');
    }
  });

  run.each(['SUPABASE_URL', 'SUPABASE_ANON_KEY'])('refuses to resolve (fails closed) when %s is missing or empty, naming the variable', (name) => {
    const { [name as keyof typeof TEST_VALUES]: _omitted, ...rest } = TEST_VALUES;
    void _omitted;
    const missing = resolveCompose(stack, rest);
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain(name);
    const empty = resolveCompose(stack, { ...rest, [name]: '' });
    expect(empty.status).not.toBe(0);
    expect(empty.stderr).toContain(name);
  });

  run('never substitutes a value: the host environment is not consulted for a default', () => {
    // Even with the variables absent from the clean environment, resolution must not succeed with some default.
    const res = resolveCompose(stack, { POSTGRES_ADMIN_PASSWORD: 'x', POSTGRES_APP_PASSWORD: 'y' });
    expect(res.status).not.toBe(0);
    expect(res.stdout).not.toContain('supabase');
  });
});
