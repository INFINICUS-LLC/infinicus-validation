import { describe, expect, it } from 'vitest';
import { describeSubprocessFailure, redactDiagnostic, runScript } from './helpers/subprocessDiagnostics.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** CI-STAB-02 R3: pure tests of the failure-diagnostic helper (no database). */
describe('redactDiagnostic', () => {
  it('removes connection strings, passwords, identifiers, e-mail addresses and long digit runs', () => {
    const text = 'psql: could not connect postgresql://admin:S3cr3t@db.internal:5432/prod; PGPASSWORD=hunter2 password=abc tenant 99999999-a0a0-0000-0000-000000000001 by jane.doe@example.com id 123456789012';
    const out = redactDiagnostic(text);
    for (const leaked of ['S3cr3t', 'hunter2', 'password=abc', '99999999-a0a0', 'jane.doe', '123456789012', 'db.internal']) expect(out, leaked).not.toContain(leaked);
    expect(out).toContain('<url-redacted>');
    expect(out).toContain('<uuid>');
    expect(out).toContain('<email>');
  });
  it('leaves ordinary diagnostic text readable', () => {
    expect(redactDiagnostic('pg_dump: error: query failed: ERROR: relation does not exist')).toBe('pg_dump: error: query failed: ERROR: relation does not exist');
  });
});

describe('describeSubprocessFailure', () => {
  it('reports exit status, signal, elapsed time and bounded tails', () => {
    const text = describeSubprocessFailure('script', { code: 3, signal: null, killed: false, stderr: 'x'.repeat(5000), stdout: '' }, 42);
    expect(text).toContain('script failed: exit=3 signal=none killed=false elapsedMs=42');
    expect(text).toContain('stdout(tail): (empty)');
    expect(text.length).toBeLessThan(2400);
  });
});

describe('runScript', () => {
  const script = (body: string) => { const dir = mkdtempSync(join(tmpdir(), 'diag-')); const f = join(dir, 's.sh'); writeFileSync(f, body); return f; };
  it('returns output untouched on success and prints nothing extra', async () => {
    const r = await runScript(script('echo ok; echo warn >&2'), process.env, 'ok-script');
    expect(r).toEqual({ stdout: 'ok\n', stderr: 'warn\n' });
  });
  it('rejects on a non-zero exit (a failure is never suppressed) and carries the exit code and stderr', async () => {
    await expect(runScript(script('echo "boom: bad thing" >&2; exit 7'), process.env, 'bad-script')).rejects.toThrow(/bad-script failed: exit=7[\s\S]*boom: bad thing/);
  });
  it('survives a failing context callback and says so', async () => {
    await expect(runScript(script('exit 1'), process.env, 'ctx', async () => { throw new Error('no catalog'); })).rejects.toThrow(/context: unavailable \(no catalog\)/);
  });
});
