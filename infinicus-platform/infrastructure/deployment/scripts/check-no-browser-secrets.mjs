#!/usr/bin/env node
// BUILD-24 — Browser-secret-prevention check.
//
// Next.js inlines any environment variable referenced as
// `process.env.NEXT_PUBLIC_*` into the client-side bundle at build time;
// `process.env.X` without that prefix is only ever available server-side.
// This script statically scans every app under apps/ that ships browser
// code (apps/web, apps/admin) for two failure modes:
//
//   1. `process.env.NEXT_PUBLIC_<SECRET_NAME>` where <SECRET_NAME> is
//      classified 'secret' in @infinicus/configuration's SECRET_INVENTORY
//      — this would genuinely ship the secret to every browser.
//   2. `process.env.<SECRET_NAME>` (any classification, no NEXT_PUBLIC_
//      prefix) referenced from inside a 'use client' file — even though
//      Next.js would not inline it (so it isn't a leak), a client
//      component reading it would only ever see `undefined` at runtime,
//      which is itself a real bug worth failing the build on.
//
// What is scanned (S-1): the directories that actually hold browser-reachable source, apps/web/app, apps/web/lib and apps/admin/src. A configured
// directory that is missing, or holds no source file, FAILS the check: a scan of nothing must never read as a pass (it used to, when the list named
// apps/web/src, which does not exist). Files under lib/client or app/(client) are browser code even without a 'use client' directive (they are plain
// modules imported by client components), so they are treated as client files for failure mode 2.
//
// Usage: node check-no-browser-secrets.mjs [rootDir]
// Exit code: 0 if clean, 1 if any violation is found (each printed to stderr).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(scriptDir, '..', '..', '..');
// resolve(), not join(): argv[2] may be an absolute path (used by tests to
// point at a fixture directory) — join() would incorrectly concatenate it
// onto process.cwd() instead of treating it as absolute.
const rootDir = process.argv[2] ? resolve(process.cwd(), process.argv[2]) : repoRoot;

const { SECRET_INVENTORY } = await import(join(repoRoot, 'packages', 'configuration', 'dist', 'index.js'));
const SECRET_NAMES = SECRET_INVENTORY.filter((s) => s.classification === 'secret').map((s) => s.name);

const BROWSER_APP_DIRS = ['apps/web/app', 'apps/web/lib', 'apps/admin/src'];
/** Path fragments that mark browser-only code that carries no 'use client' directive of its own. */
const BROWSER_ONLY_PATH = /(^|[\\/])(lib[\\/]client|app[\\/]\(client\))([\\/]|$)/;
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...walk(full));
    } else if (SOURCE_EXTENSIONS.has(entry.slice(entry.lastIndexOf('.')))) {
      files.push(full);
    }
  }
  return files;
}

function isClientFile(content) {
  const firstNonEmptyLine = content.split('\n').find((line) => line.trim().length > 0) ?? '';
  return /^['"]use client['"];?$/.test(firstNonEmptyLine.trim());
}

const violations = [];
let scannedFiles = 0;

for (const appDir of BROWSER_APP_DIRS) {
  const absoluteAppDir = join(rootDir, appDir);
  const files = walk(absoluteAppDir);
  if (files.length === 0) {
    violations.push(`${appDir}: configured browser source directory is missing or contains no source files — the scan would check nothing here. Fix the directory list in check-no-browser-secrets.mjs if the layout changed.`);
    continue;
  }
  for (const file of files) {
    scannedFiles += 1;
    const content = readFileSync(file, 'utf8');
    const relPath = relative(rootDir, file);
    const clientFile = isClientFile(content) || BROWSER_ONLY_PATH.test(relPath);

    for (const secretName of SECRET_NAMES) {
      const nextPublicPattern = new RegExp(`process\\.env\\.NEXT_PUBLIC_${secretName}\\b`);
      if (nextPublicPattern.test(content)) {
        violations.push(`${relPath}: references process.env.NEXT_PUBLIC_${secretName} — this would ship the secret "${secretName}" to every browser.`);
      }

      if (clientFile) {
        const clientReadPattern = new RegExp(`process\\.env\\.${secretName}\\b`);
        if (clientReadPattern.test(content)) {
          violations.push(`${relPath}: browser-side file ('use client', or under lib/client or app/(client)) references process.env.${secretName} directly — this is always undefined in the browser and indicates a bug, even though Next.js would not inline it.`);
        }
      }
    }
  }
}

if (violations.length > 0) {
  console.error(`Browser-secret check FAILED — ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}

console.log(`Browser-secret check passed — scanned ${scannedFiles} file(s) in ${BROWSER_APP_DIRS.join(', ')} against ${SECRET_NAMES.length} known secret(s).`);
