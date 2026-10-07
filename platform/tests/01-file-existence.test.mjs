// BUILD-10 structural tests — spec §22.A
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const BOOTSTRAP = resolve(ROOT, 'platform/platform-bootstrap.js');
const INDEX_HTML = resolve(ROOT, 'index.html');

// 1. platform-bootstrap.js exists
assert.equal(existsSync(BOOTSTRAP), true, 'platform/platform-bootstrap.js must exist');

const html = readFileSync(INDEX_HTML, 'utf8');
const scriptRefs = html.match(/src="\/platform\/platform-bootstrap\.js"/g) || [];

// 2. index.html includes it exactly once
assert.equal(scriptRefs.length, 1, 'index.html must reference platform-bootstrap.js exactly once');

// 3. the tag has the defer attribute
const tagMatch = html.match(/<script src="\/platform\/platform-bootstrap\.js"[^>]*>/);
assert.ok(tagMatch, 'platform-bootstrap.js script tag must exist');
assert.ok(tagMatch[0].includes('defer'), 'platform-bootstrap.js script tag must be deferred');

// 4. the script appears strictly after the ADI bundle tag (frozen location, spec §3.3)
const adiIndex = html.indexOf('src="/ai-decision-intelligence/adi-bundle.js"');
const platformIndex = html.indexOf('src="/platform/platform-bootstrap.js"');
assert.ok(adiIndex !== -1, 'ADI bundle tag must exist');
assert.ok(platformIndex > adiIndex, 'platform-bootstrap.js must appear after the ADI bundle tag');

// 5. no other /platform script tag exists (no duplicate)
const allPlatformScripts = html.match(/<script[^>]*src="\/platform\/[^"]*"[^>]*>/g) || [];
assert.equal(allPlatformScripts.length, 1, 'exactly one /platform/* script tag must exist');

// 6. all 7 existing bundle tags remain present, in the same relative order
const expectedOrder = [
  'src="/data-acquisition/da-bundle.js"',
  'src="/digital-twin/dt-bundle.js"',
  'src="/business-intelligence/bi-bundle.js"',
  'src="/approved-business-action/aba-bundle.js"',
  'src="/outcome-monitoring/om-bundle.js"',
  'src="/continuous-learning/cl-bundle.js"',
  'src="/ai-decision-intelligence/adi-bundle.js"'
];
let lastIndex = -1;
for (const marker of expectedOrder) {
  const idx = html.indexOf(marker);
  assert.ok(idx !== -1, `${marker} must still be present`);
  assert.ok(idx > lastIndex, `${marker} must remain in its existing relative order`);
  lastIndex = idx;
}

// 7. node --check on platform-bootstrap.js exits 0
execFileSync(process.execPath, ['--check', BOOTSTRAP]); // throws on non-zero exit

// 8. migration history guard (docs/architecture/MIGRATION-ALLOCATION-POLICY.md).
//    Originally "no migration beyond 0049" (BUILD-10 added none). Later builds
//    legitimately add migrations, so the guard now enforces the standing rules:
//    numbers are unique and contiguous, and the BUILD-10 baseline 0001-0049 is
//    immutable (SHA-256 over filename + LF-normalised content).
const FROZEN_THROUGH = 49;
const FROZEN_BASELINE_SHA256 = '433313310ab06bf53589d66bceeb77cb8bbf36fee6df5d20b640bea36230d07d';

const migrationsDir = resolve(ROOT, 'infinicus-platform/infrastructure/database/migrations');
const { readdirSync } = await import('node:fs');
const { createHash } = await import('node:crypto');
const migrationFiles = readdirSync(migrationsDir).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
const numbers = migrationFiles.map((f) => parseInt(f.slice(0, 4), 10));

numbers.forEach((n, i) => {
  assert.equal(n, i + 1, `migration numbers must be unique and contiguous from 0001 (found ${migrationFiles[i]} at position ${i + 1})`);
});
assert.ok(numbers.length >= FROZEN_THROUGH, `migrations 0001-${String(FROZEN_THROUGH).padStart(4, '0')} must all exist`);

const baseline = createHash('sha256');
for (const f of migrationFiles.slice(0, FROZEN_THROUGH)) {
  const body = readFileSync(resolve(migrationsDir, f), 'utf8').replace(/\r\n/g, '\n');
  baseline.update(`${f}\0${body}\0`);
}
assert.equal(baseline.digest('hex'), FROZEN_BASELINE_SHA256, 'frozen migrations 0001-0049 must not be modified, renamed, or removed');

console.log('platform/tests/01-file-existence.test.mjs passed.');
