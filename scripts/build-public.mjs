#!/usr/bin/env node
// Public output builder for the legacy Cloudflare Pages site.
//
//   node scripts/build-public.mjs                      build dist/ from public-manifest.json
//   node scripts/build-public.mjs --check              validate everything, write nothing
//   node scripts/build-public.mjs --compare-routes F   compare Pages Functions routes with a wrangler routes file
//
// Publishes ONLY the files listed in public-manifest.json, plus the generated _headers and _routes.json.
// Everything else in the repository (Stack B, documentation, schemas, archives, scripts, tests, Functions source)
// is internal by default. The script never edits a source file, reads no secret and makes no network call.
import { createHash } from 'node:crypto';
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MANIFEST_FILE = 'public-manifest.json';
export const MAX_PAGES_FILES = 20000;
export const MAX_PAGES_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_RULES = 100;
const GENERATED = Object.freeze(['_headers', '_routes.json']);
const LOCAL_SCHEME = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\{|\$)/i;
const HEADER_NAME = /^[A-Za-z0-9-]+$/;

export class PublicOutputError extends Error {
  constructor(problems) {
    const list = Array.isArray(problems) ? problems : [String(problems)];
    super(`public output validation failed:\n  - ${list.join('\n  - ')}`);
    this.name = 'PublicOutputError';
    this.problems = list;
  }
}

const toPosix = (p) => p.split(sep).join('/');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// ── manifest ───────────────────────────────────────────────────────────────────────────────────────

export function loadManifest(root) {
  const file = join(root, MANIFEST_FILE);
  if (!existsSync(file)) throw new PublicOutputError(`${MANIFEST_FILE} not found in ${root}`);
  let manifest;
  try { manifest = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new PublicOutputError(`${MANIFEST_FILE} is not valid JSON: ${e.message}`); }
  return manifest;
}

/** Normalised, repo-relative POSIX path, or null when the entry is unsafe (absolute, traversal, empty, backslash, NUL). */
export function safeRelativePath(entry) {
  if (typeof entry !== 'string' || entry.length === 0) return null;
  if (entry.includes('\0') || entry.includes('\\') || entry.startsWith('/') || /^[A-Za-z]:/.test(entry)) return null;
  const normal = posix.normalize(entry);
  if (normal === '.' || normal.startsWith('../') || normal === '..' || normal.endsWith('/') || normal !== entry) return null;
  return normal;
}

export function denyReason(path, deny) {
  const base = posix.basename(path);
  const lower = path.toLowerCase();
  for (const dir of deny.directories ?? []) if (path === dir || path.startsWith(`${dir}/`)) return `inside internal directory "${dir}"`;
  for (const prefix of deny.directoryPrefixes ?? []) if (path === prefix || path.startsWith(`${prefix}`)) return `inside internal location "${prefix}"`;
  for (const name of deny.basenames ?? []) if (base === name) return `internal file name "${name}"`;
  for (const ext of deny.extensions ?? []) if (lower.endsWith(ext)) return `internal file type "${ext}"`;
  if (/(^|\/)\.env(\.|$)/.test(path)) return 'environment file';
  if (/\.test\.[cm]?[jt]sx?$/.test(path) || /(^|\/)tests?\//.test(path)) return 'test file';
  return null;
}

export function validateManifest(manifest, root) {
  const problems = [];
  if (manifest?.schemaVersion !== 1) problems.push('schemaVersion must be 1');
  if (manifest?.outputDir !== 'dist') problems.push('outputDir must be "dist"');
  const files = manifest?.files;
  if (!Array.isArray(files) || files.length === 0) {
    problems.push('files must be a non-empty array');
    return problems;
  }
  const seen = new Set();
  for (const entry of files) {
    const path = safeRelativePath(entry);
    if (!path) { problems.push(`unsafe or non-normalised path in files: ${JSON.stringify(entry)}`); continue; }
    if (seen.has(path)) problems.push(`duplicate entry: ${path}`);
    seen.add(path);
    if (GENERATED.includes(path)) problems.push(`${path} is generated and must not be listed`);
    const reason = denyReason(path, manifest.deny ?? {});
    if (reason) problems.push(`${path} is not publishable (${reason})`);
    const abs = join(root, path);
    if (!existsSync(abs)) { problems.push(`declared file does not exist: ${path}`); continue; }
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) problems.push(`declared file is a symlink: ${path}`);
    else if (!st.isFile()) problems.push(`declared path is not a regular file: ${path}`);
    else if (st.size > MAX_PAGES_FILE_BYTES) problems.push(`${path} exceeds the 25 MiB Pages file limit`);
  }
  if (seen.size + GENERATED.length > MAX_PAGES_FILES) problems.push('too many files for Cloudflare Pages');
  const sorted = [...files].sort();
  if (JSON.stringify(sorted) !== JSON.stringify(files.filter((f) => typeof f === 'string'))) problems.push('files must be sorted (byte order) so reviews and builds are deterministic');
  for (const k of manifest.knownMissingReferences ?? []) {
    if (!k || typeof k.ref !== 'string' || typeof k.note !== 'string' || !Array.isArray(k.referencedFrom)) problems.push('knownMissingReferences entries need ref, referencedFrom[] and note');
    else if (existsSync(join(root, k.ref))) problems.push(`knownMissingReferences "${k.ref}" now exists in the repository; declare it or remove the entry`);
  }
  problems.push(...validateRoutes(manifest.routes), ...validateHeaders(manifest.headers));
  return problems;
}

// ── routing and headers ────────────────────────────────────────────────────────────────────────────

export function validateRoutes(routes) {
  const problems = [];
  if (!routes || routes.version !== 1) return ['routes.version must be 1'];
  for (const key of ['include', 'exclude']) {
    if (!Array.isArray(routes[key])) { problems.push(`routes.${key} must be an array`); continue; }
    for (const rule of routes[key]) {
      if (typeof rule !== 'string' || !rule.startsWith('/') || rule.length > 100 || /\s/.test(rule)) problems.push(`routes.${key} has an invalid rule: ${JSON.stringify(rule)}`);
    }
  }
  if (Array.isArray(routes.include) && routes.include.length === 0) problems.push('routes.include must not be empty');
  if ((routes.include?.length ?? 0) + (routes.exclude?.length ?? 0) > MAX_RULES) problems.push(`routes has more than ${MAX_RULES} rules`);
  return problems;
}

export function renderRoutes(routes) {
  return `${JSON.stringify({ version: routes.version, include: routes.include, exclude: routes.exclude }, null, 2)}\n`;
}

export function validateHeaders(headers) {
  const problems = [];
  if (!Array.isArray(headers) || headers.length === 0) return ['headers must be a non-empty array'];
  let rules = 0;
  for (const h of headers) {
    if (typeof h?.pattern !== 'string' || !h.pattern.startsWith('/') || /\s/.test(h.pattern)) { problems.push(`invalid header pattern: ${JSON.stringify(h?.pattern)}`); continue; }
    const entries = Object.entries(h.values ?? {});
    if (entries.length === 0) problems.push(`header pattern ${h.pattern} has no values`);
    for (const [name, value] of entries) {
      rules++;
      if (!HEADER_NAME.test(name)) problems.push(`invalid header name: ${JSON.stringify(name)}`);
      if (typeof value !== 'string' || value.length === 0 || /[\r\n]/.test(value) || `  ${name}: ${value}`.length > 2000) problems.push(`invalid value for header ${name}`);
    }
  }
  if (rules > MAX_RULES) problems.push(`more than ${MAX_RULES} header rules`);
  return problems;
}

export function renderHeaders(headers) {
  return `${headers.map((h) => `${h.pattern}\n${Object.entries(h.values).map(([n, v]) => `  ${n}: ${v}`).join('\n')}`).join('\n\n')}\n`;
}

/** Cloudflare route-pattern match: "*" is the only wildcard (matches any run of characters). */
export function routeMatches(pattern, path) {
  const re = new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return re.test(path);
}

// ── Pages Functions discovery ──────────────────────────────────────────────────────────────────────

const HANDLER = /export\s+(?:async\s+)?(?:function|const)\s+onRequest(?:Get|Post|Put|Delete|Patch|Head|Options)?\b/;

/** Routes Pages derives from functions/ (file-based routing): every .js/.mjs/.ts file exporting an onRequest* handler. */
export function discoverFunctionRoutes(root) {
  const base = join(root, 'functions');
  const routes = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const st = lstatSync(abs);
      if (st.isDirectory()) { walk(abs); continue; }
      if (!/\.(?:js|mjs|ts)$/.test(name)) continue;
      if (!HANDLER.test(readFileSync(abs, 'utf8'))) continue;
      let route = `/${toPosix(relative(base, abs)).replace(/\.(?:js|mjs|ts)$/, '')}`;
      route = route.replace(/\/index$/, '') || '/';
      routes.push(route);
    }
  };
  if (existsSync(base)) walk(base);
  return routes.sort();
}

export function validateFunctionRouting(root, routes) {
  const problems = [];
  const discovered = discoverFunctionRoutes(root);
  if (discovered.length === 0) problems.push('no Pages Functions routes were discovered under functions/');
  for (const r of discovered) {
    if (!routes.include.some((p) => routeMatches(p, r))) problems.push(`Pages Function route ${r} is not covered by routes.include (it would not be invoked)`);
    if (routes.exclude.some((p) => routeMatches(p, r))) problems.push(`Pages Function route ${r} is matched by routes.exclude (it would be served as a static path)`);
  }
  return problems;
}

/** Compares our discovered routes with the routes file written by `wrangler pages functions build`. */
export function compareRoutes(root, wranglerRoutesFile) {
  const theirs = JSON.parse(readFileSync(wranglerRoutesFile, 'utf8')).include ?? [];
  const ours = discoverFunctionRoutes(root);
  const a = [...ours].sort(); const b = [...theirs].sort();
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [`discovered routes differ from wrangler:\n    ours:    ${a.join(' ')}\n    wrangler: ${b.join(' ')}`];
}

// ── static dependency closure ──────────────────────────────────────────────────────────────────────

function resolveRef(fromFile, ref, fromSiteRoot = false) {
  let decoded = ref.trim();
  try { decoded = decodeURIComponent(decoded); } catch { /* keep raw */ }
  const clean = decoded.split('#')[0].split('?')[0];
  if (!clean || LOCAL_SCHEME.test(clean)) return null;
  const joined = clean.startsWith('/') ? posix.normalize(clean.slice(1)) : posix.normalize(posix.join(fromSiteRoot ? '.' : posix.dirname(fromFile), clean));
  return joined.startsWith('../') || joined === '..' ? `!escapes-root:${ref}` : joined;
}

/** Local file references made by one published file. Returns [{ref, target}] (api/ calls are not static files). */
export function extractReferences(file, text, languageCodes = []) {
  const found = [];
  const add = (ref, fromSiteRoot = false) => {
    const target = resolveRef(file, ref, fromSiteRoot);
    if (target && !target.startsWith('api/')) found.push({ ref, target });
  };
  const lowered = file.toLowerCase();
  if (lowered.endsWith('.html')) {
    for (const m of text.matchAll(/\b(?:src|href|poster|data-src)\s*=\s*"([^"]*)"|\b(?:src|href|poster|data-src)\s*=\s*'([^']*)'/gi)) add(m[1] ?? m[2]);
    for (const m of text.matchAll(/\bsrcset\s*=\s*"([^"]*)"/gi)) for (const part of m[1].split(',')) add(part.trim().split(/\s+/)[0]);
    for (const m of text.matchAll(/<meta[^>]+(?:property|name)\s*=\s*["'](?:og:image|twitter:image)["'][^>]*content\s*=\s*["']([^"']+)["']/gi)) add(m[1]);
    for (const m of text.matchAll(/<meta[^>]+content\s*=\s*["']([^"']+)["'][^>]*(?:property|name)\s*=\s*["'](?:og:image|twitter:image)["']/gi)) add(m[1]);
  }
  if (lowered.endsWith('.html') || lowered.endsWith('.css')) {
    for (const m of text.matchAll(/(?<![A-Za-z0-9_$])url\(\s*["']?([^)"']+)["']?\s*\)/gi)) add(m[1]);
  }
  if (lowered.endsWith('.html') || lowered.endsWith('.js')) {
    for (const m of text.matchAll(/serviceWorker\.register\(\s*["']([^"']+)["']/g)) add(m[1]);
    for (const m of text.matchAll(/importScripts\(\s*["']([^"']+)["']/g)) add(m[1]);
    // Bundle files are loaded by the page, so their paths are relative to the site root, not to the loader script.
    for (const m of text.matchAll(/bundleFile\s*:\s*["']([^"']+)["']/g)) add(m[1], true);
    for (const m of text.matchAll(/\.src\s*=\s*["']([^"']+)["']/g)) add(m[1]);
  }
  if (lowered.endsWith('manifest.json')) {
    try {
      const manifest = JSON.parse(text);
      if (manifest.start_url) add(manifest.start_url);
      for (const icon of manifest.icons ?? []) add(icon.src);
      for (const shortcut of manifest.shortcuts ?? []) { add(shortcut.url); for (const icon of shortcut.icons ?? []) add(icon.src); }
    } catch { found.push({ ref: '(manifest.json)', target: '!invalid-json' }); }
  }
  if (file === 'i18n.js') for (const code of languageCodes) if (code !== 'en') found.push({ ref: `i18n/${code}.js (language code "${code}")`, target: `i18n/${code}.js` });
  const seen = new Set();
  return found.filter(({ ref, target }) => { const k = `${ref}\0${target}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

/** Language codes declared by i18n.js (its LANGS table). "en" is built in; every other code loads i18n/<code>.js. */
export function languageCodes(i18nSource) {
  const m = i18nSource.match(/var\s+LANGS\s*=\s*(\[\[[\s\S]*?\]\])\s*;/);
  if (!m) return [];
  return [...m[1].matchAll(/\[\s*["']([a-z]{2,3}(?:-[A-Za-z]+)?)["']/g)].map((x) => x[1]);
}

export function analyzeClosure(root, manifest) {
  const problems = [];
  const declared = new Set(manifest.files);
  const knownMissing = new Map((manifest.knownMissingReferences ?? []).map((k) => [k.ref, k]));
  const usedKnown = new Set();
  const i18nPath = join(root, 'i18n.js');
  const codes = declared.has('i18n.js') && existsSync(i18nPath) ? languageCodes(readFileSync(i18nPath, 'utf8')) : [];
  if (declared.has('i18n.js') && codes.length === 0) problems.push('i18n.js: could not read the LANGS table (cannot verify localisation files)');
  const references = [];
  for (const file of manifest.files) {
    if (!/\.(?:html|js|css|json)$/i.test(file)) continue;
    const abs = join(root, file);
    if (!existsSync(abs)) continue;
    for (const { ref, target } of extractReferences(file, readFileSync(abs, 'utf8'), codes)) {
      references.push({ from: file, ref, target });
      if (target.startsWith('!')) { problems.push(`${file}: unresolvable reference ${ref} (${target.slice(1)})`); continue; }
      if (declared.has(target)) continue;
      if (knownMissing.has(target) && knownMissing.get(target).referencedFrom.includes(file)) { usedKnown.add(target); continue; }
      problems.push(existsSync(join(root, target))
        ? `${file} references ${target}, which exists in the repository but is NOT declared public (internal by default; publishing it needs explicit approval)`
        : `${file} references ${target}, which does not exist and is not a documented known-missing reference`);
    }
  }
  for (const k of knownMissing.keys()) if (!usedKnown.has(k)) problems.push(`knownMissingReferences "${k}" is no longer referenced as declared; remove or correct the entry`);
  // Drift guard: a new language file would be loaded by code only after i18n.js lists it, so it must be a deliberate decision.
  const i18nDir = join(root, 'i18n');
  if (existsSync(i18nDir)) {
    for (const name of readdirSync(i18nDir)) {
      if (/\.js$/.test(name) && !declared.has(`i18n/${name}`)) problems.push(`i18n/${name} exists but is not declared public`);
    }
  }
  return { problems, references };
}

// ── build ──────────────────────────────────────────────────────────────────────────────────────────

function walkFiles(dir) {
  const out = [];
  const visit = (d) => {
    for (const name of readdirSync(d).sort()) {
      const abs = join(d, name);
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) { out.push({ abs, symlink: true }); continue; }
      if (st.isDirectory()) visit(abs); else out.push({ abs, symlink: false });
    }
  };
  visit(dir);
  return out;
}

export function verifyOutput(outDir, manifest) {
  const problems = [];
  const allowed = new Set([...manifest.files, ...GENERATED]);
  const present = new Set();
  for (const { abs, symlink } of walkFiles(outDir)) {
    const rel = toPosix(relative(outDir, abs));
    present.add(rel);
    if (symlink) problems.push(`output contains a symlink: ${rel}`);
    if (!allowed.has(rel)) problems.push(`output contains an undeclared file: ${rel}`);
    const reason = GENERATED.includes(rel) ? null : denyReason(rel, manifest.deny ?? {});
    if (reason) problems.push(`output contains an internal file: ${rel} (${reason})`);
  }
  for (const f of allowed) if (!present.has(f)) problems.push(`output is missing ${f}`);
  if (present.size > MAX_PAGES_FILES) problems.push('output has too many files for Cloudflare Pages');
  return problems;
}

/** SHA-256 over sorted "path NUL content-hash" lines: identical inputs always give the identical digest. */
export function treeDigest(dir) {
  const lines = walkFiles(dir).map(({ abs }) => `${toPosix(relative(dir, abs))}\0${sha256(readFileSync(abs))}`).sort();
  return sha256(lines.join('\n'));
}

export function validateAll(root, manifest = loadManifest(root)) {
  const problems = validateManifest(manifest, root);
  if (problems.length === 0) problems.push(...analyzeClosure(root, manifest).problems, ...validateFunctionRouting(root, manifest.routes));
  return problems;
}

/** Builds the output directory. Returns { outDir, files, digest }. Throws PublicOutputError and writes nothing on invalid input. */
export function buildPublic({ root = process.cwd(), outDir, manifest = loadManifest(root) } = {}) {
  const rootAbs = resolve(root);
  const problems = validateAll(rootAbs, manifest);
  if (problems.length) throw new PublicOutputError(problems);
  const defaultOut = join(rootAbs, manifest.outputDir);
  const target = resolve(outDir ?? defaultOut);
  if (target === rootAbs || rootAbs.startsWith(`${target}${sep}`) || target.startsWith(`${join(rootAbs, '.git')}`)) throw new PublicOutputError(`refusing unsafe output directory: ${target}`);
  if (target === defaultOut) rmSync(target, { recursive: true, force: true });
  else if (existsSync(target) && readdirSync(target).length > 0) throw new PublicOutputError(`custom output directory must be empty: ${target}`);
  mkdirSync(target, { recursive: true });
  for (const file of manifest.files) {
    const dest = join(target, file);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(rootAbs, file), dest);
  }
  writeFileSync(join(target, '_headers'), renderHeaders(manifest.headers));
  writeFileSync(join(target, '_routes.json'), renderRoutes(manifest.routes));
  const outputProblems = verifyOutput(target, manifest);
  if (outputProblems.length) throw new PublicOutputError(outputProblems);
  return { outDir: target, files: manifest.files.length + GENERATED.length, digest: treeDigest(target) };
}

// ── CLI ────────────────────────────────────────────────────────────────────────────────────────────

function main(argv) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  try {
    const compareIdx = argv.indexOf('--compare-routes');
    if (compareIdx !== -1) {
      const problems = compareRoutes(root, argv[compareIdx + 1]);
      if (problems.length) throw new PublicOutputError(problems);
      console.log('Pages Functions routes match wrangler.');
      return 0;
    }
    if (argv.includes('--check')) {
      const problems = validateAll(root);
      if (problems.length) throw new PublicOutputError(problems);
      console.log('Public output manifest is valid (nothing written).');
      return 0;
    }
    const { outDir, files, digest } = buildPublic({ root });
    console.log(`Built ${files} files into ${toPosix(relative(root, outDir)) || '.'}/\nTree digest: sha256:${digest}`);
    return 0;
  } catch (e) {
    if (e instanceof PublicOutputError) { console.error(e.message); return 1; }
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = main(process.argv.slice(2));
