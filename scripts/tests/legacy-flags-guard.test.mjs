// AC-3 Block 5 (J-4 / J-5): no tracked deployment/config file may switch ON the legacy unauthenticated route families
// (LEGACY_AUTH_API, LEGACY_BUSINESS_API) or live outbound email (EMAIL_MODE=live). Production flag state itself is NOT
// knowable from the repository; this only guarantees that a commit cannot enable them by accident.
// Run: node --test scripts/tests/legacy-flags-guard.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// A line that ASSIGNS the flag (KEY=value, KEY = "value", KEY: value, "KEY": "value"), as opposed to code comparing against it.
const ENABLING = [
  { name: 'LEGACY_AUTH_API', re: /\bLEGACY_AUTH_API["']?\s*[=:]\s*["']?enabled\b/ },
  { name: 'LEGACY_BUSINESS_API', re: /\bLEGACY_BUSINESS_API["']?\s*[=:]\s*["']?enabled\b/ },
  { name: 'EMAIL_MODE', re: /\bEMAIL_MODE["']?\s*[=:]\s*["']?live\b/ },
];
const TEXT_EXT = new Set(['.toml', '.yml', '.yaml', '.json', '.env', '.example', '.sh', '.bat', '.cmd', '.ps1', '.conf', '.ini', '.cfg', '.txt', '.vars', '.html', '.js', '.mjs', '.ts']);

/** Findings in a text: [{ flag, line }]. */
export function findEnablingAssignments(text) {
  const out = [];
  text.split('\n').forEach((line, i) => {
    for (const { name, re } of ENABLING) if (re.test(line)) out.push({ flag: name, line: i + 1 });
  });
  return out;
}

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean);
// Function source and these guard tests legitimately mention the flags; everything else is configuration or deployment.
const isExempt = (f) => f.startsWith('functions/') || f.startsWith('scripts/tests/') || f.endsWith('.md');

test('the detector flags assignments and ignores comparisons', () => {
  assert.equal(findEnablingAssignments('LEGACY_AUTH_API=enabled').length, 1);
  assert.equal(findEnablingAssignments('  LEGACY_BUSINESS_API = "enabled"').length, 1);
  assert.equal(findEnablingAssignments('"EMAIL_MODE": "live"').length, 1);
  assert.equal(findEnablingAssignments('env:\n  EMAIL_MODE: live').length, 1);
  assert.equal(findEnablingAssignments("if (env.LEGACY_AUTH_API === 'enabled') {}").length, 0);
  assert.equal(findEnablingAssignments('# do NOT set LEGACY_AUTH_API=disabled-by-default').length, 0);
  assert.equal(findEnablingAssignments('EMAIL_MODE=log').length, 0);
});

test('no tracked configuration or deployment file enables a legacy route family or live email', () => {
  const offenders = [];
  let scanned = 0;
  for (const f of tracked) {
    if (isExempt(f) || !TEXT_EXT.has(path.extname(f).toLowerCase()) && !/(^|\/)\.(env|dev\.vars)/.test(f)) continue;
    let text;
    try {
      if (statSync(path.join(root, f)).size > 2 * 1024 * 1024) continue;
      text = readFileSync(path.join(root, f), 'utf8');
    } catch { continue; }
    scanned += 1;
    for (const hit of findEnablingAssignments(text)) offenders.push(`${f}:${hit.line} ${hit.flag}`);
  }
  assert.ok(scanned > 50, `scanned only ${scanned} files; the guard would be vacuous`);
  assert.deepEqual(offenders, [], `these files would switch on a default-denied surface: ${offenders.join(', ')}`);
});

test('wrangler.toml declares no [vars] block that could carry the flags', () => {
  const toml = readFileSync(path.join(root, 'wrangler.toml'), 'utf8');
  for (const name of ['LEGACY_AUTH_API', 'LEGACY_BUSINESS_API', 'EMAIL_MODE']) {
    assert.ok(!new RegExp(`^\\s*${name}\\s*=`, 'm').test(toml), `${name} must not be set in wrangler.toml`);
  }
});
