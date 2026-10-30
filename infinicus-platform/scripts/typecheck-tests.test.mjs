import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compare, parseDiagnostics, toEntries } from './typecheck-tests.mjs';

const ROOT = '/work/infinicus-platform';
const PKG = `${ROOT}/packages/database`;
const out = [
  "tests/a.test.ts(10,5): error TS2554: Expected 1 arguments, but got 2.",
  "  Type 'x' is not assignable to type 'y'.",
  "../event-worker/tests/b.test.ts(3,1): error TS2307: Cannot find module '@infinicus/database' (/work/infinicus-platform/packages/database/dist).",
  "tests/a.test.ts(40,5): error TS2554: Expected 1 arguments, but got 2.",
  'not a diagnostic line',
].join('\n');

test('parseDiagnostics: relative paths, continuation lines ignored, root scrubbed', () => {
  const d = parseDiagnostics(out, PKG, ROOT);
  assert.equal(d.length, 3);
  assert.deepEqual(d[0], { file: 'packages/database/tests/a.test.ts', line: 10, column: 5, code: 'TS2554', message: 'Expected 1 arguments, but got 2.' });
  assert.equal(d[1].file, 'packages/event-worker/tests/b.test.ts');
  assert.ok(d[1].message.includes('<root>/packages/database/dist'));
});

test('toEntries: groups identical diagnostics with a count and sorts deterministically', () => {
  const entries = toEntries(parseDiagnostics(out, PKG, ROOT));
  assert.equal(entries.length, 2);
  assert.equal(entries.find((e) => e.code === 'TS2554').count, 2);
  assert.deepEqual(entries, toEntries([...parseDiagnostics(out, PKG, ROOT)].reverse()));
});

test('compare: the baselined diagnostics pass', () => {
  const d = parseDiagnostics(out, PKG, ROOT);
  const r = compare(d, toEntries(d));
  assert.deepEqual(r, { added: [], resolved: [] });
});

test('compare: a NEW diagnostic fails, with its line number', () => {
  const d = parseDiagnostics(out, PKG, ROOT);
  const extra = [...d, { file: 'packages/database/tests/new.test.ts', line: 7, column: 2, code: 'TS2339', message: "Property 'x' does not exist." }];
  const r = compare(extra, toEntries(d));
  assert.equal(r.added.length, 1);
  assert.equal(r.added[0].line, 7);
  assert.deepEqual(r.resolved, []);
});

test('compare: one MORE occurrence of a baselined error fails', () => {
  const d = parseDiagnostics(out, PKG, ROOT);
  const r = compare([...d, { ...d[0], line: 99 }], toEntries(d));
  assert.equal(r.added.length, 1);
  assert.equal(r.added[0].line, 99);
});

test('compare: a baselined error that no longer occurs is reported as resolved (the ratchet)', () => {
  const d = parseDiagnostics(out, PKG, ROOT);
  const r = compare(d.filter((x) => x.code !== 'TS2307'), toEntries(d));
  assert.equal(r.added.length, 0);
  assert.equal(r.resolved.length, 1);
  assert.equal(r.resolved[0].code, 'TS2307');
  assert.equal(r.resolved[0].stillOccurring, 0);
});

test('compare: fewer occurrences than recorded is also stale', () => {
  const d = parseDiagnostics(out, PKG, ROOT);
  const r = compare(d.slice(1), toEntries(d));
  assert.equal(r.resolved.length, 1);
  assert.equal(r.resolved[0].stillOccurring, 1);
});
