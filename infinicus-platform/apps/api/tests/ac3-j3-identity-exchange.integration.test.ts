/**
 * AC-3 Block 4 - Criterion J, gap J-3 (browser-derived shadow-account password). Real PostgreSQL, production buildApp;
 * only the identity provider is replaced (fake verifier through BuildAppOptions.identityVerifier).
 *
 * Authority chain under test:  provider-verified identity -> managed account -> session principal -> active workspace membership
 *                              -> permission -> business scope. Browser identifiers are never authority.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { loadConfig } from '@infinicus/configuration';
import { createPool, closePool, UserRepository, MembershipRepository, type TenantContext } from '@infinicus/database';
import { hashPassword, managedAccountEmailFor } from '@infinicus/authentication';
import { buildApp } from '../src/app.js';
import {
  IdentityTokenInvalidError, IdentityProviderUnavailableError, UnconfiguredIdentityVerifier,
  type IdentityVerifier, type VerifiedIdentity,
} from '../src/identityVerifier.js';
import { uc } from './helpers/abaFixtures.js';

const run = !!process.env.DATABASE_URL;
const STRONG_PASSWORD = 'Correct-Horse-9!';

/** Stands in for the identity provider: only tokens it has issued resolve to an identity. */
class FakeVerifier implements IdentityVerifier {
  readonly tokens = new Map<string, VerifiedIdentity>();
  down = false;
  calls = 0;
  issue(providerUserId: string = randomUUID()): { token: string; providerUserId: string } {
    const token = `fake-provider-token-${randomUUID()}`;
    this.tokens.set(token, { providerUserId });
    return { token, providerUserId };
  }
  async verify(accessToken: string): Promise<VerifiedIdentity> {
    this.calls += 1;
    if (this.down) throw new IdentityProviderUnavailableError();
    const id = this.tokens.get(accessToken);
    if (!id) throw new IdentityTokenInvalidError();
    return id;
  }
}

let admin: Pool;
let app: FastifyInstance;
const verifier = new FakeVerifier();
const cfg = (extra: Record<string, string> = {}) => loadConfig({ DATABASE_URL: process.env.DATABASE_URL!, NODE_ENV: 'test', LOG_LEVEL: 'silent', RATE_LIMIT_MAX: '5000', ...extra });

let ipCounter = 0;
/** Every request gets its own client address so the per-route limiter (20/min per client) does not couple unrelated tests. */
const exchange = (a: FastifyInstance, payload: unknown, remoteAddress = `10.20.${(ipCounter >> 8) & 255}.${(ipCounter++ & 255) || 1}`) =>
  a.inject({ method: 'POST', url: '/v1/auth/identity-exchange', payload: payload as never, remoteAddress });
const ok = async (a: FastifyInstance, token: string) => {
  const res = await exchange(a, { accessToken: token });
  expect(res.statusCode).toBe(200);
  return res.json() as { user: { id: string; email: string; status: string }; sessionId: string; rawSessionToken: string };
};
const countUsers = async (email: string) => Number((await admin.query(`SELECT count(*)::int n FROM identity.users WHERE email = $1`, [email])).rows[0].n);
const countSessions = async (userId: string) => Number((await admin.query(`SELECT count(*)::int n FROM identity.sessions WHERE user_id = $1`, [userId])).rows[0].n);
const shape = (res: { statusCode: number; json(): { error?: { code?: string; message?: string } } }) => ({ status: res.statusCode, code: res.json().error?.code, message: res.json().error?.message });

/** The pre-J-3 browser derivation, reproduced only to prove those credentials are now useless. */
const legacyPassword = (id: string) => `Inf-${createHash('sha256').update(`infinicus-shadow-password-v2:${id}`, 'utf8').digest('hex').slice(0, 40)}-aA1!`;
async function createLegacyAccount(providerUserId: string, status: 'active' | 'pending' | 'suspended' = 'active'): Promise<string> {
  const users = new UserRepository();
  const created = await users.createUser({ email: managedAccountEmailFor(providerUserId), passwordHash: await hashPassword(legacyPassword(providerUserId)) });
  if (status === 'active') await users.activate(created.id);
  if (status === 'suspended') { await users.activate(created.id); await users.suspend(created.id); }
  return created.id;
}

const roleId = async (code: string) => (await admin.query(`SELECT id FROM tenancy.roles WHERE tenant_id IS NULL AND code = $1`, [code])).rows[0].id as string;
async function worldFor(userId: string) {
  const tenantId = randomUUID(); const workspaceId = randomUUID(); const bizId = randomUUID(); const sfx = uc('s');
  await admin.query(`INSERT INTO tenancy.tenants (id, name, slug, status, plan_code) VALUES ($1,'J3 Tenant',$2,'active','test')`, [tenantId, `j3-${sfx}`]);
  await admin.query(`INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,'J3 WS',$3,'active')`, [workspaceId, tenantId, `j3-ws-${sfx}`]);
  const ctx: TenantContext = { tenantId, workspaceId, userId };
  const memberships = new MembershipRepository();
  const m = await memberships.create(ctx, userId);
  await memberships.activate(ctx, m.id);
  await memberships.assignRole(ctx, m.id, await roleId('owner'));
  await admin.query(`INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,'ZZ J3 Biz',$4,'active')`, [bizId, tenantId, workspaceId, uc('j3-biz')]);
  return { tenantId, workspaceId, bizId };
}
const tenantHeaders = (token: string, w: { tenantId: string; workspaceId: string }) => ({ authorization: `Bearer ${token}`, 'x-tenant-id': w.tenantId, 'x-workspace-id': w.workspaceId });

describe.runIf(run)('AC-3 Block 4 - J-3 identity exchange (HTTP, live PostgreSQL)', () => {
  beforeAll(async () => {
    const appUrl = process.env.DATABASE_URL!;
    createPool({ connectionString: appUrl });
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? appUrl });
    app = await buildApp(cfg(), { identityVerifier: verifier });
    await app.ready();
  }, 60_000);
  afterAll(async () => { await app?.close(); await admin?.end(); await closePool(); });

  describe('valid exchange', () => {
    it('issues a working session for the managed account derived from the PROVIDER\'s answer, with an unusable password and an audited login', async () => {
      const { token, providerUserId } = verifier.issue();
      const body = await ok(app, token);
      expect(body.user.email).toBe(managedAccountEmailFor(providerUserId));
      expect(body.user.status).toBe('active');
      const session = await app.inject({ method: 'GET', url: '/v1/auth/session', headers: { authorization: `Bearer ${body.rawSessionToken}` } });
      expect(session.statusCode).toBe(200);
      expect(session.json().user.id).toBe(body.user.id);
      const hash = (await admin.query(`SELECT password_hash FROM identity.users WHERE id = $1`, [body.user.id])).rows[0].password_hash as string;
      expect(hash.startsWith('!unusable:')).toBe(true);   // not a bcrypt hash: no password can ever verify against it
      const audit = await admin.query(`SELECT metadata FROM audit.access_events WHERE user_id = $1 AND event_type = 'login'`, [body.user.id]);
      expect(audit.rows.some((r) => r.metadata?.via === 'managed-identity-exchange')).toBe(true);
    });

    it('is idempotent per identity (same user, new session each time) and isolated across identities', async () => {
      const a = verifier.issue(); const b = verifier.issue();
      const a1 = await ok(app, a.token); const a2 = await ok(app, a.token); const b1 = await ok(app, b.token);
      expect(a2.user.id).toBe(a1.user.id);
      expect(a2.sessionId).not.toBe(a1.sessionId);
      expect(a2.rawSessionToken).not.toBe(a1.rawSessionToken);
      expect(b1.user.id).not.toBe(a1.user.id);
      expect(await countUsers(managedAccountEmailFor(a.providerUserId))).toBe(1);
    });

    it('4 concurrent first exchanges for one identity create exactly one user and all succeed', async () => {
      const { token, providerUserId } = verifier.issue();
      const results = await Promise.all([1, 2, 3, 4].map(() => exchange(app, { accessToken: token })));
      expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200, 200]);
      expect(new Set(results.map((r) => r.json().user.id)).size).toBe(1);
      expect(await countUsers(managedAccountEmailFor(providerUserId))).toBe(1);
    });
  });

  describe('forged / malformed requests create nothing', () => {
    it('a token the provider did not issue is 401 and no account is created', async () => {
      const ghost = randomUUID();
      const res = await exchange(app, { accessToken: `forged-token-for-${ghost}` });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('IdentityTokenInvalidError');
      expect(res.body).not.toContain('rawSessionToken');
      expect(await countUsers(managedAccountEmailFor(ghost))).toBe(0);
    });

    it('extra body fields (email, userId, providerUserId, managed email) are 400 and nothing is created', async () => {
      const real = verifier.issue();
      const victim = randomUUID();
      for (const extra of [{ email: managedAccountEmailFor(victim) }, { userId: victim }, { providerUserId: victim }, { supaId: victim }]) {
        const res = await exchange(app, { accessToken: real.token, ...extra });
        expect(res.statusCode).toBe(400);
      }
      expect(await countUsers(managedAccountEmailFor(victim))).toBe(0);
      expect(await countUsers(managedAccountEmailFor(real.providerUserId))).toBe(0);
    });

    it('a missing, too-short or non-string token is 400', async () => {
      for (const payload of [{}, { accessToken: 'short' }, { accessToken: 12345678901234567890 }, { accessToken: 'x'.repeat(8193) }]) {
        expect((await exchange(app, payload)).statusCode).toBe(400);
      }
    });

    it('the identity chosen is the provider\'s, never the caller\'s: the managed email of an identity A holder cannot be reached with identity B\'s token', async () => {
      const a = verifier.issue(); const b = verifier.issue();
      const ua = await ok(app, a.token); const ub = await ok(app, b.token);
      expect(ua.user.id).not.toBe(ub.user.id);
      expect(ub.user.email).toBe(managedAccountEmailFor(b.providerUserId));
    });
  });

  describe('provider failure modes are closed', () => {
    it('provider down -> 503, no account, no token', async () => {
      const { token, providerUserId } = verifier.issue();
      verifier.down = true;
      try {
        const res = await exchange(app, { accessToken: token });
        expect(res.statusCode).toBe(503);
        expect(res.body).not.toContain('rawSessionToken');
      } finally { verifier.down = false; }
      expect(await countUsers(managedAccountEmailFor(providerUserId))).toBe(0);
    });

    it('exchange not configured (no SUPABASE_URL/SUPABASE_ANON_KEY) -> 503, no account', async () => {
      const closed = await buildApp(cfg(), { identityVerifier: new UnconfiguredIdentityVerifier() });
      await closed.ready();
      try {
        const res = await exchange(closed, { accessToken: `any-token-${randomUUID()}` });
        expect(res.statusCode).toBe(503);
        expect(res.json().error.code).toBe('IdentityExchangeNotConfiguredError');
      } finally { await closed.close(); }
    });
  });

  describe('legacy shadow credentials are dead; existing accounts keep working through the exchange', () => {
    it('the previously derived email+password no longer logs in (401), and existing vs unknown managed identifiers answer identically', async () => {
      const id = randomUUID();
      await createLegacyAccount(id);
      const known = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: managedAccountEmailFor(id), password: legacyPassword(id) } });
      const unknown = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: managedAccountEmailFor(randomUUID()), password: legacyPassword(id) } });
      const wrongPw = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: managedAccountEmailFor(id), password: 'Totally-Wrong-1!' } });
      expect(known.statusCode).toBe(401);
      expect(shape(known)).toEqual(shape(unknown));
      expect(shape(known)).toEqual(shape(wrongPw));
      const mixed = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: managedAccountEmailFor(id).toUpperCase(), password: legacyPassword(id) } });
      expect(mixed.statusCode).toBe(401);
    });

    it('the managed domain cannot be registered (400), including mixed case; no user is created', async () => {
      const id = randomUUID();
      const email = managedAccountEmailFor(id);
      for (const e of [email, email.toUpperCase(), `Shadow-Anything@Infini-Cus.Local`]) {
        const res = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email: e, password: STRONG_PASSWORD } });
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe('ManagedAccountEmailReservedError');
      }
      expect(await countUsers(email)).toBe(0);
    });

    it('the legitimate holder of a legacy account gets the SAME user id through the exchange (tenants keep resolving)', async () => {
      const providerUserId = randomUUID();
      const legacyUserId = await createLegacyAccount(providerUserId);
      const body = await ok(app, verifier.issue(providerUserId).token);
      expect(body.user.id).toBe(legacyUserId);
    });

    it('a legacy account left in "pending" is activated by the exchange', async () => {
      const providerUserId = randomUUID();
      const userId = await createLegacyAccount(providerUserId, 'pending');
      const body = await ok(app, verifier.issue(providerUserId).token);
      expect(body.user.id).toBe(userId);
      expect(body.user.status).toBe('active');
    });

    it('a suspended managed account is refused (403) and NOT reactivated; no session is issued', async () => {
      const providerUserId = randomUUID();
      const userId = await createLegacyAccount(providerUserId, 'suspended');
      const res = await exchange(app, { accessToken: verifier.issue(providerUserId).token });
      expect(res.statusCode).toBe(403);
      expect(res.body).not.toContain('rawSessionToken');
      expect((await admin.query(`SELECT status FROM identity.users WHERE id = $1`, [userId])).rows[0].status).toBe('suspended');
      expect(await countSessions(userId)).toBe(0);
    });
  });

  describe('ordinary accounts are unaffected', () => {
    it('register + login with a normal email still works', async () => {
      const email = `${uc('j3')}@j3.example`;
      expect((await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, password: STRONG_PASSWORD } })).statusCode).toBe(201);
      const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: STRONG_PASSWORD } });
      expect(login.statusCode).toBe(200);
      expect(login.json().rawSessionToken).toBeTruthy();
    });
  });

  describe('authorization downstream of the exchange is unchanged', () => {
    it('an exchanged session works inside its own membership and is refused for another identity\'s tenant / business (cross-tenant substitution)', async () => {
      const a = await ok(app, verifier.issue().token); const b = await ok(app, verifier.issue().token);
      const wa = await worldFor(a.user.id); const wb = await worldFor(b.user.id);
      const own = await app.inject({ method: 'GET', url: `/v1/businesses/${wa.bizId}/products`, headers: tenantHeaders(a.rawSessionToken, wa) });
      expect(own.statusCode).toBe(200);
      // identity B's session naming identity A's tenant/workspace: not a member
      const foreignTenant = await app.inject({ method: 'GET', url: `/v1/businesses/${wa.bizId}/products`, headers: tenantHeaders(b.rawSessionToken, wa) });
      expect([403, 404]).toContain(foreignTenant.statusCode);
      // identity B inside its own tenant naming identity A's business
      const foreignBusiness = await app.inject({ method: 'GET', url: `/v1/businesses/${wa.bizId}/products`, headers: tenantHeaders(b.rawSessionToken, wb) });
      expect([403, 404]).toContain(foreignBusiness.statusCode);
    });

    it('an exchanged session that has expired is 401', async () => {
      const a = await ok(app, verifier.issue().token);
      await admin.query(`UPDATE identity.sessions SET expires_at = now() - interval '1 minute' WHERE id = $1`, [a.sessionId]);
      const res = await app.inject({ method: 'GET', url: '/v1/auth/session', headers: { authorization: `Bearer ${a.rawSessionToken}` } });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('session issuance fails closed', () => {
    it('a failure while creating the session yields a 5xx with no token and no row, and recovers once the fault is gone', async () => {
      const providerUserId = randomUUID();
      const userId = await createLegacyAccount(providerUserId);
      const fn = `j3_fail_${randomUUID().replace(/-/g, '')}`;
      await admin.query(`CREATE FUNCTION public.${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'j3 injected session failure'; END $$`);
      await admin.query(`CREATE TRIGGER ${fn} BEFORE INSERT ON identity.sessions FOR EACH ROW WHEN (NEW.user_id = '${userId}') EXECUTE FUNCTION public.${fn}()`);
      const { token } = verifier.issue(providerUserId);
      try {
        const res = await exchange(app, { accessToken: token });
        expect(res.statusCode).toBeGreaterThanOrEqual(500);
        expect(res.body).not.toContain('rawSessionToken');
        expect(await countSessions(userId)).toBe(0);
      } finally {
        await admin.query(`DROP TRIGGER IF EXISTS ${fn} ON identity.sessions`);
        await admin.query(`DROP FUNCTION IF EXISTS public.${fn}()`);
      }
      const recovered = await ok(app, token);
      expect(recovered.user.id).toBe(userId);
      expect(await countSessions(userId)).toBe(1);
    });
  });

  describe('route rate limit', () => {
    it('the 21st request from one client within a minute is 429', async () => {
      const limited = await buildApp(cfg(), { identityVerifier: verifier });
      await limited.ready();
      try {
        const codes: number[] = [];
        for (let i = 0; i < 21; i++) codes.push((await exchange(limited, { accessToken: `forged-token-${randomUUID()}` }, '10.99.0.1')).statusCode);
        expect(codes.slice(0, 20).every((c) => c === 401)).toBe(true);
        expect(codes[20]).toBe(429);
      } finally { await limited.close(); }
    });
  });
});
