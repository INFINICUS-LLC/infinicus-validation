#!/usr/bin/env node
/**
 * CI-STAB-03 R2: type-check the TEST files, which `pnpm typecheck` has never covered.
 *
 * Each package's tsconfig.json is the emitting production build (rootDir ./src, include ["src"]); vitest transpiles tests without checking them, so a
 * wrong argument count, a missing property or a bad cast in a test was invisible until it failed at run time. Every package with tests now has a
 * tsconfig.test.json (same strict settings, noEmit, src + tests, bundler-style resolution like vitest) and this script runs them.
 *
 * Existing test files already contain type errors that nobody could see. They are NOT suppressed with blanket excludes or by loosening `strict`:
 * each one is recorded in typecheck-tests.baseline.json as an exact (package, file, code, message) entry with a count, and this script is a RATCHET:
 *   - a diagnostic that is not in the baseline (or occurs more often than recorded) FAILS, with file, line and message;
 *   - a baseline entry that no longer occurs FAILS too ("remove it"), so a fixed error cannot silently come back.
 *
 *   node scripts/typecheck-tests.mjs                     check (CI)
 *   node scripts/typecheck-tests.mjs --package database  one package
 *   node scripts/typecheck-tests.mjs --update-baseline   rewrite the baseline from the current diagnostics (a deliberate, reviewed act)
 *   node scripts/typecheck-tests.mjs --summary           counts per package, no pass/fail
 * Workspace packages are resolved from their built output, so run `pnpm build` first (CI runs this after the Build step).
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const BASELINE_FILE = join(here, 'typecheck-tests.baseline.json');
const DIAGNOSTIC = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;
const MESSAGE_LIMIT = 240;

const posix = (p) => p.split('\\').join('/');

/** Parses `tsc --pretty false` output; paths are made relative to the platform root and the root is scrubbed from messages. */
export function parseDiagnostics(output, packageDir, root = ROOT) {
  const diagnostics = [];
  for (const line of output.split(/\r?\n/)) {
    const m = DIAGNOSTIC.exec(line);
    if (!m) continue;
    const file = posix(relative(root, resolve(packageDir, m[1])));
    const message = m[5].split(posix(root)).join('<root>').slice(0, MESSAGE_LIMIT);
    diagnostics.push({ file, line: Number(m[2]), column: Number(m[3]), code: m[4], message });
  }
  return diagnostics;
}

export const entryKey = (e) => `${e.file}|${e.code}|${e.message}`;

/** Collapses diagnostics into baseline entries: one per (file, code, message) with a count, sorted for a stable diff. */
export function toEntries(diagnostics) {
  const counts = new Map();
  for (const d of diagnostics) counts.set(entryKey(d), (counts.get(entryKey(d)) ?? 0) + 1);
  return [...counts.entries()]
    .map(([key, count]) => { const [file, code, ...rest] = key.split('|'); return { file, code, message: rest.join('|'), count }; })
    .sort((a, b) => (a.file + a.code + a.message).localeCompare(b.file + b.code + b.message));
}

/** added = more occurrences than the baseline allows; resolved = baseline entries (or counts) that no longer occur. */
export function compare(diagnostics, baselineEntries) {
  const allowed = new Map(baselineEntries.map((e) => [entryKey(e), e.count]));
  const seen = new Map();
  const added = [];
  for (const d of diagnostics) {
    const k = entryKey(d);
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    if (n > (allowed.get(k) ?? 0)) added.push(d);
  }
  const resolved = [];
  for (const e of baselineEntries) {
    const now = seen.get(entryKey(e)) ?? 0;
    if (now < e.count) resolved.push({ ...e, stillOccurring: now });
  }
  return { added, resolved };
}

function discoverPackages() {
  const dirs = [];
  for (const group of ['packages', 'apps', 'layers']) {
    const base = join(ROOT, group);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) if (existsSync(join(base, name, 'tsconfig.test.json'))) dirs.push(join(base, name));
  }
  return dirs.sort();
}

function runTsc(dir) {
  const require = createRequire(join(dir, 'package.json'));
  const tsc = require.resolve('typescript/bin/tsc', { paths: [dir, ROOT] });
  const r = spawnSync(process.execPath, [tsc, '--project', 'tsconfig.test.json', '--pretty', 'false'], { cwd: dir, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return { status: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function main(argv) {
  const only = argv.includes('--package') ? argv[argv.indexOf('--package') + 1] : null;
  const dirs = discoverPackages().filter((d) => !only || d.endsWith(`/${only}`));
  if (dirs.length === 0) { console.error(`no tsconfig.test.json found${only ? ` for "${only}"` : ''}`); return 2; }

  const diagnostics = [];
  const perPackage = [];
  for (const dir of dirs) {
    const { status, output } = runTsc(dir);
    const found = parseDiagnostics(output, dir);
    if (status !== 0 && found.length === 0) {
      console.error(`tsc failed in ${posix(relative(ROOT, dir))} without any diagnostic:\n${output.slice(0, 2000)}`);
      return 2;
    }
    diagnostics.push(...found);
    perPackage.push([posix(relative(ROOT, dir)), found.length]);
  }

  if (argv.includes('--summary')) {
    for (const [name, n] of perPackage) console.log(`${name.padEnd(44)} ${n}`);
    console.log(`${'total'.padEnd(44)} ${diagnostics.length}`);
    return 0;
  }
  if (argv.includes('--update-baseline')) {
    if (only) { console.error('--update-baseline rewrites the whole baseline; run it without --package'); return 2; }
    const entries = toEntries(diagnostics);
    writeFileSync(BASELINE_FILE, `${JSON.stringify({ comment: 'Known pre-existing type errors in test files (CI-STAB-03 R2). A ratchet: new errors fail, and so does an entry that no longer occurs. Do not add entries to make CI pass; fix the test.', typescript: typescriptVersion(), entries }, null, 1)}\n`);
    console.log(`baseline written: ${entries.length} entries, ${diagnostics.length} diagnostics`);
    return 0;
  }

  const baseline = existsSync(BASELINE_FILE) ? JSON.parse(readFileSync(BASELINE_FILE, 'utf8')) : { entries: [] };
  // With --package, judge only the diagnostics and baseline entries that live under the selected package directories.
  const prefixes = dirs.map((d) => `${posix(relative(ROOT, d))}/`);
  const inScope = (file) => !only || prefixes.some((p) => file.startsWith(p));
  const { added, resolved } = compare(diagnostics.filter((d) => inScope(d.file)), baseline.entries.filter((e) => inScope(e.file)));
  if (baseline.typescript && baseline.typescript !== typescriptVersion()) console.warn(`note: baseline was recorded with TypeScript ${baseline.typescript}, running ${typescriptVersion()}; messages may differ`);

  if (added.length > 0) {
    console.error(`\nTEST TYPECHECK FAILED: ${added.length} type error(s) in test files that are not in the baseline:\n`);
    for (const d of added) console.error(`  ${d.file}(${d.line},${d.column}): ${d.code}: ${d.message}`);
    if (added.some((d) => d.code === 'TS2307' && d.message.includes('@infinicus/'))) console.error('\nhint: workspace packages are resolved from their build output; run `pnpm build` first.');
    console.error('\nFix the test. Only a genuinely pre-existing error that cannot be fixed here may be baselined, with `--update-baseline` and a justification in review.');
  }
  if (resolved.length > 0) {
    console.error(`\nBASELINE IS STALE: ${resolved.length} recorded error(s) no longer occur. Remove them (node scripts/typecheck-tests.mjs --update-baseline) so they cannot come back unnoticed:\n`);
    for (const e of resolved) console.error(`  ${e.file}: ${e.code} x${e.count} (now ${e.stillOccurring}): ${e.message.slice(0, 120)}`);
  }
  if (added.length === 0 && resolved.length === 0) console.log(`test typecheck OK: ${dirs.length} package(s), ${diagnostics.length} known baselined error(s), 0 new`);
  return added.length > 0 || resolved.length > 0 ? 1 : 0;
}

function typescriptVersion() {
  try { return createRequire(join(ROOT, 'package.json'))('typescript/package.json').version; } catch { return 'unknown'; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exit(main(process.argv.slice(2)));
