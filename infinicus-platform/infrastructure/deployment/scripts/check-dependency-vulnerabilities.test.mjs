// CI-HEALTH-1 - deterministic tests of the dependency-advisory allowlist guard (no network, no clock: every date is passed in).
// Run: node --test infrastructure/deployment/scripts/check-dependency-vulnerabilities.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ALLOWLIST, evaluateAllowlist, classifyAdvisories, todayUtc } from './check-dependency-vulnerabilities.mjs';

const SCRIPT = fileURLToPath(new URL('./check-dependency-vulnerabilities.mjs', import.meta.url));
const REVIEW_BY = '2026-11-06';
const adv = (id, name = 'pkg') => ({ github_advisory_id: id, module_name: name, severity: 'high', title: 't' });
const entry = (over = {}) => ({ githubAdvisoryId: 'GHSA-aaaa-bbbb-cccc', package: 'p', reason: 'TEMPORARY (issue #24, review by 2026-11-06). x', expires: REVIEW_BY, ...over });
// The guard is tested against fixtures, not the committed list: the committed list may legitimately hold no TEMPORARY entry at all (CI-SEC-1 removed them
// once the scan proved them unnecessary), and the guard must keep being proven for the next time one is added.
const FIXTURE = [entry(), entry({ githubAdvisoryId: 'GHSA-dddd-eeee-ffff' }), { githubAdvisoryId: 'GHSA-gggg-hhhh-iiii', package: 'perm', reason: 'permanent, reasoned' }];
const temporary = FIXTURE.filter((e) => e.reason.startsWith('TEMPORARY'));

test('the committed allowlist is valid today: nothing invalid, nothing expired (existing entries stay accepted)', () => {
  const state = evaluateAllowlist(ALLOWLIST, todayUtc());
  assert.deepEqual(state.invalid, []);
  assert.deepEqual(state.expired, []);
  assert.equal(state.active.length, ALLOWLIST.length);
  for (const e of ALLOWLIST.filter((x) => x.reason.startsWith('TEMPORARY'))) assert.ok(e.expires && e.expires <= REVIEW_BY, `${e.githubAdvisoryId} must expire no later than ${REVIEW_BY}`);
});

test('the fixture has TEMPORARY entries and every one carries the review-by date (the guard has something to guard)', () => {
  assert.ok(temporary.length >= 2);
  for (const e of temporary) assert.equal(e.expires, REVIEW_BY, e.githubAdvisoryId);
});

test('the review-by day itself is still valid; the next day every temporary entry is expired', () => {
  assert.equal(evaluateAllowlist(FIXTURE, REVIEW_BY).expired.length, 0);
  const after = evaluateAllowlist(FIXTURE, '2026-11-07');
  assert.equal(after.expired.length, temporary.length);
  assert.deepEqual(new Set(after.expired.map((e) => e.githubAdvisoryId)), new Set(temporary.map((e) => e.githubAdvisoryId)));
  assert.equal(after.active.length, FIXTURE.length - temporary.length); // permanent entries never expire
});

test('an expired entry no longer allowlists its advisory; an unexpired one still does', () => {
  const id = temporary[0].githubAdvisoryId;
  const before = evaluateAllowlist(FIXTURE, '2026-10-21');
  assert.equal(classifyAdvisories([adv(id)], before.active).unallowlisted.length, 0);
  const after = evaluateAllowlist(FIXTURE, '2026-11-07');
  const r = classifyAdvisories([adv(id)], after.active);
  assert.equal(r.allowlisted.length, 0);
  assert.equal(r.unallowlisted.length, 1);
});

test('an advisory with no entry at all is never allowlisted', () => {
  const r = classifyAdvisories([adv('GHSA-zzzz-zzzz-zzzz')], evaluateAllowlist(ALLOWLIST, '2026-10-21').active);
  assert.equal(r.unallowlisted.length, 1);
});

test('a TEMPORARY entry without an expiry is invalid (it could never expire)', () => {
  const { expires, ...noExpiry } = entry();
  void expires;
  const state = evaluateAllowlist([noExpiry], '2026-10-21');
  assert.equal(state.invalid.length, 1);
  assert.match(state.invalid[0].problem, /no 'expires'/);
});

test('a malformed or impossible expiry is invalid and the entry is not active', () => {
  for (const bad of ['2026-13-01', '2026-02-30', '06/11/2026', '2026-11-6', '', 20261106, null]) {
    const state = evaluateAllowlist([entry({ expires: bad })], '2026-10-21');
    assert.equal(state.invalid.length, 1, String(bad));
    assert.equal(state.active.length, 0, String(bad));
  }
});

test('the reason must state the same review-by date as the expiry (no drift between text and rule)', () => {
  const state = evaluateAllowlist([entry({ expires: '2026-12-31' })], '2026-10-21');
  assert.equal(state.invalid.length, 1);
  assert.match(state.invalid[0].problem, /same review-by date/);
});

test('a permanent entry (no expiry, not TEMPORARY) is accepted and never expires', () => {
  const permanent = entry({ reason: 'Unreachable code path, verified.' });
  delete permanent.expires;
  const state = evaluateAllowlist([permanent], '2099-01-01');
  assert.deepEqual([state.invalid.length, state.expired.length, state.active.length], [0, 0, 1]);
});

test('duplicate advisory ids are invalid', () => {
  assert.equal(evaluateAllowlist([entry(), entry()], '2026-10-21').invalid.length, 1);
});

test('the date argument must be a real date (no silent fallback to "never expired")', () => {
  assert.throws(() => evaluateAllowlist(ALLOWLIST, 'tomorrow'));
  assert.throws(() => evaluateAllowlist(ALLOWLIST, undefined));
});

test('the real clock cannot be overridden from the environment or the command line', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--allowlist-only', '--today=2000-01-01'], { encoding: 'utf8', env: { ...process.env, ALLOWLIST_TODAY: '2000-01-01', TODAY: '2000-01-01' } });
  const today = todayUtc();
  if (today <= REVIEW_BY) {
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`UTC ${today}`));
  } else {
    assert.equal(r.status, 1, 'after the review date the offline guard must fail');
    assert.match(r.stderr, /ALLOWLIST EXPIRED/);
  }
});
