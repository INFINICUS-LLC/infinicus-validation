#!/usr/bin/env node
// Bundle guard. Run from the repo root:  node scripts/check-bundles.mjs
//  1. every root layer bundle must parse (node --check) and execute in a
//     browser-like global without throwing;
//  2. every browser-global source file under
//     infinicus-platform/layers/*/blocks/*/src must parse.
// Syntax errors are reported only; this script never edits any file.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { Script } from 'node:vm';
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

// --- platform layer blocks (browser-global .js sources) --------------------
const BLOCK_SRC = /^INFINICUS-[A-Z]+-\d+-/;
function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (/\.m?js$/.test(e.name)) yield p;
  }
}
const layersDir = join(ROOT, 'infinicus-platform/layers');
let checked = 0;
if (existsSync(layersDir)) {
  for (const layer of readdirSync(layersDir)) {
    const blocksDir = join(layersDir, layer, 'blocks');
    if (!existsSync(blocksDir) || !statSync(blocksDir).isDirectory()) continue;
    for (const block of readdirSync(blocksDir).filter((b) => BLOCK_SRC.test(b))) {
      const srcDir = join(blocksDir, block, 'src');
      if (!existsSync(srcDir)) continue;
      for (const file of walk(srcDir)) {
        checked++;
        try {
          const code = readFileSync(file, 'utf8');
          // Browser-global sources parse fast in-process; ES-module sources
          // (import/export, e.g. the platform ADI blocks) need node --check.
          if (file.endsWith('.mjs') || /^\s*(import|export)\b/m.test(code)) {
            execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
          } else {
            new Script(code, { filename: file });
          }
        } catch (e) {
          failed++;
          console.error(`FAIL ${file.slice(ROOT.length + 1)}\n${String(e.stderr || e.message).split('\n').slice(0, 4).join('\n')}`);
        }
      }
    }
  }
}
console.log(`platform block sources checked: ${checked}`);
if (!checked) { console.error('no platform block sources found'); failed++; }

process.exit(failed ? 1 : 0);
