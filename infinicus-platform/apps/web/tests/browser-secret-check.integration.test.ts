/**
 * Live test for BUILD-24's browser-secret-prevention requirement:
 * infrastructure/deployment/scripts/check-no-browser-secrets.mjs. Runs
 * the real script — against this repository's actual browser source
 * (apps/web/app, apps/web/lib, apps/admin/src; must pass AND must really
 * scan files) and against deliberately-violating fixture directories (must
 * fail with the expected diagnostic) — not a reimplementation of its
 * scanning logic.
 *
 * S-1: the script used to list apps/web/src, which does not exist, and
 * silently scanned nothing. These tests pin the real directories, that a
 * missing or empty configured directory FAILS, and that browser-only
 * modules without a 'use client' directive (lib/client, app/(client)) are
 * treated as browser code.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);
const CHECK_SCRIPT = resolve(__dirname, '../../../infrastructure/deployment/scripts/check-no-browser-secrets.mjs');

let fixtureDir: string | null = null;

afterEach(() => {
  if (fixtureDir) {
    rmSync(fixtureDir, { recursive: true, force: true });
    fixtureDir = null;
  }
});

/** A clean fixture with the real layout: every configured directory exists and holds one harmless source file. */
function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'browser-secret-fixture-'));
  for (const d of ['apps/web/app', 'apps/web/lib', 'apps/admin/src']) {
    mkdirSync(join(dir, d), { recursive: true });
    writeFileSync(join(dir, d, 'ok.ts'), 'export const ok = 1;\n');
  }
  fixtureDir = dir;
  return dir;
}

async function failureOf(rootDir: string): Promise<string> {
  try {
    await runCheck(rootDir);
  } catch (err) {
    return (err as { stderr?: string }).stderr ?? '';
  }
  throw new Error('check-no-browser-secrets.mjs should have exited non-zero');
}

function runCheck(rootDir?: string) {
  return execFileAsync('node', rootDir ? [CHECK_SCRIPT, rootDir] : [CHECK_SCRIPT]);
}

describe('check-no-browser-secrets.mjs', () => {
  it('passes against this repository\'s real browser source, and says it really scanned it', async () => {
    const { stdout } = await runCheck();
    expect(stdout).toContain('Browser-secret check passed');
    expect(stdout).toContain('apps/web/app');
    expect(stdout).toContain('apps/web/lib');
    expect(stdout).not.toContain('apps/web/src');
    const scanned = Number(/scanned (\d+) file/.exec(stdout)?.[1]);
    expect(scanned).toBeGreaterThan(10);                 // the web app alone has more than this; a scan of nothing can no longer pass
  });

  it('S-1: the clean fixture with the real layout passes and counts its files', async () => {
    const { stdout } = await runCheck(makeFixture());
    expect(stdout).toContain('scanned 3 file(s)');
  });

  it('S-1: a configured directory that is missing FAILS (the scan would have checked nothing)', async () => {
    const dir = makeFixture();
    rmSync(join(dir, 'apps/web/lib'), { recursive: true, force: true });
    const stderr = await failureOf(dir);
    expect(stderr).toContain('apps/web/lib: configured browser source directory is missing or contains no source files');
  });

  it('S-1: a configured directory with no source file FAILS', async () => {
    const dir = makeFixture();
    rmSync(join(dir, 'apps/web/app/ok.ts'));
    expect(await failureOf(dir)).toContain('apps/web/app: configured browser source directory is missing or contains no source files');
  });

  it('S-1: the old, nonexistent layout alone (apps/web/src) is no longer enough to pass', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'browser-secret-fixture-'));
    fixtureDir = dir;
    mkdirSync(join(dir, 'apps/web/src/app'), { recursive: true });
    writeFileSync(join(dir, 'apps/web/src/app/ok.ts'), 'export const ok = 1;\n');
    mkdirSync(join(dir, 'apps/admin/src'), { recursive: true });
    writeFileSync(join(dir, 'apps/admin/src/ok.ts'), 'export const ok = 1;\n');
    expect(await failureOf(dir)).toContain('apps/web/app: configured browser source directory is missing');
  });

  it.each(['apps/web/app', 'apps/web/lib', 'apps/admin/src'])('S-1: a NEXT_PUBLIC_ secret reference under %s is caught', async (sub) => {
    const dir = makeFixture();
    writeFileSync(join(dir, sub, 'bad.ts'), 'export const url = process.env.NEXT_PUBLIC_DATABASE_URL;\n');
    expect(await failureOf(dir)).toContain('NEXT_PUBLIC_DATABASE_URL');
  });

  it('S-1: a module under lib/client with NO \'use client\' directive reading a secret is caught', async () => {
    const dir = makeFixture();
    mkdirSync(join(dir, 'apps/web/lib/client'), { recursive: true });
    writeFileSync(join(dir, 'apps/web/lib/client/leak.ts'), 'export const k = process.env.DATABASE_URL;\n');
    expect(await failureOf(dir)).toContain('apps/web/lib/client/leak.ts: browser-side file');
  });

  it('S-1: the same read under app/(client) is caught; outside the browser-only paths it is not (server code may read it)', async () => {
    const dir = makeFixture();
    mkdirSync(join(dir, 'apps/web/app/(client)'), { recursive: true });
    writeFileSync(join(dir, 'apps/web/app/(client)/leak.tsx'), 'export const k = process.env.DATABASE_URL;\n');
    expect(await failureOf(dir)).toContain('apps/web/app/(client)/leak.tsx: browser-side file');
    rmSync(join(dir, 'apps/web/app/(client)'), { recursive: true, force: true });
    writeFileSync(join(dir, 'apps/web/lib/server-only.ts'), 'export const k = process.env.DATABASE_URL;\n');
    const { stdout } = await runCheck(dir);
    expect(stdout).toContain('Browser-secret check passed');
  });

  it('fails when NEXT_PUBLIC_DATABASE_URL is referenced', async () => {
    const dir = makeFixture();
    writeFileSync(join(dir, 'apps/web/app/bad.ts'), 'export const url = process.env.NEXT_PUBLIC_DATABASE_URL;\n');

    let caught: { stderr?: string } | undefined;
    try {
      await runCheck(dir);
    } catch (err) {
      caught = err as { stderr?: string };
    }
    expect(caught, 'check-no-browser-secrets.mjs should have exited non-zero').toBeDefined();
    expect(caught?.stderr).toContain('NEXT_PUBLIC_DATABASE_URL');
  });

  it('fails when a \'use client\' file reads process.env.DATABASE_URL directly', async () => {
    const dir = makeFixture();
    writeFileSync(
      join(dir, 'apps/web/app/bad.tsx'),
      "'use client';\nexport function Bad() { return process.env.DATABASE_URL; }\n"
    );

    let caught: { stderr?: string } | undefined;
    try {
      await runCheck(dir);
    } catch (err) {
      caught = err as { stderr?: string };
    }
    expect(caught, 'check-no-browser-secrets.mjs should have exited non-zero').toBeDefined();
    expect(caught?.stderr).toContain("browser-side file ('use client', or under lib/client or app/(client)) references process.env.DATABASE_URL");
  });

  it('does not flag a server component reading process.env.DATABASE_URL (no \'use client\' directive)', async () => {
    const dir = makeFixture();
    writeFileSync(
      join(dir, 'apps/web/app/fine.ts'),
      'export function getUrl() { return process.env.DATABASE_URL; }\n'
    );

    const { stdout } = await runCheck(dir);
    expect(stdout).toContain('Browser-secret check passed');
  });
});
