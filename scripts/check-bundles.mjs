#!/usr/bin/env node
// Bundle guard: every layer bundle must parse (node --check) and execute
// in a browser-like global without throwing. Run from the repo root:
//   node scripts/check-bundles.mjs
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const bundles = readdirSync(ROOT, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .flatMap((d) => readdirSync(join(ROOT, d.name)).filter((f) => /-bundle\.js$/.test(f)).map((f) => join(d.name, f)));

const LOADER = `
  globalThis.window = globalThis;
  (0, eval)(require('node:fs').readFileSync(process.argv[1], 'utf8'));
  if (!globalThis.INFINICUS) throw new Error('bundle did not define window.INFINICUS');
`;

let failed = 0;
for (const rel of bundles) {
  const file = join(ROOT, rel);
  if (!existsSync(file)) continue;
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    execFileSync(process.execPath, ['-e', LOADER, file], { stdio: 'pipe' });
    console.log(`OK   ${rel}`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${rel}\n${String(e.stderr || e.message).split('\n').slice(0, 6).join('\n')}`);
  }
}
if (!bundles.length) { console.error('no bundles found'); failed++; }
process.exit(failed ? 1 : 0);
