#!/usr/bin/env node
/**
 * NEW-ARCHITECTURE COMPLETION MATRIX: validator and score calculator.
 *
 * Reads docs/architecture/completion-matrix/work-packages.json and computes, per work package:
 *   score = 0.10*spec + 0.35*(impl*100) + 0.25*(impl*integration) + 0.20*(impl*verification) + 0.10*(impl*operational)
 * (every input on a 0-100 scale; impl is 0-1). Aggregation is weighted by `units` (requirement units).
 *
 *   node scripts/completion-matrix.mjs            validate + print the results
 *   node scripts/completion-matrix.mjs --json     print results as JSON
 *   node scripts/completion-matrix.mjs --check    exit 1 if the data file is invalid (CI-safe)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(here, '../../docs/architecture/completion-matrix/work-packages.json');
const data = JSON.parse(readFileSync(DATA, 'utf8'));
const W = data.dimensions;

const errors = [];
const pct = (v) => typeof v === 'number' && v >= 0 && v <= 100;
const sumW = Object.values(W).reduce((a, b) => a + b, 0);
if (Math.abs(sumW - 1) > 1e-9) errors.push(`dimension weights sum to ${sumW}, expected 1`);

const ids = new Set();
function check(row, kind) {
  if (!row.id) errors.push(`${kind}: missing id`);
  if (ids.has(row.id)) errors.push(`duplicate id ${row.id}`);
  ids.add(row.id);
  if (typeof row.impl !== 'number' || row.impl < 0 || row.impl > 1) errors.push(`${row.id}: impl must be 0..1`);
  for (const k of ['spec', 'integration', 'verification', 'operational']) if (!pct(row[k])) errors.push(`${row.id}: ${k} must be 0..100`);
  if (!row.evidence || row.evidence.length < 4) errors.push(`${row.id}: evidence is required`);
}

export function score(r) {
  return W.spec * r.spec + W.functional * r.impl * 100 + W.integration * r.impl * r.integration
    + W.verification * r.impl * r.verification + W.operational * r.impl * r.operational;
}

for (const wp of data.workPackages) { check(wp, 'workPackage'); if (!(wp.units > 0)) errors.push(`${wp.id}: units must be > 0`); }
for (const g of data.guardrailSlice) { check(g, 'guardrail'); g.units = 1; }

function aggregate(rows, key) {
  const groups = new Map();
  for (const r of rows) {
    const k = key ? r[key] : 'ALL';
    const g = groups.get(k) ?? { units: 0, weighted: 0, count: 0 };
    g.units += r.units; g.weighted += r.units * score(r); g.count += 1;
    groups.set(k, g);
  }
  return Object.fromEntries([...groups].map(([k, g]) => [k, { packages: g.count, units: g.units, score: +(g.weighted / g.units).toFixed(1) }]));
}

const out = {
  asOf: data.asOf, mainCommit: data.mainCommit,
  fullScope: aggregate(data.workPackages).ALL,
  byFamily: aggregate(data.workPackages, 'family'),
  byLayer: aggregate(data.workPackages.filter((w) => w.layer), 'layer'),
  byDomain: aggregate(data.workPackages, 'domain'),
  guardrailSlice: aggregate(data.guardrailSlice).ALL,
  perPackage: data.workPackages.map((w) => ({ id: w.id, title: w.title, units: w.units, score: +score(w).toFixed(1) })),
  perGuardrail: data.guardrailSlice.map((g) => ({ id: g.id, title: g.title, score: +score(g).toFixed(1) })),
};

if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
if (process.argv.includes('--check')) { console.log(`completion matrix valid: ${data.workPackages.length} work packages, ${data.guardrailSlice.length} guardrail criteria`); process.exit(0); }
if (process.argv.includes('--json')) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }
console.log(`Completion matrix as of ${out.asOf} (main ${out.mainCommit})`);
console.log(`Full scope:      ${out.fullScope.score}%  (${out.fullScope.packages} packages, ${out.fullScope.units} units)`);
console.log(`Guardrail slice: ${out.guardrailSlice.score}%  (${out.guardrailSlice.packages} criteria)`);
for (const [t, v] of [['family', out.byFamily], ['layer', out.byLayer], ['domain', out.byDomain]]) {
  console.log(`\nBy ${t}:`); for (const [k, g] of Object.entries(v)) console.log(`  ${k.padEnd(14)} ${String(g.score).padStart(5)}%  (${g.units} units)`);
}
