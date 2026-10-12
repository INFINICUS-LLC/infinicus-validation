/**
 * Guard (no database): no integration test may send a bare TRUNCATE to the shared test database.
 *
 * A TRUNCATE - even one a trigger refuses - first requests an ACCESS EXCLUSIVE lock. Waiting for it queues every other statement on the table
 * behind it, so one test file can stall every concurrently running file (the P0-6f CI failures: "Test timed out in 5000ms", an engine attempt
 * aborted as OPERATIONAL_ERROR). Refused-TRUNCATE assertions must go through `truncateRefusal` (100 ms lock_timeout, retried), which this test
 * pins in both packages that need it.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const PLATFORM = resolve(__dirname, '../../..');
const SKIP = new Set(['node_modules', 'dist', '.turbo', '.next', 'coverage']);
function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.test\.ts$/.test(name)) yield full;
  }
}
const tests: { rel: string; code: string }[] = [];
for (const root of ['packages', 'apps', 'layers']) {
  for (const file of walk(join(PLATFORM, root))) tests.push({ rel: relative(PLATFORM, file).split('\\').join('/'), code: readFileSync(file, 'utf8') });
}

describe('test database lock hygiene', () => {
  it('scans the real test tree (not vacuous)', () => {
    expect(tests.length).toBeGreaterThan(100);
    expect(tests.some((t) => /truncateRefusal\(/.test(t.code))).toBe(true);
  });

  it('no test sends a bare TRUNCATE to the shared database: every refused TRUNCATE goes through truncateRefusal', () => {
    const offenders = tests
      .filter((t) => !t.rel.endsWith('testTruncateSafety.architecture.test.ts'))
      .filter((t) => /\.query\(\s*[`'"]\s*TRUNCATE\b/.test(t.code))
      .map((t) => t.rel);
    expect(offenders).toEqual([]);
    // the one place a runner mixes statements: the execution suite sends TRUNCATE only through the helper
    const mixed = tests.find((t) => t.rel.endsWith('AuthorizedActionExecution.integration.test.ts'))!;
    expect(mixed.code).toMatch(/sql\.startsWith\('TRUNCATE'\) \? truncateRefusal\(admin, sql\) : admin\.query\(sql\)/);
  });

  it('the helper keeps its lock_timeout and retry (it must never wait unbounded for the lock)', () => {
    for (const pkg of ['packages/database', 'packages/business-operations-runtime']) {
      const h = readFileSync(join(PLATFORM, pkg, 'tests/helpers/truncateRefusal.ts'), 'utf8');
      expect(h, pkg).toMatch(/SET lock_timeout = '100ms'/);
      expect(h, pkg).toMatch(/55P03/);
      expect(h, pkg).toMatch(/RESET lock_timeout/);
    }
    expect(readFileSync(join(PLATFORM, 'packages/database/tests/helpers/truncateRefusal.ts'), 'utf8'))
      .toBe(readFileSync(join(PLATFORM, 'packages/business-operations-runtime/tests/helpers/truncateRefusal.ts'), 'utf8')); // one behaviour, two copies
  });
});
