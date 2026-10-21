// Checks the static export in apps/web/out (POS-8d-2a): every screen the shell must carry exists, the business screens exist under the placeholder id,
// and nothing server-only was emitted. Run after build-export.mjs. Exit 1 on any problem.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'out');
const problems = [];
const need = ['index.html', 'sign-in/index.html', 'workspaces/index.html', 'console/index.html', 'businesses/index.html',
  ...['counter', 'sales', 'printers', 'workflow', 'history'].map((s) => `businesses/_/${s}/index.html`)];
for (const f of need) if (!existsSync(join(out, f))) problems.push(`missing ${f}`);
const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const files = existsSync(out) ? walk(out) : [];
if (files.length === 0) problems.push('out/ is empty or missing');
for (const f of files) if (/\.(map)$/.test(f) || /[\\/]api[\\/]/.test(f.slice(out.length))) problems.push(`unexpected file ${f.slice(out.length)}`);
// a real business id must never be baked into the export (only the placeholder)
for (const f of files.filter((x) => x.endsWith('.html'))) {
  if (/businesses\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(readFileSync(f, 'utf8'))) problems.push(`a real business id is baked into ${f.slice(out.length)}`);
}
if (problems.length > 0) { console.error(`Static export check FAILED:\n  - ${problems.join('\n  - ')}`); process.exit(1); }
console.log(`Static export check passed: ${need.length} required screens present, ${files.length} files, no source maps, no api folder, no baked business id.`);
