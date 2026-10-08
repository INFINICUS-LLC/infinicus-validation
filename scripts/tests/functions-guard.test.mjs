// Tests for functions/_shared/guard.js and functions/_shared/escape.js (PR-B).
// Run: node --test scripts/tests/functions-guard.test.mjs
// The modules target the Cloudflare Pages Workers runtime; Node 22 provides the same Web APIs (Request, Response,
// Headers, crypto.subtle, TextEncoder/Decoder, ReadableStream, URL) so the behaviour under test is the production behaviour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as guard from '../../functions/_shared/guard.js';
import * as esc from '../../functions/_shared/escape.js';

const {
  GuardConfigError, readSecret, normalizeOrigin, parseAllowedOrigins, validateGuardConfig, requireGuardConfig, errorResponse,
  logSecurityEvent, constantTimeEqual, extractBearer, verifyBearer, evaluateOrigin, requireAllowedOrigin, corsHeaders, handlePreflight,
  readJsonBody, validateFields, getClientIp, hashKey, memoryBackend, kvBackend, createRateLimiter,
} = guard;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SECRET = 'Zk3pQ9vLm2XcT7wRb5NyHd8JfA6sUe41';
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

const req = (headers = {}, init = {}) => new Request('https://x.test/api/x', { method: 'POST', headers, ...init });
const bearer = (token) => req({ Authorization: `Bearer ${token}` });
const json = (body, headers = {}) => req({ 'Content-Type': 'application/json', ...headers }, { body: typeof body === 'string' ? body : JSON.stringify(body) });
const chunked = (chunks, headers = {}) => {
  let i = 0;
  const stream = new ReadableStream({ pull(c) { if (i < chunks.length) c.enqueue(chunks[i++]); else c.close(); } });
  return new Request('https://x.test/api/x', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: stream, duplex: 'half' });
};

// ── escape.js ──────────────────────────────────────────────────────────────────────────────────────

test('escapeHtml encodes every HTML-significant character', () => {
  assert.equal(esc.escapeHtml(`<>&"'\``), '&lt;&gt;&amp;&quot;&#39;&#96;');
});

test('escapeHtml neutralises script, attribute and event-handler injection', () => {
  for (const payload of ['<script>alert(1)</script>', '"><img src=x onerror=alert(1)>', "' onmouseover='alert(1)", '<svg/onload=alert(1)>', '</title><script>x</script>', '`${x}`']) {
    const out = esc.escapeHtml(payload);
    assert.ok(!/[<>"'`]/.test(out), `${payload} -> ${out}`);
  }
  const html = `<p title="${esc.escapeAttribute('" onclick="x()')}">${esc.escapeHtml('<b>hi</b>')}</p>`;
  assert.equal(html, '<p title="&quot; onclick=&quot;x()">&lt;b&gt;hi&lt;/b&gt;</p>');
});

test('escapeHtml only stringifies primitives and removes control characters and lone surrogates', () => {
  assert.equal(esc.escapeHtml({ toString() { return '<x>'; } }), '');
  assert.equal(esc.escapeHtml(['<x>']), '');
  assert.equal(esc.escapeHtml(null), '');
  assert.equal(esc.escapeHtml(undefined), '');
  assert.equal(esc.escapeHtml(42), '42');
  assert.equal(esc.escapeHtml(Number.NaN), '');
  assert.equal(esc.escapeHtml(true), 'true');
  assert.equal(esc.escapeHtml('a\u0000b\u001bc\u007fd'), 'abcd');
  assert.equal(esc.escapeHtml(`a${LS}b${PS}c`), 'abc');
  assert.equal(esc.escapeHtml('x\ud800y'), 'x�y');
  assert.equal(esc.escapeHtml('🚀'), '🚀');
});

test('truncate never splits a surrogate pair and escapeHtml honours maxLength before encoding', () => {
  assert.equal(esc.truncate('ab🚀cd', 3), 'ab');
  assert.equal(esc.truncate('ab🚀cd', 4), 'ab🚀');
  assert.equal(esc.escapeHtml('<<<<<<', { maxLength: 2 }), '&lt;&lt;');
});

test('safeUrl allows only https URLs without credentials or control characters', () => {
  assert.equal(esc.safeUrl('https://infini-cus.com/a?b=1'), 'https://infini-cus.com/a?b=1');
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'http://x.test', 'ftp://x.test', '//x.test', 'https://u:p@x.test/', 'https://x.test/a\nb', '', 'not a url', 'JaVaScRiPt:1', 'https://' + 'a'.repeat(3000)]) assert.equal(esc.safeUrl(bad), '', bad);
  assert.equal(esc.safeUrl('http://localhost:3000/', { allowedSchemes: ['http:'] }), 'http://localhost:3000/');
  assert.equal(esc.safeUrl({ href: 'https://x.test' }), '');
});

test('plain-text helpers collapse controls, normalise newlines and cap length', () => {
  assert.equal(esc.plainTextLine('  a\r\nb\t c  '), 'a b c');
  assert.equal(esc.plainTextLine('x'.repeat(500), 10), 'xxxxxxxxxx');
  assert.equal(esc.plainTextBlock('a\r\nb\rc\u0000d\te'), 'a\nb\ncd\te');
  assert.equal(esc.plainTextLine(null), '');
});

test('toFiniteNumber clamps, accepts plain decimals and rejects everything else', () => {
  assert.equal(esc.toFiniteNumber(5, { min: 0, max: 10 }), 5);
  assert.equal(esc.toFiniteNumber(50, { min: 0, max: 10 }), 10);
  assert.equal(esc.toFiniteNumber(-5, { min: 0, max: 10 }), 0);
  assert.equal(esc.toFiniteNumber('7.5'), 7.5);
  assert.equal(esc.toFiniteNumber(7.9, { integer: true }), 7);
  for (const bad of [Number.NaN, Infinity, '1e9', '0x10', '1,000', ' ', '', null, {}, [], '9'.repeat(40)]) assert.equal(esc.toFiniteNumber(bad, { fallback: -1 }), -1, String(bad));
});

test('header-injection helpers reject CR, LF, NUL and other controls without echoing the value', () => {
  for (const bad of ['a\r\nSet-Cookie: x=1', 'a\nb', 'a\rb', 'a\u0000b', 'a\u001fb', 'a\u007fb', `a${LS}b`, 'é', '', 'x'.repeat(2000), 42, null]) {
    assert.throws(() => esc.assertSafeHeaderValue(bad), (e) => e.message === 'unsafe header value' && !String(e.message).includes('Set-Cookie'), String(bad));
  }
  assert.equal(esc.assertSafeHeaderValue('text/plain; charset=utf-8'), 'text/plain; charset=utf-8');
  assert.ok(esc.containsHeaderUnsafe('a\r\nb'));
  assert.ok(!esc.containsHeaderUnsafe('plain value'));
  assert.ok(esc.containsHeaderUnsafe(undefined));
  assert.ok(esc.isValidHeaderName('X-Request-Id'));
  for (const bad of ['', 'a b', 'a:b', 'a\r\nb', 'é', 'x'.repeat(65), null]) assert.ok(!esc.isValidHeaderName(bad), String(bad));
  const headers = esc.buildSafeHeaders({ 'X-A': 'one', 'X-B': 'two' });
  assert.equal(headers.get('x-a'), 'one');
  assert.throws(() => esc.buildSafeHeaders({ 'X-A': 'bad\r\nInjected: 1' }), /unsafe header value/);
  assert.throws(() => esc.buildSafeHeaders({ 'Bad Name': 'v' }), /unsafe header name/);
});

test('normalizeEmailAddress accepts ordinary mailboxes and rejects injection, ambiguity and abuse', () => {
  assert.equal(esc.normalizeEmailAddress('  Jane.Doe+tag@Example.COM '), 'jane.doe+tag@example.com');
  const bad = ['a@b', 'a@@b.co', 'a@b.co\r\nBcc: x@y.co', 'a@b.co\nBcc: x@y.co', 'a b@c.co', '"a b"@c.co', 'a@b..co', '.a@b.co', 'a.@b.co', 'a..b@c.co',
    'a@-b.co', 'a@b-.co', 'a@b.c', 'a@b.123', 'a@[127.0.0.1]', 'ü@b.co', 'a@ü.co', 'a@b.co,c@d.co', 'a@b.co;c@d.co', '<a@b.co>', '', null, 5,
    `${'a'.repeat(65)}@b.co`, `a@${'b'.repeat(64)}.co`, `${'a'.repeat(250)}@b.co`];
  for (const value of bad) assert.equal(esc.normalizeEmailAddress(value), '', String(value).slice(0, 40));
});

test('normalizeEmailAddress is linear-time on hostile input', () => {
  const start = performance.now();
  for (const evil of ['a'.repeat(100000) + '@', '@' + 'a.'.repeat(50000), 'a@' + '-'.repeat(100000), `${'a.'.repeat(30000)}@b.co`]) esc.normalizeEmailAddress(evil);
  assert.ok(performance.now() - start < 250);
});

// ── configuration, fail closed ─────────────────────────────────────────────────────────────────────

test('readSecret returns a strong secret and fails closed otherwise, never exposing a value', () => {
  assert.equal(readSecret({ S: SECRET }, 'S'), SECRET);
  const cases = { missing: undefined, empty: '', short: 'abc123', tooShortBy1: SECRET.slice(0, 31), whitespace: `${SECRET} `, newline: `${SECRET}\n`, tab: `ab\tcd${SECRET}`, placeholder: 'REPLACE_WITH_REAL_SECRET_VALUE_123456789', changeme: 'changeme-changeme-changeme-changeme', lowEntropy: 'a'.repeat(40), number: 12345678901234567890123456789012, object: { v: SECRET } };
  for (const [label, value] of Object.entries(cases)) {
    assert.throws(() => readSecret({ S: value }, 'S'), (e) => e instanceof GuardConfigError && e.code === 'unconfigured' && (!value || typeof value !== 'string' || !JSON.stringify(e).includes(value)) && !e.message.includes('Zk3p'), label);
  }
  assert.throws(() => readSecret(undefined, 'S'), GuardConfigError);
  assert.throws(() => readSecret({ S: SECRET }, 'S', { minLength: 64 }), GuardConfigError);
});

test('validateGuardConfig reports every problem by variable name and fixed code only', () => {
  const env = { A: SECRET, B: 'tinyvalue', C: undefined, ORIGINS: 'https://a.example, *' };
  const result = validateGuardConfig(env, { secrets: [{ name: 'A' }, { name: 'B' }, { name: 'C' }], origins: { name: 'ORIGINS' } });
  assert.equal(result.ok, false);
  assert.deepEqual(result.problems.map((p) => [p.name, p.problem]), [['B', 'too_short'], ['C', 'missing'], ['ORIGINS', 'invalid']]);
  assert.ok(!JSON.stringify(result).includes(SECRET) && !JSON.stringify(result).includes('tinyvalue'));
  assert.deepEqual(validateGuardConfig({ A: SECRET, ORIGINS: 'https://a.example' }, { secrets: [{ name: 'A' }], origins: { name: 'ORIGINS' } }), { ok: true, problems: [] });
  assert.throws(() => requireGuardConfig(env, { secrets: [{ name: 'B' }] }), (e) => e.code === 'unconfigured' && e.problems[0].name === 'B');
  assert.equal(requireGuardConfig({ A: SECRET }, { secrets: [{ name: 'A' }] }), true);
  assert.equal(validateGuardConfig({}, {}).ok, true);
  assert.equal(validateGuardConfig(undefined, { secrets: [{ name: 'A' }] }).ok, false);
});

test('parseAllowedOrigins accepts only exact https origins', () => {
  assert.deepEqual([...parseAllowedOrigins('https://infini-cus.com, https://infinicus-validation.pages.dev')], ['https://infini-cus.com', 'https://infinicus-validation.pages.dev']);
  assert.deepEqual([...parseAllowedOrigins('https://a.example,https://a.example')], ['https://a.example']);
  assert.deepEqual([...parseAllowedOrigins('https://a.example:8443')], ['https://a.example:8443']);
  assert.ok(Object.isFrozen(parseAllowedOrigins('https://a.example')));
  const bad = ['*', 'https://*.example.com', 'https://a.example/', 'https://a.example/path', 'https://A.example', 'https://a.example:443', 'http://a.example', 'http://localhost:3000',
    'https://u:p@a.example', 'https://a.example?x=1', 'https://a.example#x', 'null', 'a.example', 'https://a.example,', ',https://a.example', 'https://a.example,,https://b.example', '', '   ', undefined, null, 5,
    `https://${'a'.repeat(300)}.example`, 'javascript:alert(1)', 'https://a.example\r\nX: y'];
  for (const value of bad) assert.throws(() => parseAllowedOrigins(value), GuardConfigError, String(value));
  assert.throws(() => parseAllowedOrigins(Array.from({ length: 21 }, (_, i) => `https://h${i}.example`).join(',')), GuardConfigError);
  assert.deepEqual([...parseAllowedOrigins('http://localhost:3000, http://127.0.0.1:8788', { allowLocalhost: true })], ['http://localhost:3000', 'http://127.0.0.1:8788']);
  assert.throws(() => parseAllowedOrigins('http://evil.example', { allowLocalhost: true }), GuardConfigError);
  assert.equal(normalizeOrigin('https://a.example'), 'https://a.example');
  assert.equal(normalizeOrigin('https://a.example/'), null);
});

// ── constant-time bearer verification ──────────────────────────────────────────────────────────────

test('constantTimeEqual is correct for equal, different, same-length, different-length and invalid inputs', async () => {
  assert.equal(await constantTimeEqual(SECRET, SECRET), true);
  assert.equal(await constantTimeEqual(SECRET, SECRET.slice(0, -1) + 'x'), false);
  assert.equal(await constantTimeEqual(SECRET, SECRET + 'x'), false);
  assert.equal(await constantTimeEqual('', ''), true);
  assert.equal(await constantTimeEqual(SECRET, ''), false);
  assert.equal(await constantTimeEqual('é', 'e'), false);
  for (const v of [null, undefined, 5, {}, [], Buffer.from('x')]) { assert.equal(await constantTimeEqual(v, SECRET), false); assert.equal(await constantTimeEqual(SECRET, v), false); }
  assert.equal(await constantTimeEqual('x'.repeat(5000), 'x'.repeat(5000)), false);
});

test('extractBearer accepts one well-formed header and nothing else', () => {
  assert.equal(extractBearer(bearer('abc.DEF-123_~+/=')), 'abc.DEF-123_~+/=');
  assert.equal(extractBearer(req({ Authorization: 'bearer tok' })), 'tok');
  for (const header of ['Bearer', 'Bearer ', 'Bearer  tok', 'Bearer tok extra', 'Basic dG9r', 'Token tok', 'Bearer to k', 'Bearer ü', `Bearer ${'a'.repeat(1025)}`, 'Bearer tok===', 'Bearer =']) {
    assert.equal(extractBearer(req({ Authorization: header })), null, header);
  }
  assert.equal(extractBearer(req()), null);
});

test('verifyBearer: missing, short, whitespace or placeholder secrets fail closed with "unconfigured" even for a matching token', async () => {
  for (const secret of [undefined, '', 'short', `${SECRET} `, 'REPLACE_WITH_REAL_SECRET_VALUE_123456789', 'a'.repeat(40), 12345, null]) {
    for (const token of [String(secret ?? ''), 'anything', SECRET, 'x']) {
      assert.deepEqual(await verifyBearer(bearer(token), { S: secret }, 'S'), { ok: false, code: 'unconfigured' }, `secret=${String(secret)} token=${token}`);
    }
  }
  assert.deepEqual(await verifyBearer(req({ Authorization: 'Bearer ' }), {}, 'S'), { ok: false, code: 'unconfigured' });
  assert.deepEqual(await verifyBearer(req(), undefined, 'S'), { ok: false, code: 'unconfigured' });
});

test('verifyBearer: configured secret → 401 for missing/wrong/malformed tokens, ok only for the exact token', async () => {
  const env = { S: SECRET };
  assert.deepEqual(await verifyBearer(bearer(SECRET), env, 'S'), { ok: true });
  for (const r of [req(), bearer('wrong'), bearer(SECRET.slice(0, -1)), bearer(SECRET + 'x'), bearer(SECRET.toLowerCase()), req({ Authorization: SECRET }), req({ Authorization: `Basic ${SECRET}` }), bearer('')]) {
    assert.deepEqual(await verifyBearer(r, env, 'S'), { ok: false, code: 'unauthorized' });
  }
  assert.ok(!JSON.stringify(await verifyBearer(bearer('wrong'), env, 'S')).includes(SECRET));
});

test('an allowed Origin never authenticates: origin success does not satisfy bearer verification', async () => {
  const origins = parseAllowedOrigins('https://a.example');
  const request = req({ Origin: 'https://a.example' });
  assert.deepEqual(requireAllowedOrigin(request, origins), { ok: true, origin: 'https://a.example' });
  assert.deepEqual(await verifyBearer(request, { S: SECRET }, 'S'), { ok: false, code: 'unauthorized' });
});

// ── exact-origin CORS ──────────────────────────────────────────────────────────────────────────────

test('evaluateOrigin allows only exact members; null, lists, case variants and look-alikes are denied', () => {
  const origins = parseAllowedOrigins('https://a.example, https://b.example:8443');
  assert.deepEqual(evaluateOrigin(req(), origins), { status: 'absent', origin: null });
  assert.deepEqual(evaluateOrigin(req({ Origin: 'https://a.example' }), origins), { status: 'allowed', origin: 'https://a.example' });
  assert.deepEqual(evaluateOrigin(req({ Origin: 'https://b.example:8443' }), origins), { status: 'allowed', origin: 'https://b.example:8443' });
  for (const origin of ['null', 'https://A.example', 'https://a.example/', 'https://a.example.evil.test', 'https://evil.test?https://a.example', 'http://a.example', 'https://a.example, https://b.example:8443',
    'https://sub.a.example', 'https://a.example:443', 'https://b.example', '*', '']) {
    assert.equal(evaluateOrigin(req({ Origin: origin }), origins).status, 'denied', origin);
  }
  assert.equal(evaluateOrigin(req({ Origin: 'https://a.example' }), []).status, 'denied');
  assert.equal(evaluateOrigin(req({ Origin: 'https://a.example' }), undefined).status, 'denied');
});

test('requireAllowedOrigin refuses denied and (by default) absent origins', () => {
  const origins = parseAllowedOrigins('https://a.example');
  assert.deepEqual(requireAllowedOrigin(req({ Origin: 'https://evil.test' }), origins), { ok: false, code: 'origin_denied' });
  assert.deepEqual(requireAllowedOrigin(req(), origins), { ok: false, code: 'origin_denied' });
  assert.deepEqual(requireAllowedOrigin(req(), origins, { allowAbsent: true }), { ok: true, origin: null });
  assert.deepEqual(requireAllowedOrigin(req({ Origin: 'https://evil.test' }), origins, { allowAbsent: true }), { ok: false, code: 'origin_denied' });
});

test('corsHeaders emits the exact origin and Vary, never a wildcard or credentials, and refuses unsafe values', () => {
  assert.deepEqual(corsHeaders('https://a.example'), { 'Access-Control-Allow-Origin': 'https://a.example', Vary: 'Origin' });
  assert.deepEqual(corsHeaders('https://a.example\r\nX: y'), {});
  assert.deepEqual(corsHeaders(''), {});
  assert.deepEqual(corsHeaders(undefined), {});
});

test('handlePreflight: allowed origin gets exact-origin 204; everything else is refused without CORS headers', () => {
  const origins = parseAllowedOrigins('https://a.example');
  const opts = { methods: ['POST'], allowHeaders: ['Content-Type'] };
  const preflight = (headers) => new Request('https://x.test/api/x', { method: 'OPTIONS', headers });
  assert.equal(handlePreflight(req({ Origin: 'https://a.example' }), origins, opts), null);

  const ok = handlePreflight(preflight({ Origin: 'https://a.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' }), origins, opts);
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('Access-Control-Allow-Origin'), 'https://a.example');
  assert.equal(ok.headers.get('Vary'), 'Origin');
  assert.equal(ok.headers.get('Access-Control-Allow-Methods'), 'POST, OPTIONS');
  assert.equal(ok.headers.get('Access-Control-Allow-Headers'), 'Content-Type');
  assert.equal(ok.headers.get('Access-Control-Allow-Credentials'), null);
  assert.notEqual(ok.headers.get('Access-Control-Allow-Origin'), '*');

  for (const headers of [
    { Origin: 'https://evil.test', 'Access-Control-Request-Method': 'POST' },
    { Origin: 'null', 'Access-Control-Request-Method': 'POST' },
    { Origin: 'https://a.example', 'Access-Control-Request-Method': 'DELETE' },
    { Origin: 'https://a.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization' },
    { Origin: 'https://a.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type, x-evil' },
  ]) {
    const denied = handlePreflight(preflight(headers), origins, opts);
    assert.equal(denied.status, 403, JSON.stringify(headers));
    assert.equal(denied.headers.get('Access-Control-Allow-Origin'), null);
    assert.equal(denied.headers.get('Access-Control-Allow-Credentials'), null);
  }
  const absent = handlePreflight(preflight({}), origins, opts);
  assert.equal(absent.status, 204);
  assert.equal(absent.headers.get('Access-Control-Allow-Origin'), null);
  assert.throws(() => handlePreflight(preflight({ Origin: 'https://a.example' }), origins, { methods: ['TRACE'] }), GuardConfigError);
  assert.throws(() => handlePreflight(preflight({ Origin: 'https://a.example' }), origins, { methods: [] }), GuardConfigError);
  assert.throws(() => handlePreflight(preflight({ Origin: 'https://a.example' }), origins, { methods: ['POST'], allowHeaders: ['Bad Header'] }), GuardConfigError);
});

// ── bounded body and field validation ──────────────────────────────────────────────────────────────

test('readJsonBody parses an ordinary object and enforces content type', async () => {
  assert.deepEqual(await readJsonBody(json({ a: 1, b: [1, 2], c: { d: 'x' } })), { ok: true, value: { a: 1, b: [1, 2], c: { d: 'x' } } });
  assert.equal((await readJsonBody(json({ a: 1 }, { 'Content-Type': 'application/json; charset=utf-8' }))).ok, true);
  assert.equal((await readJsonBody(json({ a: 1 }, { 'Content-Type': 'APPLICATION/JSON' }))).ok, true);
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'application/jsonp', 'application/json; charset=latin1', 'multipart/form-data', '']) {
    const r = await readJsonBody(req({ 'Content-Type': type }, { body: '{"a":1}' }));
    assert.deepEqual(r, { ok: false, code: 'unsupported_media_type' }, type);
  }
  assert.deepEqual(await readJsonBody(req({}, { body: '{"a":1}' })), { ok: false, code: 'unsupported_media_type' });
});

test('readJsonBody enforces the byte cap by Content-Length, by actual size, and while streaming', async () => {
  assert.equal((await readJsonBody(json({ a: 'x'.repeat(100) }), { maxBytes: 200 })).ok, true);
  assert.deepEqual(await readJsonBody(json({ a: 'x'.repeat(300) }), { maxBytes: 200 }), { ok: false, code: 'payload_too_large' });
  assert.deepEqual(await readJsonBody(json('{}', { 'Content-Length': '999999' }), { maxBytes: 200 }), { ok: false, code: 'payload_too_large' });
  const exact = `{"a":"${'x'.repeat(9)}"}`;
  assert.equal((await readJsonBody(json(exact), { maxBytes: exact.length })).ok, true);
  assert.equal((await readJsonBody(json(exact), { maxBytes: exact.length - 1 })).code, 'payload_too_large');
  // no Content-Length (chunked): the cap applies to the stream and the stream is cancelled
  let pulled = 0;
  const big = new ReadableStream({ pull(c) { pulled++; c.enqueue(new TextEncoder().encode('x'.repeat(100))); } });
  const hostile = new Request('https://x.test/api/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: big, duplex: 'half' });
  assert.deepEqual(await readJsonBody(hostile, { maxBytes: 250 }), { ok: false, code: 'payload_too_large' });
  assert.ok(pulled < 20, `reader must stop early, pulled ${pulled}`);
  // a lying (small) Content-Length does not defeat the streaming cap
  const lying = chunked([new TextEncoder().encode('{"a":"'), new TextEncoder().encode('y'.repeat(500)), new TextEncoder().encode('"}')]);
  assert.deepEqual(await readJsonBody(lying, { maxBytes: 100 }), { ok: false, code: 'payload_too_large' });
  for (const length of ['abc', '-1', '1.5', '', '99999999999999']) {
    const r = await readJsonBody(json('{}', { 'Content-Length': length }), { maxBytes: 200 });
    assert.equal(r.ok, false, length);
  }
});

test('readJsonBody rejects malformed, empty, non-object and non-UTF-8 bodies with a generic code', async () => {
  for (const body of ['', '{', '{"a":}', '[1,2]', 'null', '"s"', '42', 'true', "{'a':1}", '{"a":1}{"b":2}', '﻿{"a":1}', '{"a":1,}', 'undefined']) {
    const r = await readJsonBody(json(body));
    assert.deepEqual(r, { ok: false, code: 'invalid_request' }, JSON.stringify(body));
  }
  assert.deepEqual(await readJsonBody(req({ 'Content-Type': 'application/json' })), { ok: false, code: 'invalid_request' }, 'no body');
  const badUtf8 = new Request('https://x.test/api/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: new Uint8Array([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0x22, 0x7d]) });
  assert.deepEqual(await readJsonBody(badUtf8), { ok: false, code: 'invalid_request' });
});

test('readJsonBody rejects prototype-pollution keys and oversized structures', async () => {
  for (const body of ['{"__proto__":{"x":1}}', '{"a":{"__proto__":1}}', '{"constructor":1}', '{"a":[{"prototype":1}]}']) assert.equal((await readJsonBody(json(body))).ok, false, body);
  let deep = '1';
  for (let i = 0; i < 12; i++) deep = `{"d":${deep}}`;
  assert.equal((await readJsonBody(json(deep))).ok, false);
  assert.equal((await readJsonBody(json(JSON.stringify(Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`k${i}`, i])))))).ok, false);
  assert.equal((await readJsonBody(json(JSON.stringify({ a: Array.from({ length: 300 }, (_, i) => i) })))).ok, false);
  assert.equal((await readJsonBody(json(JSON.stringify({ a: Array.from({ length: 150 }, () => Array.from({ length: 150 }, () => 1)) })), { maxBytes: 1_000_000 })).ok, false);
  const parsed = await readJsonBody(json('{"a":1}'));
  assert.equal(Object.getPrototypeOf(parsed.value), Object.prototype);
  assert.equal(({}).polluted, undefined);
});

const SCHEMA = {
  name: { type: 'string', required: true, max: 20 },
  note: { type: 'string', max: 100, multiline: true },
  email: { type: 'email', required: true },
  age: { type: 'number', integer: true, min: 0, max: 150 },
  plan: { type: 'enum', values: ['free', 'pro'] },
  ok: { type: 'boolean' },
};

test('validateFields returns only declared, validated, normalised fields', () => {
  const r = validateFields({ name: '  Ada  ', email: ' ADA@Example.com ', age: 36, plan: 'pro', ok: true, note: 'line1\nline2' }, SCHEMA);
  assert.deepEqual(r, { ok: true, errors: [], value: { name: 'Ada', email: 'ada@example.com', age: 36, plan: 'pro', ok: true, note: 'line1\nline2' } });
  assert.deepEqual(validateFields({ name: 'Ada', email: 'a@b.co', extra: 1 }, SCHEMA, { allowUnknown: true }).value, { name: 'Ada', email: 'a@b.co' });
  const optional = validateFields({ name: 'Ada', email: 'a@b.co', age: null, plan: undefined }, SCHEMA);
  assert.equal(optional.ok, true);
});

test('validateFields rejects missing, mistyped, over-long, malformed and control-character input with fixed codes', () => {
  const codes = (input) => validateFields(input, SCHEMA).errors.map((e) => `${e.field}:${e.code}`).sort();
  assert.deepEqual(codes({}), ['email:required', 'name:required']);
  assert.deepEqual(codes({ name: '   ', email: 'a@b.co' }), ['name:required']);
  assert.deepEqual(codes({ name: 5, email: 'a@b.co' }), ['name:invalid_type']);
  assert.deepEqual(codes({ name: 'x'.repeat(21), email: 'a@b.co' }), ['name:too_long']);
  assert.deepEqual(codes({ name: 'Ada\u0000', email: 'a@b.co' }), ['name:invalid_chars']);
  assert.deepEqual(codes({ name: 'Ada\nBcc: x', email: 'a@b.co' }), ['name:invalid_chars']);
  assert.deepEqual(codes({ name: `A${LS}da`, email: 'a@b.co' }), ['name:invalid_chars']);
  assert.deepEqual(codes({ name: 'Ada\ud800', email: 'a@b.co' }), ['name:invalid_chars']);
  assert.deepEqual(codes({ name: 'Ada', email: 'a@b.co', note: 'x\u0000y' }), ['note:invalid_chars']);
  assert.deepEqual(codes({ name: 'Ada', email: 'not-an-email' }), ['email:invalid_value']);
  assert.deepEqual(codes({ name: 'Ada', email: 'a@b.co\r\nBcc: z@z.co' }), ['email:invalid_chars']);
  assert.deepEqual(codes({ name: 'Ada', email: 'a@b.co', age: 1.5 }), ['age:invalid_type']);
  assert.deepEqual(codes({ name: 'Ada', email: 'a@b.co', age: -1 }), ['age:invalid_value']);
  assert.deepEqual(codes({ name: 'Ada', email: 'a@b.co', age: '5' }), ['age:invalid_type']);
  assert.deepEqual(codes({ name: 'Ada', email: 'a@b.co', age: Infinity }), ['age:invalid_type']);
  assert.deepEqual(codes({ name: 'Ada', email: 'a@b.co', plan: 'gold' }), ['plan:invalid_value']);
  assert.deepEqual(codes({ name: 'Ada', email: 'a@b.co', plan: ['free'] }), ['plan:invalid_value']);
  assert.deepEqual(codes({ name: 'Ada', email: 'a@b.co', ok: 'true' }), ['ok:invalid_type']);
  assert.deepEqual(codes({ name: 'Ada', email: 'a@b.co', surprise: 1 }), ['(unknown):unknown_field']);
  for (const root of [null, undefined, [], 'x', 5]) assert.deepEqual(validateFields(root, SCHEMA).errors, [{ field: '(root)', code: 'invalid_type' }]);
});

test('validateFields never echoes values or unknown field names and never copies prototype keys', () => {
  const secretish = 'TOPSECRETVALUE';
  const r = validateFields({ name: secretish.repeat(5), email: secretish, [secretish]: secretish }, SCHEMA);
  assert.equal(r.ok, false);
  assert.ok(!JSON.stringify(r).includes(secretish));
  assert.deepEqual(r.value, {});
  const polluted = validateFields(JSON.parse('{"name":"Ada","email":"a@b.co","__proto__":{"admin":true}}'), SCHEMA, { allowUnknown: true });
  assert.equal(polluted.value.admin, undefined);
  assert.equal(Object.getPrototypeOf(polluted.value), Object.prototype);
  assert.ok(!Object.prototype.hasOwnProperty.call(polluted.value, '__proto__'));
});

// ── responses and logging ──────────────────────────────────────────────────────────────────────────

test('errorResponse returns fixed generic bodies with safe headers', async () => {
  const expected = { unauthorized: [401, 'Unauthorized'], forbidden: [403, 'Forbidden'], origin_denied: [403, 'Forbidden'], not_found: [404, 'Not found'], method_not_allowed: [405, 'Method not allowed'],
    payload_too_large: [413, 'Request too large'], unsupported_media_type: [415, 'Unsupported media type'], invalid_request: [400, 'Invalid request'], rate_limited: [429, 'Too many requests'],
    unconfigured: [503, 'Service unavailable'], internal: [500, 'Internal error'] };
  for (const [code, [status, message]] of Object.entries(expected)) {
    const res = errorResponse(code);
    assert.equal(res.status, status);
    assert.deepEqual(await res.json(), { ok: false, error: message });
    assert.equal(res.headers.get('Content-Type'), 'application/json');
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
  }
  for (const code of ['nope', '__proto__', 'constructor', 'toString', undefined, null, 5]) assert.equal(errorResponse(code).status, 500, String(code));
});

test('errorResponse merges only valid headers and a bounded Retry-After', () => {
  const res = errorResponse('rate_limited', { headers: { 'Access-Control-Allow-Origin': 'https://a.example', Vary: 'Origin', 'X-Bad': 'a\r\nInjected: 1', 'Bad Name': 'v', 'X-Num': 5 }, retryAfterSec: 12.2 });
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://a.example');
  assert.equal(res.headers.get('X-Bad'), null);
  assert.equal(res.headers.get('X-Num'), null);
  assert.equal(res.headers.get('Retry-After'), '13');
  assert.equal(errorResponse('rate_limited', { retryAfterSec: -5 }).headers.get('Retry-After'), null);
  assert.equal(errorResponse('rate_limited', { retryAfterSec: Number.NaN }).headers.get('Retry-After'), null);
});

test('logSecurityEvent logs a fixed shape of short tokens and cannot leak request data or break a request', () => {
  const lines = [];
  const sink = (l) => lines.push(l);
  assert.deepEqual(logSecurityEvent({ event: 'auth_failed', route: '/api/nurture-batch', code: 'unauthorized', status: 401 }, sink), { event: 'auth_failed', route: '/api/nurture-batch', code: 'unauthorized', status: 401 });
  assert.equal(lines.length, 1);
  const hostile = logSecurityEvent({ event: 'Bearer abc123', route: 'user@example.com', code: 'x'.repeat(100), status: '401', token: SECRET, email: 'a@b.co', extra: 1 }, sink);
  assert.deepEqual(hostile, { event: 'invalid', route: 'invalid', code: 'invalid', status: 0 });
  for (const line of lines) { assert.ok(!line.includes(SECRET) && !line.includes('@') && !line.includes('Bearer')); assert.deepEqual(Object.keys(JSON.parse(line)), ['event', 'route', 'code', 'status']); }
  assert.doesNotThrow(() => logSecurityEvent({}, () => { throw new Error('sink down'); }));
  assert.doesNotThrow(() => logSecurityEvent(undefined, sink));
});

// ── client key and rate limiting ───────────────────────────────────────────────────────────────────

test('getClientIp trusts only a well-formed CF-Connecting-IP', () => {
  assert.equal(getClientIp(req({ 'CF-Connecting-IP': '203.0.113.7' })), '203.0.113.7');
  assert.equal(getClientIp(req({ 'CF-Connecting-IP': '2001:db8::1' })), '2001:db8::1');
  assert.equal(getClientIp(req({ 'X-Forwarded-For': '203.0.113.7' })), null);
  for (const bad of ['', 'abc xyz', '1.2.3.4, 5.6.7.8', 'x'.repeat(60), '<script>']) assert.equal(getClientIp(req({ 'CF-Connecting-IP': bad })), null, bad);
  assert.equal(getClientIp(req()), null);
});

test('hashKey is a deterministic, namespaced SHA-256 hex digest', async () => {
  const a = await hashKey('ns', '203.0.113.7');
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, await hashKey('ns', '203.0.113.7'));
  assert.notEqual(a, await hashKey('other', '203.0.113.7'));
  assert.notEqual(a, await hashKey('ns', '203.0.113.8'));
  assert.ok(!a.includes('203'));
});

const memoryLimiter = (over = {}) => createRateLimiter({ name: 'test', limit: 3, windowMs: 60000, backend: memoryBackend(), purpose: 'abuse-smoothing', failure: 'closed', ...over });

test('createRateLimiter requires explicit, coherent configuration and throws at creation, not at request time', () => {
  const base = { name: 'test', limit: 3, windowMs: 60000, backend: memoryBackend(), purpose: 'abuse-smoothing', failure: 'closed' };
  assert.doesNotThrow(() => createRateLimiter(base));
  for (const patch of [{ failure: undefined }, { failure: 'maybe' }, { purpose: undefined }, { purpose: 'other' }, { backend: undefined }, { backend: {} }, { name: '' }, { name: 'Has Space' }, { limit: 0 }, { limit: 1.5 }, { windowMs: 10 }, { windowMs: 'x' }]) {
    assert.throws(() => createRateLimiter({ ...base, ...patch }), GuardConfigError, JSON.stringify(patch));
  }
});

test('KV and in-memory counters can never be declared a security boundary; only an atomic fail-closed backend can', () => {
  const kv = kvBackend({ get: async () => null, put: async () => {} });
  assert.equal(kv.atomic, false);
  assert.equal(memoryBackend().atomic, false);
  for (const backend of [kv, memoryBackend()]) assert.throws(() => createRateLimiter({ name: 'strict', limit: 3, windowMs: 60000, backend, purpose: 'security-boundary', failure: 'closed' }), (e) => e.problems[0].problem === 'not_a_security_boundary');
  const atomic = { atomic: true, async hit() { return { count: 1, resetAt: Date.now() + 1000 }; } };
  assert.doesNotThrow(() => createRateLimiter({ name: 'strict', limit: 3, windowMs: 60000, backend: atomic, purpose: 'security-boundary', failure: 'closed' }));
  assert.throws(() => createRateLimiter({ name: 'strict', limit: 3, windowMs: 60000, backend: atomic, purpose: 'security-boundary', failure: 'open' }), GuardConfigError);
});

test('memory limiter allows up to the limit, then denies with Retry-After, per key and per window', async () => {
  const limiter = memoryLimiter();
  const t0 = 1_000_000;
  const seen = [];
  for (let i = 0; i < 5; i++) seen.push(await limiter.check('ip-1', t0 + i));
  assert.deepEqual(seen.map((s) => s.allowed), [true, true, true, false, false]);
  assert.deepEqual(seen.map((s) => s.remaining), [2, 1, 0, 0, 0]);
  assert.ok(seen[3].retryAfterSec >= 1 && seen[3].retryAfterSec <= 60);
  assert.equal(seen[3].reason, 'limit_exceeded');
  assert.equal(seen[3].degraded, false);
  assert.equal((await limiter.check('ip-2', t0)).allowed, true);
  assert.equal((await limiter.check('ip-1', t0 + 61000)).allowed, true, 'a new window resets the count');
});

test('rate-limit keys reach the backend hashed, never raw', async () => {
  const keys = [];
  const spy = { atomic: false, async hit(key) { keys.push(key); return { count: 1, resetAt: Date.now() + 1000 }; } };
  await memoryLimiter({ backend: spy }).check('203.0.113.7');
  await memoryLimiter({ backend: spy }).check('someone@example.com');
  assert.equal(keys.length, 2);
  for (const k of keys) { assert.match(k, /^[0-9a-f]{64}$/); assert.ok(!k.includes('203') && !k.includes('@')); }
});

test('backend failure follows the declared mode: closed denies, open allows, both flagged degraded; check never throws', async () => {
  const broken = { atomic: false, async hit() { throw new Error('KV down with secret=hunter2'); } };
  const closed = await memoryLimiter({ backend: broken, failure: 'closed' }).check('k');
  assert.deepEqual([closed.allowed, closed.degraded, closed.reason], [false, true, 'backend_error']);
  assert.ok(closed.retryAfterSec > 0);
  assert.ok(!JSON.stringify(closed).includes('hunter2'));
  const open = await memoryLimiter({ backend: broken, failure: 'open' }).check('k');
  assert.deepEqual([open.allowed, open.degraded, open.reason], [true, true, 'backend_error']);
  const garbage = { atomic: false, async hit() { return { count: Number.NaN, resetAt: 'x' }; } };
  assert.equal((await memoryLimiter({ backend: garbage }).check('k')).allowed, false);
});

test('unusable keys (no client identity) follow the failure mode instead of bypassing the limit', async () => {
  for (const key of [null, undefined, '', 5, {}, 'x'.repeat(513)]) {
    assert.equal((await memoryLimiter({ failure: 'closed' }).check(key)).allowed, false, String(key));
    const open = await memoryLimiter({ failure: 'open' }).check(key);
    assert.deepEqual([open.allowed, open.degraded, open.reason], [true, true, 'unusable_key']);
  }
});

test('memory backend capacity exhaustion is a backend error, not a silent bypass', async () => {
  const limiter = memoryLimiter({ backend: memoryBackend({ maxEntries: 2 }) });
  assert.equal((await limiter.check('a', 1000)).allowed, true);
  assert.equal((await limiter.check('b', 1000)).allowed, true);
  const full = await limiter.check('c', 1000);
  assert.deepEqual([full.allowed, full.degraded], [false, true]);
  assert.equal((await limiter.check('c', 1000 + 120000)).allowed, true, 'expired entries are purged to make room');
});

function fakeKv({ delay = 0, failGet = false, failPut = false } = {}) {
  const store = new Map();
  const puts = [];
  return {
    store, puts,
    async get(key) { if (failGet) throw new Error('get failed'); const v = store.get(key) ?? null; if (delay) await new Promise((r) => setTimeout(r, delay)); return v; },
    async put(key, value, options) { if (failPut) throw new Error('put failed'); puts.push({ key, value, options }); store.set(key, value); },
  };
}

test('kvBackend counts per window, stores hashed keys with a TTL of at least 60 s, and rejects an unusable binding', async () => {
  const kv = fakeKv();
  const limiter = createRateLimiter({ name: 'kv', limit: 2, windowMs: 60000, backend: kvBackend(kv), purpose: 'abuse-smoothing', failure: 'closed' });
  const t0 = 600_000;
  assert.deepEqual([(await limiter.check('ip', t0)).allowed, (await limiter.check('ip', t0)).allowed, (await limiter.check('ip', t0)).allowed], [true, true, false]);
  assert.equal((await limiter.check('ip', t0 + 60000)).allowed, true, 'next window');
  for (const { key, options } of kv.puts) { assert.match(key, /^[0-9a-f]{64}:\d+$/); assert.ok(options.expirationTtl >= 60); }
  assert.throws(() => kvBackend(null), GuardConfigError);
  assert.throws(() => kvBackend({}), GuardConfigError);
  assert.throws(() => kvBackend({ get() {} }), GuardConfigError);
  const poisoned = fakeKv();
  const probe = createRateLimiter({ name: 'kv', limit: 5, windowMs: 60000, backend: kvBackend(poisoned), purpose: 'abuse-smoothing', failure: 'closed' });
  await probe.check('ip', 0);
  for (const k of poisoned.store.keys()) poisoned.store.set(k, 'not-a-number');
  assert.equal((await probe.check('ip', 0)).allowed, true, 'corrupt counter values count as zero rather than crashing');
});

test('kvBackend failure follows the declared failure mode', async () => {
  for (const options of [{ failGet: true }, { failPut: true }]) {
    const closed = createRateLimiter({ name: 'kv', limit: 2, windowMs: 60000, backend: kvBackend(fakeKv(options)), purpose: 'abuse-smoothing', failure: 'closed' });
    assert.deepEqual([(await closed.check('ip')).allowed, (await closed.check('ip')).degraded], [false, true]);
  }
});

test('KV counters are documented as NON-atomic: concurrent requests undercount (why they are not a security boundary)', async () => {
  const kv = fakeKv({ delay: 5 });
  const limiter = createRateLimiter({ name: 'kv', limit: 3, windowMs: 60000, backend: kvBackend(kv), purpose: 'abuse-smoothing', failure: 'closed' });
  const results = await Promise.all(Array.from({ length: 10 }, () => limiter.check('ip', 2_000_000)));
  const allowed = results.filter((r) => r.allowed).length;
  assert.ok(allowed > 3, `concurrent burst of 10 passed ${allowed} > limit 3: KV read-modify-write is not atomic`);
});

// ── architecture and runtime-compatibility guards ──────────────────────────────────────────────────

const SHARED = join(ROOT, 'functions', '_shared');
const SOURCES = { 'guard.js': readFileSync(join(SHARED, 'guard.js'), 'utf8'), 'escape.js': readFileSync(join(SHARED, 'escape.js'), 'utf8') };
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

test('shared modules import only each other and use no Node built-ins or non-Workers APIs', () => {
  assert.deepEqual([...SOURCES['escape.js'].matchAll(/^\s*import\s[^;]*from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]), []);
  assert.deepEqual([...SOURCES['guard.js'].matchAll(/^\s*import\s[^;]*from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]), ['./escape.js']);
  for (const [file, text] of Object.entries(SOURCES)) {
    const code = stripComments(text);
    assert.ok(!/\bnode:|\brequire\(|\bprocess\.|\bBuffer\b|\b__dirname\b|\bfs\b|\bchild_process\b|\bimport\(/.test(code), `${file} must stay Workers-runtime compatible`);
    assert.ok(!/\beval\(|new Function\(|Math\.random\(/.test(code), `${file} must not use eval or weak randomness`);
    assert.ok(!/\bfetch\(|XMLHttpRequest|WebSocket|\.sendBeacon/.test(code), `${file} must make no network calls`);
  }
});

test('shared modules are not routes and stay clear of Stack B, the legacy stores and any identity or tenant authority', () => {
  for (const [file, text] of Object.entries(SOURCES)) {
    const code = stripComments(text);
    assert.ok(!/export\s+(?:async\s+)?(?:function|const)\s+onRequest/.test(code), `${file} must not export a Pages handler`);
    assert.ok(!/INFINICUS_DB|INFINICUS_USERS|INFINICUS_WAITLIST|infinicus-platform|\.prepare\(|\bD1\b|\bKV_NAMESPACE\b/.test(code), `${file} must not touch D1 or the legacy KV stores`);
    assert.ok(!/tenant|workspace|membership|session|jwt|passwordHash|user_email|userId|approved_business_action|business_operations/i.test(code), `${file} must not model identity, tenancy or Stack B concepts`);
  }
  // the only storage access is through a backend the CALLER passes in
  assert.ok(!/env\.[A-Z_]+/.test(stripComments(SOURCES['guard.js']).replace(/env\?\.\[/g, '')), 'guard.js reads configuration only by caller-supplied names');
});

test('secrets are only ever compared through constantTimeEqual (no ===/== between a token and a secret)', () => {
  const code = stripComments(SOURCES['guard.js']);
  assert.ok(!/\b(?:token|secret|header|provided|expected)\w*\s*[!=]==?\s*(?:token|secret|header|provided|expected)\w*\b/.test(code));
  assert.ok(/constantTimeEqual\(token, secret\)/.test(code));
});

test('console output is limited to the fixed-shape security log and no module logs secrets or request data', () => {
  const uses = [...stripComments(SOURCES['guard.js']).matchAll(/console\.\w+/g)].map((m) => m[0]);
  assert.deepEqual(uses, ['console.warn']);
  assert.ok(!/console\./.test(stripComments(SOURCES['escape.js'])));
});

test('public API surface is the reviewed set (accidental additions must be a conscious decision)', () => {
  assert.deepEqual(Object.keys(guard).sort(), ['GuardConfigError', 'constantTimeEqual', 'corsHeaders', 'createRateLimiter', 'errorResponse', 'evaluateOrigin', 'extractBearer', 'getClientIp', 'handlePreflight', 'hashKey',
    'kvBackend', 'logSecurityEvent', 'memoryBackend', 'normalizeOrigin', 'parseAllowedOrigins', 'readJsonBody', 'readSecret', 'requireAllowedOrigin', 'requireGuardConfig', 'validateFields', 'validateGuardConfig', 'verifyBearer']);
  assert.deepEqual(Object.keys(esc).sort(), ['assertSafeHeaderValue', 'buildSafeHeaders', 'containsHeaderUnsafe', 'escapeAttribute', 'escapeHtml', 'isValidHeaderName', 'normalizeEmailAddress', 'plainTextBlock',
    'plainTextLine', 'safeUrl', 'toFiniteNumber', 'toText', 'truncate', 'wellFormed']);
});

test('Stack B does not import the legacy shared guards, and the legacy upload surface stays unchanged by this module', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (['node_modules', 'dist', '.turbo', 'coverage', '.next'].includes(name)) continue;
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (/\.(?:ts|tsx|js|mjs|cjs)$/.test(name) && /functions\/_shared\/(?:guard|escape)/.test(readFileSync(p, 'utf8'))) offenders.push(relative(ROOT, p));
    }
  };
  walk(join(ROOT, 'infinicus-platform'));
  assert.deepEqual(offenders, []);
});
