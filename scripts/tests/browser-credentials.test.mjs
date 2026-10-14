// AC-3 Block 4 (J-3 + J-7): static guard over index.html + execution of the real API_BASE_URL expression.
// Run: node --test scripts/tests/browser-credentials.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

const START = '// ─── BACKEND SIMULATION BRIDGE';
const END = '// ─── SIMULATION CONTROLS';
const bridgeStart = html.indexOf(START);
const bridgeEnd = html.indexOf(END);
assert.ok(bridgeStart > 0 && bridgeEnd > bridgeStart, 'bridge region markers must exist in index.html');
const bridgeRaw = html.slice(bridgeStart, bridgeEnd);
// Comments may legitimately describe what was removed; the guard looks at executable code only.
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
const bridge = stripComments(bridgeRaw);
const page = stripComments(html);

test('bridge code has no password handling, derivation or WebCrypto digest', () => {
  for (const re of [/password/i, /deriveShadow/i, /crypto\.subtle/i, /\.digest\(/, /SHA-256/i, /shadow/i]) {
    assert.doesNotMatch(bridge, re, `forbidden in bridge code: ${re}`);
  }
});

test('the page contains no managed-account domain and never calls password login/register', () => {
  assert.ok(!html.includes('@infini-cus.local'), 'managed-account domain must not appear anywhere in the page');
  assert.doesNotMatch(page, /\/v1\/auth\/login/);
  assert.doesNotMatch(page, /\/v1\/auth\/register/);
});

test('no server-only secret names appear in the page', () => {
  for (const name of ['SHADOW_ACCOUNT_SECRET', 'SUPABASE_SERVICE_ROLE', 'service_role', 'DATABASE_URL', 'ADMIN_DATABASE_URL', 'RESEND_API_KEY']) {
    assert.ok(!html.includes(name), `server-only secret name in page: ${name}`);
  }
});

test('the exchange sends ONLY the access token', () => {
  const calls = [...bridge.matchAll(/backendFetch\('\/v1\/auth\/identity-exchange',\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}\)/g)];
  assert.equal(calls.length, 1, 'exactly one identity-exchange call');
  assert.match(calls[0][1], /body:\s*\{\s*accessToken:\s*sess\.access_token\s*\}/);
  assert.equal([...calls[0][1].matchAll(/\baccessToken\b/g)].length, 1);
  assert.match(bridge, /SUPA\.auth\.getSession\(\)/);
});

test('the backend session token lives in sessionStorage only; localStorage never receives it', () => {
  assert.match(bridge, /BACKEND_SESSION_KEY\s*=\s*'inf_backend_session_v1'/);
  assert.match(bridge, /BACKEND_SESSION_TTL_MS\s*=\s*10\s*\*\s*60\s*\*\s*1000/);
  assert.match(bridge, /sessionStorage\.setItem\(BACKEND_SESSION_KEY,/);
  const lsWrites = [...bridge.matchAll(/localStorage\.setItem\(([^\n;]*)\); \}/g)].map((m) => m[1].trim());
  assert.deepEqual(lsWrites, ['BACKEND_IDS_KEY, JSON.stringify(rec)'], 'the only localStorage write is the id record');
  assert.ok(!/localStorage[^;\n]*token/i.test(bridge) && !/token[^;\n]*localStorage/i.test(bridge));
});

test('the localStorage id record holds exactly the four non-secret ids', () => {
  assert.match(bridge, /BACKEND_IDS_KEY\s*=\s*'inf_backend_account_v3'/);
  const rec = bridge.match(/const rec = \{([\s\S]*?)\};/);
  assert.ok(rec, 'rec literal present');
  const keys = [...rec[1].matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
  assert.deepEqual(keys, ['backendUserId', 'tenantId', 'workspaceId', 'businessId']);
});

test('one-time purge of v1/v2 migrates exactly the three non-secret ids', () => {
  assert.match(bridge, /\['inf_backend_account_v2', 'inf_backend_account_v1'\]/);
  assert.match(bridge, /localStorage\.removeItem\(key\)/);
  const mig = bridge.match(/migrated = \{([^}]*)\}/);
  assert.ok(mig, 'migration literal present');
  assert.deepEqual([...mig[1].matchAll(/(\w+):/g)].map((m) => m[1]), ['tenantId', 'workspaceId', 'businessId']);
  assert.match(bridge, /purgeLegacyBackendAccounts\(\);/);
});

test('adoption of the first verified backend user id is persisted', () => {
  assert.match(bridge, /ids\.backendUserId = session\.backendUserId;\s*\n\s*saveBackendIds\(ids\);/);
});

test('the backend session is cleared on SIGNED_OUT and when the Supabase user changes', () => {
  assert.match(page, /event === 'SIGNED_OUT'\) \{\s*\n\s*if \(typeof clearBackendSession === 'function'\) clearBackendSession\(\);/);
  assert.match(page, /prev\.supaId && prev\.supaId !== session\.user\.id[^\n]*clearBackendSession\(\)/);
  assert.match(bridge, /sessionStorage\.removeItem\(BACKEND_SESSION_KEY\)/);
  assert.match(bridge, /s\.forSupaId === supaId/);
});

test('tenant slug is random, never derived from the provider id', () => {
  const slugLine = bridge.split('\n').find((l) => l.includes('tenantSlug:'));
  assert.ok(slugLine);
  assert.doesNotMatch(slugLine, /supaId/i);
  assert.match(bridge, /slugSeed\s*=[^\n]*crypto\.randomUUID\(\)\.slice\(0, 8\)/);
  assert.doesNotMatch(bridge, /supaId\.slice/);
});

// ── J-7: execute the REAL expression under different hostnames / overrides ─────────────────────────────────
const exprMatch = bridge.match(/const API_BASE_URL = \(function \(\) \{[\s\S]*?\n\}\)\(\);/);
assert.ok(exprMatch, 'API_BASE_URL expression present');
function resolveApiBase(hostname, stored, { throws = false } = {}) {
  const removed = [];
  const ctx = vm.createContext({
    location: { hostname },
    localStorage: {
      getItem: (k) => { if (throws) throw new Error('blocked'); return k === 'inf_api_base_url' ? stored ?? null : null; },
      removeItem: (k) => { removed.push(k); },
    },
  });
  const value = vm.runInContext(`${exprMatch[0]}\nAPI_BASE_URL`, ctx);
  return { value, removed };
}
const PROD = 'https://api.infini-cus.com';
const LOCAL = 'http://127.0.0.1:3000';

test('J-7: on the real site no override is honoured, the stored one is removed, and the default is production (never local)', () => {
  for (const host of ['infini-cus.com', 'www.infini-cus.com', 'evil.example', 'localhost.evil.com', 'infinicus.pages.dev']) {
    for (const stored of ['https://evil.example', 'http://127.0.0.1:3000', 'http://localhost:3000', 'https://api.infini-cus.com.evil.com']) {
      const { value, removed } = resolveApiBase(host, stored);
      assert.equal(value, PROD, `${host} + ${stored}`);
      assert.deepEqual(removed, ['inf_api_base_url']);
    }
    assert.equal(resolveApiBase(host, null).value, PROD);
    assert.equal(resolveApiBase(host, null, { throws: true }).value, PROD);
  }
});

test('J-7: on localhost only a loopback http origin override is honoured', () => {
  for (const host of ['localhost', '127.0.0.1']) {
    for (const ok of ['http://127.0.0.1:3999', 'http://localhost:4000', 'http://localhost', 'http://127.0.0.1']) {
      assert.equal(resolveApiBase(host, ok).value, ok);
    }
    for (const bad of ['https://evil.example', 'https://localhost:3000', 'http://127.0.0.1.evil.com', 'http://127.0.0.1:3000/path', 'http://localhost:3000@evil.com', 'http://evil.com/http://127.0.0.1', 'http://127.0.0.1:abc', 'HTTP://LOCALHOST:3000']) {
      assert.equal(resolveApiBase(host, bad).value, LOCAL, bad);
    }
    assert.equal(resolveApiBase(host, null).value, LOCAL);
    assert.equal(resolveApiBase(host, null, { throws: true }).value, LOCAL);
  }
});

test('every inline script of index.html parses', () => {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter((m) => !/\bsrc\s*=/.test(m[1]) && !/type\s*=\s*["'](?!text\/javascript|module)/i.test(m[1]) && m[2].trim());
  assert.ok(scripts.length > 0);
  for (const [i, m] of scripts.entries()) {
    assert.doesNotThrow(() => new vm.Script(m[2], { filename: `index.html#script${i}` }), `inline script ${i} must parse`);
  }
});
