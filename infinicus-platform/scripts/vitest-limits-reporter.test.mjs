import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatNearLimit, nearLimit } from './vitest-limits-reporter.mjs';

const rows = [
  { file: 'a.test.ts', name: 'fast', timeout: 5000, ms: 40 },
  { file: 'a.test.ts', name: 'thin', timeout: 5000, ms: 4000 },
  { file: 'b.test.ts', name: 'half', timeout: 120000, ms: 60000 },
  { file: 'b.test.ts', name: 'over', timeout: 5000, ms: 6000 },
  { file: 'c.test.ts', name: 'no limit known', timeout: null, ms: 99999 },
];

test('nearLimit: keeps tests at or above the threshold share, tightest first, ignores unknown limits', () => {
  const r = nearLimit(rows, 0.5);
  assert.deepEqual(r.map((x) => x.name), ['over', 'thin', 'half']);
  assert.equal(Math.round(r[0].share * 100), 120);
});

test('nearLimit: respects the threshold and the row cap', () => {
  assert.deepEqual(nearLimit(rows, 0.9).map((x) => x.name), ['over']);
  assert.equal(nearLimit(rows, 0.1, 2).length, 2);
});

test('formatNearLimit: prints share, duration, limit and location; says so when nothing is close', () => {
  const text = formatNearLimit(nearLimit(rows, 0.7), 'pkg');
  assert.match(text, /\[limits\] pkg: tests above the threshold/);
  assert.match(text, /120%\s+6000 ms of\s+5000 ms\s+b\.test\.ts\s+over/);
  assert.match(formatNearLimit([], 'pkg'), /no test used a large share/);
});
