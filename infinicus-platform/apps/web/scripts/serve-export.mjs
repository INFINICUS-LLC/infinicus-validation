// Serves apps/web/out the way the device shell must (POS-8d-2a): static files as they are, and ONE fallback rule for business screens. A business id
// exists only at run time, so the export holds each business screen once under the placeholder id `_`; any address /businesses/<id>/<screen>/ is
// answered with /businesses/_/<screen>/index.html while the browser keeps the real address (the page reads the id from it).
// Dependency-free development tool: `node scripts/serve-export.mjs [port]`. It is not part of the app and holds no secret.
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, normalize, sep } from 'node:path';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'out');
const port = Number(process.argv[2] ?? 4173);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.txt': 'text/plain', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

/**
 * THE fallback rule (pure, easy to copy into the shell): /businesses/<id>/<screen>[/...] is answered with the placeholder file
 * /businesses/_/<screen>[/...]; every other path is unchanged.
 */
export function placeholderPath(cleanPath) {
  const m = /^\/businesses\/([^/]+)\/([^/]+)(\/.*)?$/.exec(cleanPath);
  return m && m[1] !== '_' ? `/businesses/_/${m[2]}${m[3] ?? '/'}` : cleanPath;
}

/** The file to serve for a request path, or null (404). */
export function resolveExportPath(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  const rel = normalize(placeholderPath(clean)).split(sep).join('/');
  if (rel.includes('..')) return null;
  for (const c of [rel, `${rel.replace(/\/$/, '')}/index.html`, `${rel}.html`]) {
    const f = join(out, c);
    if (existsSync(f) && statSync(f).isFile()) return f;
  }
  return null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createServer((req, res) => {
    const f = resolveExportPath(req.url ?? '/');
    if (!f) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[extname(f)] ?? 'application/octet-stream' });
    res.end(readFileSync(f));
  }).listen(port, '127.0.0.1', () => console.log(`serving ${out} on http://127.0.0.1:${port}`));
}
