/**
 * AC-3 Release Block R1 (R1-02) - server side of browser sign-out. Real PostgreSQL, production buildApp, fake identity provider only.
 *
 * The page now calls POST /v1/auth/logout when the user signs out or a different user becomes active. This proves the contract it relies on,
 * for sessions issued by the identity exchange: the session really dies on the server, only that session dies, a repeat is harmless, and the
 * cross-origin call is allowed by CORS. Nothing about authentication behaviour is changed by R1; the existing J-3 tests run untouched.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '@infinicus/configuration';
import { createPool, closePool } from '@infinicus/database';
import { managedAccountEmailFor } from '@infinicus/authentication';
import { buildApp } from '../src/app.js';
import { IdentityTokenInvalidError, type IdentityVerifier, type VerifiedIdentity } from '../src/identityVerifier.js';

const run = !!process.env.DATABASE_URL;
const ORIGIN = 'https://infini-cus.com';

class FakeVerifier implements IdentityVerifier {
  readonly tokens = new Map<string, VerifiedIdentity>();
  issue(providerUserId: string = randomUUID()) {
    const token = `fake-provider-token-${randomUUID()}`;
    this.tokens.set(token, { providerUserId });
    return { token, providerUserId };
  }
  async verify(accessToken: string): Promise<VerifiedIdentity> {
    const id = this.tokens.get(accessToken);
    if (!id) throw new IdentityTokenInvalidError();
    return id;
  }
}

let admin: Pool;
let app: FastifyInstance;
const verifier = new FakeVerifier();

let ipCounter = 0;
const nextIp = () => `10.30.${(ipCounter >> 8) & 255}.${(ipCounter++ & 255) || 1}`;
const exchange = async (token: string) => {
  const res = await app.inject({ method: 'POST', url: '/v1/auth/identity-exchange', payload: { accessToken: token }, remoteAddress: nextIp() });
  expect(res.statusCode).toBe(200);
  return res.json() as { user: { id: string; email: string }; sessionId: string; rawSessionToken: string };
};
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const sessionStatus = async (t: string) => (await app.inject({ method: 'GET', url: '/v1/auth/session', headers: bearer(t) })).statusCode;
const logout = (t?: string) => app.inject({ method: 'POST', url: '/v1/auth/logout', headers: t ? bearer(t) : {} });

describe.runIf(run)('AC-3 R1 - managed-session logout (HTTP, live PostgreSQL)', () => {
  beforeAll(async () => {
    const appUrl = process.env.DATABASE_URL!;
    createPool({ connectionString: appUrl });
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? appUrl });
    app = await buildApp(loadConfig({ DATABASE_URL: appUrl, NODE_ENV: 'test', LOG_LEVEL: 'silent', RATE_LIMIT_MAX: '5000', CORS_ALLOWED_ORIGINS: ORIGIN }), { identityVerifier: verifier });
    await app.ready();
  }, 60_000);
  afterAll(async () => { await app?.close(); await admin?.end(); await closePool(); });

  it('logout kills the exchanged session on the server: 204, the token no longer validates, the row is revoked, the audit trail records it', async () => {
    const { token } = verifier.issue();
    const s = await exchange(token);
    expect(await sessionStatus(s.rawSessionToken)).toBe(200);

    const res = await logout(s.rawSessionToken);
    expect(res.statusCode).toBe(204);
    expect(await sessionStatus(s.rawSessionToken)).toBe(401);

    const row = (await admin.query(`SELECT revoked_at FROM identity.sessions WHERE id = $1`, [s.sessionId])).rows[0];
    expect(row.revoked_at).not.toBeNull();
    const audit = await admin.query(`SELECT metadata FROM audit.access_events WHERE user_id = $1 AND event_type = 'logout'`, [s.user.id]);
    expect(audit.rows.some((r) => r.metadata?.sessionId === s.sessionId)).toBe(true);
  });

  it('a repeated logout, a missing token and an unknown token are all refused with 401 and change nothing', async () => {
    const { token } = verifier.issue();
    const s = await exchange(token);
    expect((await logout(s.rawSessionToken)).statusCode).toBe(204);
    expect((await logout(s.rawSessionToken)).statusCode).toBe(401);        // the page treats this as "server no longer accepts it"
    expect((await logout()).statusCode).toBe(401);
    expect((await logout('0'.repeat(64))).statusCode).toBe(401);
  });

  it('only the presented session is revoked: another session of the same identity, and every session of another identity, stay valid', async () => {
    const a = verifier.issue(); const b = verifier.issue();
    const a1 = await exchange(a.token); const a2 = await exchange(a.token); const b1 = await exchange(b.token);
    expect(a1.user.id).toBe(a2.user.id);
    expect((await logout(a1.rawSessionToken)).statusCode).toBe(204);
    expect(await sessionStatus(a1.rawSessionToken)).toBe(401);
    expect(await sessionStatus(a2.rawSessionToken)).toBe(200);
    expect(await sessionStatus(b1.rawSessionToken)).toBe(200);
    // the identity can sign in again afterwards and gets the SAME managed user
    const a3 = await exchange(a.token);
    expect(a3.user.id).toBe(a1.user.id);
    expect(await sessionStatus(a3.rawSessionToken)).toBe(200);
  });

  it("revoking one identity's session cannot be done with another identity's token", async () => {
    const a = verifier.issue(); const b = verifier.issue();
    const sa = await exchange(a.token); const sb = await exchange(b.token);
    // there is no body or path parameter that names a session: logout acts only on the bearer's own session
    const res = await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: bearer(sb.rawSessionToken), payload: { sessionId: sa.sessionId } });
    expect([204, 400]).toContain(res.statusCode);
    expect(await sessionStatus(sa.rawSessionToken)).toBe(200);
  });

  it('the browser call is permitted cross-origin: preflight for POST with an Authorization header from the site origin succeeds, other origins do not', async () => {
    const ok = await app.inject({ method: 'OPTIONS', url: '/v1/auth/logout', headers: { origin: ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization' } });
    expect(ok.statusCode).toBeLessThan(300);
    expect(ok.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(String(ok.headers['access-control-allow-headers']).toLowerCase()).toContain('authorization');
    expect(String(ok.headers['access-control-allow-methods']).toUpperCase()).toContain('POST');
    const bad = await app.inject({ method: 'OPTIONS', url: '/v1/auth/logout', headers: { origin: 'https://attacker.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization' } });
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('unchanged by R1: managed accounts still cannot log in with a password, and the exchange still maps the provider id to the same managed user', async () => {
    const { token, providerUserId } = verifier.issue();
    const s = await exchange(token);
    expect(s.user.email).toBe(managedAccountEmailFor(providerUserId));
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: managedAccountEmailFor(providerUserId), password: 'Correct-Horse-9!' } });
    expect(login.statusCode).toBe(401);
  });
});
