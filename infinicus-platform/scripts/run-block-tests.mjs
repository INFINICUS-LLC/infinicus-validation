#!/usr/bin/env node
// scripts/run-block-tests.mjs
//
// Runs every *.test.mjs file under blocks/*/tests/ in the current package,
// each in its own `node` subprocess -- exactly the loop documented in
// CLAUDE-QUEUE-INSTRUCTIONS.md's "Validation Commands" section:
//
//   for dir in /{layer}/INFINICUS-{LAYER}-*/; do
//     for test in "$dir/tests/"*.mjs; do node "$test"; done
//   done
//
// These are plain node:assert scripts, not vitest suites (no describe/it
// blocks) -- they intentionally stay that way. This runner exists only to
// give each layer-* package.json a "test" script that actually executes
// them, in place of a "vitest run" script with nothing vitest-shaped to
// discover. No test semantics here; this only reconciles the package-level
// command with how these tests already run.
//
// Usage: node scripts/run-block-tests.mjs   (run with cwd = the package root)
// Zero dependencies; works on Windows/macOS/Linux (uses process.execPath and
// path.join, no shell globbing).

import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const blocksDir = join(root, 'blocks');

function findTestFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findTestFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.test.mjs')) {
      files.push(full);
    }
  }
  return files;
}

const testFiles = findTestFiles(blocksDir).sort();

if (testFiles.length === 0) {
  console.log('[run-block-tests] no *.test.mjs files found under blocks/ -- nothing to run.');
  process.exit(0);
}

console.log(`[run-block-tests] running ${testFiles.length} test file(s)...\n`);

let passed = 0;
const failures = [];

for (const file of testFiles) {
  const rel = file.slice(root.length + 1);
  const result = spawnSync(process.execPath, [file], { stdio: 'inherit' });
  if (result.status === 0) {
    passed += 1;
  } else {
    failures.push({ rel, status: result.status, error: result.error });
  }
}

console.log(`\n[run-block-tests] ${passed}/${testFiles.length} passed.`);

if (failures.length > 0) {
  console.error(`[run-block-tests] ${failures.length} failure(s):`);
  for (const f of failures) {
    console.error(`  - ${f.rel} (exit ${f.status ?? 'error: ' + f.error?.message})`);
  }
  process.exit(1);
}

process.exit(0);
