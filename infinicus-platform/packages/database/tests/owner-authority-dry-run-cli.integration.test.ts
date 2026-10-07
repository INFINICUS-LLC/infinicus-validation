import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const run = !!process.env.ADMIN_DATABASE_URL;
const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../infrastructure/database/scripts/owner-authority-backfill-dry-run.sh');

describe('owner-authority-backfill-dry-run.sh', () => {
  it('refuses to run without an operator connection', async () => {
    let failure: { code?: number; stderr?: string } | undefined;
    try {
      await execFileAsync('bash', [SCRIPT], { env: { ...process.env, ADMIN_DATABASE_URL: '' } });
    } catch (err) {
      failure = err as { code?: number; stderr?: string };
    }
    expect(failure?.code).not.toBe(0);
    expect(failure?.stderr).toMatch(/ADMIN_DATABASE_URL is required/);
  });

  it.runIf(run)('writes a read-only report with executed=false and prints a human summary', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'owner-dry-run-')), 'report.json');
    const { stdout } = await execFileAsync('bash', [SCRIPT, out], { env: { ...process.env, ADMIN_DATABASE_URL: process.env.ADMIN_DATABASE_URL } });
    expect(stdout).toMatch(/DRY RUN \(read-only, nothing was granted\)/);
    for (const name of ['PROVEN', 'ALREADY_ASSIGNED', 'AMBIGUOUS', 'UNPROVEN', 'INVALID_INACTIVE']) expect(stdout).toContain(name);
    const report = JSON.parse(readFileSync(out, 'utf8'));
    expect(report.mode).toBe('DRY_RUN_READ_ONLY');
    expect(report.executed).toBe(false);
    expect(Array.isArray(report.entries)).toBe(true);
    // No emails or secrets in the report.
    expect(JSON.stringify(report)).not.toMatch(/@|password|token|secret/i);
  });
});
