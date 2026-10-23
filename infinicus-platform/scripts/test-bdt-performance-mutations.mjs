#!/usr/bin/env node
/** Targeted negative proofs for NEW-BDT-01 integrity. Run in an otherwise idle checkout; every mutation is restored in finally. No database required. */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contract = 'packages/handoff-contracts/src/bi-performance-evidence.ts';
const evidence = 'packages/workflow/src/performance/biPerformanceEvidence.ts';
const targets = {
  [contract]: ['handoff-contracts', 'bi-performance-evidence.contract.test.ts'],
  [evidence]: ['workflow', 'bdt.performanceEvidence.test.ts'],
};
const mutants = [
  ['array root accepted', contract, " && !Array.isArray(value)", ''],
  ['impossible dates accepted', contract, " && new Date(value).toISOString().slice(0, 10) === value", ''],
  ['missing detail accepted', contract, "if (typeof d.detail !== 'string')", 'if (false)'],
  ['empty provenance accepted', contract, '!text(d.provenance.contract)', "typeof d.provenance.contract !== 'string'"],
  ['invalid coverage accepted', contract, "if (!Array.isArray(d.coverage) || d.coverage.some((c) => typeof c !== 'string'))", 'if (false)'],
  ['malformed currencies accepted', contract, 'if (!Array.isArray(d.currencies))', 'if (false)'],
  ['null currency crashes', contract, "if (d.currencies.some((c) => !record(c) || typeof c.currency !== 'string'))", 'if (false)'],
  ['missing cross-check rows accepted', contract, 'if (!Array.isArray(e.crossCheck?.revenue))', 'if (false)'],
  ['unsupported cross-check state accepted', contract, " || !['AGREE', 'NOT_COMPARABLE'].includes(r.state)", ''],
  ['duplicate cross-check currencies accepted', contract, 'new Set(codes).size !== codes.length || ', ''],
  ['unsorted cross-check currencies accepted', contract, "if (new Set(codes).size !== codes.length || codes.join(',') !== [...codes].sort().join(','))", 'if (new Set(codes).size !== codes.length)'],
  ['unperformed cross-check has results', contract, 'e.crossCheck.performed === false && rows.length !== 0', 'false'],
  ['sealed evidence aliases source objects', evidence, 'structuredClone({ ...body, evidenceDigest: digestOf(body) })', '{ ...body, evidenceDigest: digestOf(body) }'],
];
const work = mkdtempSync(join(tmpdir(), 'infinicus-bdt-mutations-'));
const originals = new Map(Object.keys(targets).map((f) => [f, readFileSync(resolve(root, f), 'utf8')]));
function test(file) {
  const [pkg, testFile] = targets[file];
  const cwd = resolve(root, 'packages', pkg);
  const report = join(work, 'result.json');
  rmSync(report, { force: true });
  const run = spawnSync(process.execPath, [resolve(cwd, 'node_modules/vitest/vitest.mjs'), 'run', `tests/${testFile}`, '--reporter=json', `--outputFile=${report}`], {
    cwd, encoding: 'utf8', timeout: 60000,
  });
  if (run.error || run.signal) throw new Error(`test runner failed: ${run.error ?? run.signal}`);
  const result = JSON.parse(readFileSync(report, 'utf8'));
  if (!result.numTotalTests || !result.testResults?.length) throw new Error('test runner produced no tests');
  if (run.status !== 0 && !result.numFailedTests) throw new Error('test runner failed without an assertion failure');
  return { status: run.status, failed: result.numFailedTests };
}
let killed = 0;
try {
  for (const file of originals.keys()) {
    if (test(file).status !== 0) throw new Error(`baseline failed for ${file}`);
  }
  for (const [name, file, from, to] of mutants) {
    const original = originals.get(file);
    if (original.split(from).length !== 2) throw new Error(`mutation anchor must occur once: ${name}`);
    try {
      writeFileSync(resolve(root, file), original.replace(from, to));
      const result = test(file);
      if (result.failed > 0) { killed++; console.log(`KILLED ${name}`); }
      else console.error(`SURVIVED ${name}`);
    } finally { writeFileSync(resolve(root, file), original); }
  }
  console.log(`BDT integrity mutants killed: ${killed}/${mutants.length}`);
  if (killed !== mutants.length) process.exitCode = 1;
} finally {
  for (const [file, original] of originals) writeFileSync(resolve(root, file), original);
  rmSync(work, { recursive: true, force: true });
}
