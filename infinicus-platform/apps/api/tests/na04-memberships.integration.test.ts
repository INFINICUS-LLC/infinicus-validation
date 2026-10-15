/**
 * NA-04 - GET /v1/auth/memberships. Real PostgreSQL, production buildApp, fake identity provider only.
 *
 * The endpoint exists so a signed-in web client can discover which workspaces it may select. It must list only the caller's own ACTIVE workspaces,
 * take the caller from the validated session and nothing else, and expose nothing beyond ids, names and statuses.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '@infinicus/configuration';
import { createPool, closePool } from '@infinicus/database';
import { buildApp } from '../src/app.js';
import { IdentityTokenInvalidError, type IdentityVerifier, type VerifiedIdentity } from '../src/identityVerifier.js';

const run = !!process.env.DATABASE_URL;

class FakeVerifier implements IdentityVerifier {
  readonly tokens = new Map<string, VerifiedIdentity>();
  issue(providerUserId: string = randomUUID()) {
    const token = `fake-provider-token-${randomUUID()}`;
    this.tokens.set(token, { providerUserId });
    return token;
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
const nextIp = () => `10.40.${(ipCounter >> 8) & 255}.${(ipCounter++ & 255) || 1}`;
const exchange = async () => {
  const res = await app.inject({ method: 'POST', url: '/v1/auth/identity-exchange', payload: { accessToken: verifier.issue() }, remoteAddress: nextIp() });
  expect(res.statusCode).toBe(200);
  return res.json() as { user: { id: string; email: string }; rawSessionToken: string };
};
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const list = (token?: string, extra: Record<string, string> = {}, url = '/v1/auth/memberships') =>
  app.inject({ method: 'GET', url, headers: { ...(token ? bearer(token) : {}), ...extra } });

async function seedWorkspace(name: string, userId: string, status = 'active') {
  const tenant = randomUUID(), ws = randomUUID();
  await admin.query(`INSERT INTO tenancy.tenants (id, name, slug, status, plan_code) VALUES ($1,$2,$3,'active','test')`, [tenant, name, `na04-${tenant.slice(0, 8)}`]);
  await admin.query(`INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,$3,'main','active')`, [ws, tenant, `${name} workspace`]);
  await admin.query(`INSERT INTO tenancy.memberships (tenant_id, workspace_id, user_id, status) VALUES ($1,$2,$3,$4)`, [tenant, ws, userId, status]);
  return { tenant, ws };
}

describe.runIf(run)('NA-04 - GET /v1/auth/memberships (HTTP, live PostgreSQL)', () => {
  beforeAll(async () => {
    const appUrl = process.env.DATABASE_URL!;
    createPool({ connectionString: appUrl });
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? appUrl });
    app = await buildApp(loadConfig({ DATABASE_URL: appUrl, NODE_ENV: 'test', LOG_LEVEL: 'silent', RATE_LIMIT_MAX: '5000' }), { identityVerifier: verifier });
    await app.ready();
  }, 60_000);
  afterAll(async () => { await app?.close(); await admin?.end(); await closePool(); });

  it('refuses a missing, malformed or unknown bearer token with 401', async () => {
    expect((await list()).statusCode).toBe(401);
    expect((await list('0'.repeat(64))).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/auth/memberships', headers: { authorization: 'Basic abc' } })).statusCode).toBe(401);
  });

  it('a newly exchanged managed user has no workspaces: 200 with an empty list', async () => {
    const s = await exchange();
    const res = await list(s.rawSessionToken);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ memberships: [] });
  });

  it("lists exactly the caller's ACTIVE workspaces, with ids, names and statuses only", async () => {
    const s = await exchange(); const other = await exchange();
    const a = await seedWorkspace('Acme Co', s.user.id); const b = await seedWorkspace('Bolt Co', s.user.id);
    await seedWorkspace('Hidden Co', other.user.id);                        // another user's workspace
    await seedWorkspace('Pending Co', s.user.id, 'invited');                // not active
    await seedWorkspace('Frozen Co', s.user.id, 'suspended');

    const body = (await list(s.rawSessionToken)).json() as { memberships: Array<Record<string, string>> };
    expect(body.memberships.map((m) => m.tenantName)).toEqual(['Acme Co', 'Bolt Co']);
    expect(body.memberships[0]).toEqual({ tenantId: a.tenant, tenantName: 'Acme Co', tenantStatus: 'active', workspaceId: a.ws, workspaceName: 'Acme Co workspace', workspaceStatus: 'active' });
    expect(body.memberships[1].workspaceId).toBe(b.ws);
    const text = JSON.stringify(body);
    for (const leak of [other.user.id, other.user.email, s.user.id, s.user.email, 'Hidden Co', 'role', 'permission']) expect(text).not.toContain(leak);
  });

  it('the user comes only from the session: query parameters and identity headers naming someone else change nothing', async () => {
    const s = await exchange(); const victim = await exchange();
    await seedWorkspace('Victim Co', victim.user.id);
    const mine = (await list(s.rawSessionToken)).json();
    const spoofed = await list(s.rawSessionToken, { 'x-user-id': victim.user.id, 'x-tenant-id': randomUUID(), 'x-workspace-id': randomUUID() }, `/v1/auth/memberships?userId=${victim.user.id}`);
    expect(spoofed.statusCode).toBe(200);
    expect(spoofed.json()).toEqual(mine);
    expect(JSON.stringify(spoofed.json())).not.toContain('Victim Co');
  });

  it('a revoked session can no longer list anything', async () => {
    const s = await exchange();
    expect((await list(s.rawSessionToken)).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: bearer(s.rawSessionToken) })).statusCode).toBe(204);
    expect((await list(s.rawSessionToken)).statusCode).toBe(401);
  });

  it('selecting a listed workspace authorizes nothing: a tenant route still needs permission, and an unlisted workspace is refused', async () => {
    const s = await exchange(); const w = await seedWorkspace('NoRole Co', s.user.id);
    const listed = await app.inject({ method: 'GET', url: '/v1/businesses', headers: { ...bearer(s.rawSessionToken), 'x-tenant-id': w.tenant, 'x-workspace-id': w.ws } });
    expect(listed.statusCode).toBe(403);                                    // active member, but holds no role granting bo:read
    const stranger = await app.inject({ method: 'GET', url: '/v1/businesses', headers: { ...bearer(s.rawSessionToken), 'x-tenant-id': randomUUID(), 'x-workspace-id': randomUUID() } });
    expect([403, 404]).toContain(stranger.statusCode);
  });
});
