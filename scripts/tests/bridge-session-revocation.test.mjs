// AC-3 Release Block R1 (R1-02): behavioural tests for sign-out revocation and user-switch handling in index.html.
//
// These run the page's REAL code - the backend bridge region, signOut(), signOutEngine() and the SUPA.auth.onAuthStateChange listener -
// inside a vm sandbox against a fake Supabase and a fake backend that honours the real API contract
// (POST /v1/auth/identity-exchange -> session token; POST /v1/auth/logout -> 204 and the token is dead, later use -> 401).
// Nothing here talks to a network, a real account or production. Run: node --test scripts/tests/bridge-session-revocation.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

// ── extract the real page code ───────────────────────────────────────────────────────────────────────────
const between = (src, from, to) => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `markers not found: ${from} .. ${to}`);
  return src.slice(a, b);
};
const BRIDGE = between(html, '// ─── BACKEND SIMULATION BRIDGE', '// ─── SIMULATION CONTROLS');
const LISTENER = between(html, 'SUPA.auth.onAuthStateChange(', '\nasync function supabaseSaveSimulation');
const fn = (name) => {
  const m = html.match(new RegExp(`async function ${name}\\(\\) \\{[\\s\\S]*?\\n\\}\\n`));
  assert.ok(m, `${name} not found`);
  return m[0];
};
const SIGN_OUT_FUNCTIONS = fn('signOutEngine') + fn('signOut');

const PROD_API = 'https://api.infini-cus.com';
const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 8; i++) await tick(); };
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

// ── fake backend honouring the real contract ─────────────────────────────────────────────────────────────
class FakeBackend {
  constructor() {
    this.live = new Map();        // backend session token -> backend user id
    this.minted = [];             // every token ever issued
    this.requests = [];           // { method, path, url, auth }
    this.logoutMode = 'normal';   // normal | 401 | 503 | network | hang
    this.exchangeGate = null;     // promise the identity-exchange response waits for
    this.n = 0;
  }
  respond(status, body) {
    return { status, ok: status >= 200 && status < 300, text: async () => (body == null ? '' : JSON.stringify(body)) };
  }
  async fetch(url, init = {}) {
    const u = new URL(url);
    const auth = (init.headers && init.headers.Authorization) ? String(init.headers.Authorization).replace(/^Bearer /, '') : null;
    this.requests.push({ method: init.method || 'GET', path: u.pathname, url, auth });
    const body = init.body ? JSON.parse(init.body) : null;
    if (u.pathname === '/v1/auth/identity-exchange') {
      if (this.exchangeGate) await this.exchangeGate;
      if (!body || typeof body.accessToken !== 'string' || !body.accessToken.startsWith('sb-token-')) return this.respond(401, { error: {} });
      const supaId = body.accessToken.slice('sb-token-'.length);
      const token = `bt-${++this.n}-${supaId}`;
      this.live.set(token, `bu-${supaId}`);
      this.minted.push(token);
      return this.respond(200, { user: { id: `bu-${supaId}`, email: 'managed', status: 'active' }, sessionId: `s${this.n}`, rawSessionToken: token });
    }
    if (u.pathname === '/v1/auth/logout') {
      if (this.logoutMode === 'network') throw new TypeError('network down');
      if (this.logoutMode === 'hang') {
        return new Promise((_, reject) => init.signal && init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
      }
      if (this.logoutMode === '503') return this.respond(503, { error: {} });
      if (this.logoutMode === '401') return this.respond(401, { error: {} });
      if (!this.live.has(auth)) return this.respond(401, { error: {} });
      this.live.delete(auth);
      return this.respond(204, null);
    }
    if (!auth || !this.live.has(auth)) return this.respond(401, { error: {} });
    const id = ++this.n;
    if (u.pathname === '/v1/onboarding') return this.respond(200, { tenant: { id: `t-${id}` }, workspace: { id: `w-${id}` }, progress: { id: `p-${id}` } });
    if (/\/business$/.test(u.pathname)) return this.respond(200, { business: { id: `b-${id}` }, progress: {} });
    if (/\/owner$/.test(u.pathname)) return this.respond(200, {});
    return this.respond(404, {});
  }
}

const mkStorage = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, _m: m };
};

// ── the sandbox world ────────────────────────────────────────────────────────────────────────────────────
function createWorld({ hostname = 'infini-cus.com', storedOverride = null } = {}) {
  const backend = new FakeBackend();
  const localStorage = mkStorage();
  const sessionStorage = mkStorage();
  if (storedOverride) localStorage.setItem('inf_api_base_url', storedOverride);
  const consoleLines = [];
  const events = [];                      // ordered record of notable calls
  const redirects = [];
  let subscriber = null;
  let uuid = 0;

  const supa = {
    session: null,
    auth: {
      onAuthStateChange: (cb) => { subscriber = cb; },
      getSession: async () => ({ data: { session: supa.session } }),
      signOut: async () => { events.push('supabase.signOut'); supa.session = null; if (subscriber) await subscriber('SIGNED_OUT', null); },
    },
    from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: null }) }) }) }),
  };
  const sessionFor = (supaId) => ({ access_token: `sb-token-${supaId}`, user: { id: supaId, email: `${supaId}@example.test`, email_confirmed_at: '2026-10-01T00:00:00Z', created_at: '2026-10-01T00:00:00Z' } });

  const cryptoStub = { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}` };
  const sandbox = {
    console: { log: (...a) => consoleLines.push(a.map(String).join(' ')), warn: (...a) => consoleLines.push(a.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ')), error: (...a) => consoleLines.push(a.map(String).join(' ')) },
    setTimeout: (f, ms) => setTimeout(f, Math.min(ms, 40)),   // the real 4 s revocation timeout fires after 40 ms here
    clearTimeout,
    AbortController,
    URL,
    location: { hostname },
    localStorage,
    sessionStorage,
    crypto: cryptoStub,
    document: { getElementById: () => null },
    fetch: async (url, init) => { events.push(`fetch ${(init && init.method) || 'GET'} ${new URL(url).pathname}`); return backend.fetch(url, init); },
    __supa: supa,
    __events: events,
    __redirects: redirects,
  };
  sandbox.window = { crypto: cryptoStub, location: { replace: (u) => redirects.push(u) } };
  const ctx = vm.createContext(sandbox);
  const run = (code) => vm.runInContext(code, ctx);

  run('let U = null; let _pendingSimAfterReg = false; function saveUser() {} function renderUserBadge() {} function closeUserMenu() {} const SUPA = __supa;');
  run(BRIDGE);
  run(SIGN_OUT_FUNCTIONS);
  run(LISTENER);                          // registers the real onAuthStateChange callback on the fake SUPA

  const world = {
    backend, localStorage, sessionStorage, consoleLines, events, redirects, supa, run,
    /** Fire the real listener the way supabase-js does. */
    fire: async (event, session) => { supa.session = session; await subscriber(event, session); },
    signInAs: async (supaId) => { await world.fire('SIGNED_IN', sessionFor(supaId)); },
    ensure: () => run('ensureBackendBusiness()'),
    storedSession: () => { const raw = sessionStorage.getItem('inf_backend_session_v1'); return raw ? JSON.parse(raw) : null; },
    ids: () => { const raw = localStorage.getItem('inf_backend_account_v3'); return raw ? JSON.parse(raw) : null; },
    lastRevocation: () => run('lastBackendRevocation'),
    sessionFor,
  };
  return world;
}

/** No credential may appear in console output, request URLs, or localStorage. */
function assertNoLeak(world, where) {
  for (const token of world.backend.minted) {
    assert.ok(!world.consoleLines.join('\n').includes(token), `${where}: a session token reached the console`);
    assert.ok(!world.backend.requests.some((r) => r.url.includes(token)), `${where}: a session token reached a URL`);
    assert.ok(![...world.localStorage._m.values()].some((v) => v.includes(token)), `${where}: a session token reached localStorage`);
  }
  for (const [k, v] of world.localStorage._m) assert.ok(!/passw/i.test(k + v), `${where}: credential-like data in localStorage (${k})`);
}

const signedInEnsured = async (supaId = 'user-a', opts) => {
  const world = createWorld(opts);
  await world.signInAs(supaId);
  const acct = await world.ensure();
  return { world, acct };
};

// ── 1-3: explicit sign-out ───────────────────────────────────────────────────────────────────────────────
test('explicit sign-out revokes the backend session on the server, then signs out of Supabase, then leaves the page', async () => {
  const { world, acct } = await signedInEnsured();
  assert.ok(world.backend.live.has(acct.token), 'precondition: the backend session is live');
  world.events.length = 0;
  await world.run('signOutEngine()');
  assert.equal(world.backend.live.has(acct.token), false, 'the server no longer accepts the token');
  assert.equal(world.storedSession(), null, 'browser session state is gone');
  assert.deepEqual(world.events.filter((e) => /logout|supabase\.signOut/.test(e)), ['fetch POST /v1/auth/logout', 'supabase.signOut'], 'revocation happens BEFORE signing out of Supabase');
  assert.equal(world.lastRevocation().ok, true);
  assert.equal(world.lastRevocation().status, 204);
  assert.deepEqual(world.redirects, ['./landing.html']);
  // the revoked token is dead on the server for any later use
  const reuse = await world.backend.fetch(`${PROD_API}/v1/onboarding`, { method: 'POST', headers: { Authorization: `Bearer ${acct.token}` } });
  assert.equal(reuse.status, 401);
  assertNoLeak(world, 'signOutEngine');
});

test('signOut() (the second sign-out entry point) behaves identically', async () => {
  const { world, acct } = await signedInEnsured('user-b');
  await world.run('signOut()');
  assert.equal(world.backend.live.has(acct.token), false);
  assert.equal(world.storedSession(), null);
  assert.deepEqual(world.redirects, ['./landing.html']);
  assertNoLeak(world, 'signOut');
});

test('the SIGNED_OUT event alone (e.g. sign-out from another path or tab) also revokes', async () => {
  const { world, acct } = await signedInEnsured('user-c');
  await world.fire('SIGNED_OUT', null);
  await settle();
  assert.equal(world.backend.live.has(acct.token), false);
  assert.equal(world.storedSession(), null);
  assertNoLeak(world, 'SIGNED_OUT event');
});

test('non-sensitive browser data survives sign-out: the id record (no credential) stays, so the same user keeps the same business', async () => {
  const { world } = await signedInEnsured('user-d');
  const before = world.ids();
  assert.ok(before.tenantId && before.workspaceId && before.businessId);
  await world.run('signOutEngine()');
  assert.deepEqual(world.ids(), before);
});

// ── 4-6: failure of the server call never keeps local state, and is reported honestly ────────────────────
for (const [mode, expected] of [['401', { status: 401, reason: 'token-not-accepted' }], ['503', { status: 503, reason: 'http-error' }], ['network', { reason: 'network' }], ['hang', { reason: 'timeout' }]]) {
  test(`logout answering "${mode}": local state is cleared, the failure is recorded and observable, nothing is claimed as revoked, and sign-out still completes`, async () => {
    const { world, acct } = await signedInEnsured(`user-${mode}`);
    world.backend.logoutMode = mode;
    await world.run('signOutEngine()');
    assert.equal(world.storedSession(), null, 'local session cleared');
    assert.equal(world.lastRevocation().ok, false, 'must not claim the server revoked it');
    for (const [k, v] of Object.entries(expected)) assert.equal(world.lastRevocation()[k], v);
    assert.ok(world.consoleLines.some((l) => l.includes('[backend-session] server-side revocation not confirmed')), 'observable on the console');
    assert.ok(world.events.includes('supabase.signOut'), 'Supabase sign-out still happens');
    assert.deepEqual(world.redirects, ['./landing.html']);
    if (mode !== '401') assert.equal(world.backend.live.has(acct.token), true, 'the fake server really did keep it - the browser is not pretending otherwise');
    // the cleared token is never used again by the page
    world.backend.requests.length = 0;
    await world.signInAs('user-' + mode);
    await world.ensure();
    assert.ok(!world.backend.requests.some((r) => r.auth === acct.token), 'the old token is not reused after sign-out');
    assertNoLeak(world, `logout ${mode}`);
  });
}

// ── 7: user switching ────────────────────────────────────────────────────────────────────────────────────
test('a different Supabase user becoming active revokes the previous backend session and never sends it as authority for the new user', async () => {
  const { world, acct: a } = await signedInEnsured('user-a');
  world.backend.requests.length = 0;
  await world.signInAs('user-b');                         // real listener: prev.supaId !== new id
  await settle();
  assert.equal(world.backend.live.has(a.token), false, "user A's backend session was revoked on the server");
  const b = await world.ensure();
  assert.notEqual(b.token, a.token);
  assert.notEqual(b.backendUserId, a.backendUserId);
  assert.notEqual(b.businessId, a.businessId, "B does not inherit A's business");
  assert.ok(!world.backend.requests.some((r) => r.auth === a.token && r.path !== '/v1/auth/logout'), "A's token was never used as authority after the switch");
  assert.equal(world.storedSession().forSupaId, 'user-b');
  assertNoLeak(world, 'user switch');
});

test('user switch without a listener event (stale stored session for another user) is discarded and revoked, never reused', async () => {
  const { world, acct: a } = await signedInEnsured('user-a');
  world.backend.requests.length = 0;   // only what happens AFTER the switch is under test
  world.run("U = { email: 'b@example.test', supaId: 'user-b' }");
  world.supa.session = world.sessionFor('user-b');
  const b = await world.ensure();
  await settle();
  assert.equal(world.backend.live.has(a.token), false);
  assert.notEqual(b.token, a.token);
  assert.ok(world.backend.requests.filter((r) => r.auth === a.token).every((r) => r.path === '/v1/auth/logout'), "A's token was only ever used to revoke itself");
});

// ── 8: late exchange responses ───────────────────────────────────────────────────────────────────────────
test('an identity exchange that finishes after sign-out does not restore a session: the result is discarded and revoked', async () => {
  const world = createWorld();
  await world.signInAs('user-a');
  const gate = deferred();
  world.backend.exchangeGate = gate.promise;
  const pending = world.ensure();
  await settle();
  assert.equal(world.backend.minted.length, 0, 'precondition: the exchange is still in flight');
  await world.fire('SIGNED_OUT', null);                   // user signs out meanwhile
  world.backend.exchangeGate = null;
  gate.resolve();
  await assert.rejects(pending, /signed out|changed/);
  await settle();
  assert.equal(world.storedSession(), null, 'no session was restored');
  assert.equal(world.backend.minted.length, 1);
  assert.equal(world.backend.live.size, 0, 'the session the late exchange created was revoked on the server');
  assert.equal(world.ids(), null, 'nothing was provisioned or persisted for the signed-out user');
  assertNoLeak(world, 'late exchange after sign-out');
});

test('an identity exchange that finishes after a user switch is discarded for the old user and revoked', async () => {
  const world = createWorld();
  await world.signInAs('user-a');
  const gate = deferred();
  world.backend.exchangeGate = gate.promise;
  const pendingA = world.ensure();
  await settle();
  await world.signInAs('user-b');                         // switch while A's exchange is outstanding
  world.backend.exchangeGate = null;
  gate.resolve();
  await assert.rejects(pendingA, /signed out|changed/);
  await settle();
  assert.equal(world.storedSession(), null, "A's late session is not stored for B");
  assert.equal([...world.backend.live.keys()].filter((t) => t.endsWith('user-a')).length, 0, "A's late session was revoked");
  const b = await world.ensure();                          // B then gets their own session
  assert.ok(b.token.endsWith('user-b'));
});

test('a concurrent in-flight attempt from the previous user is not shared with the next user', async () => {
  const world = createWorld();
  await world.signInAs('user-a');
  const gate = deferred();
  world.backend.exchangeGate = gate.promise;
  const pendingA = world.ensure();
  await settle();
  await world.fire('SIGNED_OUT', null);
  await world.signInAs('user-b');
  world.backend.exchangeGate = null;
  const b = await world.ensure();                          // must be a fresh attempt for B, not A's promise
  assert.ok(b.token.endsWith('user-b'));
  gate.resolve();
  await assert.rejects(pendingA);
});

// ── 9-10: repeated and empty sign-out ────────────────────────────────────────────────────────────────────
test('repeated sign-out makes one server call, then none', async () => {
  const { world } = await signedInEnsured();
  await world.run('clearBackendSession()');
  await world.run('clearBackendSession()');
  await world.run('signOutEngine()');
  assert.equal(world.backend.requests.filter((r) => r.path === '/v1/auth/logout').length, 1);
});

test('sign-out with no backend session makes no server call and still completes', async () => {
  const world = createWorld();
  await world.signInAs('user-x');                        // signed in to Supabase, never needed the backend
  world.backend.requests.length = 0;
  await world.run('signOutEngine()');
  assert.equal(world.backend.requests.length, 0);
  assert.equal(world.lastRevocation(), null);
  assert.ok(world.events.includes('supabase.signOut'));
  assert.deepEqual(world.redirects, ['./landing.html']);
});

// ── 11, 14, 15: no leakage, no legacy storage, production API base cannot be redirected ─────────────────
test('the whole flow leaks no token, writes only the id record to localStorage, and ignores a stored API-base override on the real site', async () => {
  const world = createWorld({ storedOverride: 'https://attacker.example' });
  await world.signInAs('user-a');
  const acct = await world.ensure();
  await world.run('signOutEngine()');
  assert.ok(world.backend.requests.length > 0);
  for (const r of world.backend.requests) assert.ok(r.url.startsWith(PROD_API + '/'), `request went to ${r.url}`);
  assert.equal(world.localStorage.getItem('inf_api_base_url'), null, 'the stored override was removed');
  const keys = [...world.localStorage._m.keys()];
  assert.deepEqual(keys.filter((k) => k.startsWith('inf_backend')), ['inf_backend_account_v3']);
  assert.deepEqual(Object.keys(JSON.parse(world.localStorage.getItem('inf_backend_account_v3'))).sort(), ['backendUserId', 'businessId', 'tenantId', 'workspaceId']);
  assert.ok(!keys.some((k) => /inf_backend_account_v[12]$/.test(k)), 'legacy account records are not recreated');
  assert.equal(world.lastRevocation().ok, true);
  assert.ok(acct.token);
  assertNoLeak(world, 'full flow');
});

test('legacy browser records are purged on load and only the three non-secret ids are carried over', () => {
  const legacy = { supaId: 'x', email: 'legacy@example.test', password: 'would-be-secret', token: 'legacy-token', tenantId: 't1', workspaceId: 'w1', businessId: 'b1' };
  const backend = new FakeBackend();
  const localStorage = mkStorage();
  localStorage.setItem('inf_backend_account_v2', JSON.stringify(legacy));
  localStorage.setItem('inf_backend_account_v1', JSON.stringify(legacy));
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, AbortController, URL, location: { hostname: 'infini-cus.com' }, localStorage, sessionStorage: mkStorage(), crypto: {}, document: {}, fetch: backend.fetch.bind(backend), window: {} });
  vm.runInContext('let U = null; const SUPA = { auth: {} };', ctx);
  vm.runInContext(BRIDGE, ctx);
  assert.equal(localStorage.getItem('inf_backend_account_v1'), null);
  assert.equal(localStorage.getItem('inf_backend_account_v2'), null);
  const kept = JSON.parse(localStorage.getItem('inf_backend_account_v3'));
  assert.deepEqual(kept, { backendUserId: null, tenantId: 't1', workspaceId: 'w1', businessId: 'b1' });
  assert.ok(![...localStorage._m.values()].some((v) => /would-be-secret|legacy-token/.test(v)));
});
