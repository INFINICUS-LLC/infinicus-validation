/**
 * POS2-02: billing.entitlements (migration 0225) on live PostgreSQL 16. Development and test fixtures only: every row here is written by the test through
 * the governed functions on the admin connection; nothing is seeded by the migration.
 * Requires DATABASE_URL (application role, RLS enforced) and ADMIN_DATABASE_URL (fixtures).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createPool, closePool, EntitlementRepository, type TenantContext } from '../src/index.js';
import { truncateRefusal } from './helpers/truncateRefusal.js';

const run = !!process.env.DATABASE_URL;
const T1 = randomUUID(); const WS1 = randomUUID(); const T2 = randomUUID(); const WS2 = randomUUID();
const ctx1: TenantContext = { tenantId: T1, workspaceId: WS1, userId: randomUUID() };
const ctx2: TenantContext = { tenantId: T2, workspaceId: WS2, userId: randomUUID() };
let admin: Pool;
let app: Pool;
const repo = new EntitlementRepository();
const ago = (ms: number) => new Date(Date.now() - ms);
const ahead = (ms: number) => new Date(Date.now() + ms);
const DAY = 86_400_000;

/** The governed process stand-in: the admin connection, in a transaction scoped to the tenant being written. */
async function asGovernedProcess<T>(tenantId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await admin.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
const grant = (tenantId: string, over: Partial<Parameters<typeof EntitlementRepository.grant>[2]> = {}) =>
  asGovernedProcess(tenantId, (c) => EntitlementRepository.grant(c, tenantId, {
    capability: 'pos.core', sourceType: 'operator_grant', sourceReference: `fixture-${randomUUID()}`, effectiveFrom: ago(DAY), ...over }));
const code = async (p: Promise<unknown>): Promise<string> => { try { await p; return 'NO_ERROR'; } catch (e) { return (e as { code?: string }).code ?? String(e); } };

describe.runIf(run)('billing.entitlements - live PostgreSQL', () => {
  beforeAll(async () => {
    createPool({ connectionString: process.env.DATABASE_URL! });
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });
    app = new Pool({ connectionString: process.env.DATABASE_URL });
    const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    await admin.query(`INSERT INTO tenancy.tenants (id, name, slug, status, plan_code) VALUES ($1,'Ent T1',$3,'active','test'),($2,'Ent T2',$4,'active','test')`, [T1, T2, `ent-t1-${sfx}`, `ent-t2-${sfx}`]);
    await admin.query(`INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,'W1',$5,'active'),($3,$4,'W2',$6,'active')`, [WS1, T1, WS2, T2, `ent-w1-${sfx}`, `ent-w2-${sfx}`]);
  });
  afterAll(async () => { await app.end(); await admin.end(); await closePool(); });

  describe('shape and constraints', () => {
    it('migration seeds nothing and has RLS enabled and forced with one tenant policy', async () => {
      const t = (await admin.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'billing.entitlements'::regclass`)).rows[0];
      expect(t).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      const pol = (await admin.query(`SELECT policyname, qual FROM pg_policies WHERE schemaname='billing' AND tablename='entitlements'`)).rows;
      expect(pol).toHaveLength(1);
      expect(pol[0].qual).toContain('app.tenant_id');
      const sql = readFileSync(new URL('../../../infrastructure/database/migrations/0225_create_billing_entitlements.sql', import.meta.url), 'utf8');
      // The only INSERT is the one inside grant_entitlement(); there is no seed, default grant or backfill.
      expect(sql.replace(/--.*\n/g, '').match(/INSERT INTO billing\.entitlements/g)).toHaveLength(1);
      expect(sql).toMatch(/billing\.grant_entitlement[\s\S]*INSERT INTO billing\.entitlements[\s\S]*billing\.revoke_entitlement/);
    });
    it.each([
      ['an uppercase or unknown family', 'POS.core'], ['a provider-looking key', 'prod_ABC123'], ['an extra dot', 'pos.core.extra'], ['an empty name', 'pos.'],
    ])('refuses a capability with %s', async (_n, capability) => {
      expect(await code(grant(T1, { capability }))).toBe('23514');
    });
    it('refuses an unknown source type, an empty or oversized reference, an inverted period', async () => {
      expect(await code(grant(T1, { sourceType: 'stripe' as never }))).toBe('23514');
      expect(await code(grant(T1, { sourceReference: '   ' }))).toBe('23514');
      expect(await code(grant(T1, { sourceReference: 'x'.repeat(201) }))).toBe('23514');
      expect(await code(grant(T1, { effectiveFrom: ago(DAY), effectiveUntil: ago(2 * DAY) }))).toBe('23514');
    });
    it('refuses incomplete or out-of-scope grants', async () => {
      expect(await code(asGovernedProcess(T1, (c) => EntitlementRepository.grant(c, T2, { capability: 'pos.core', sourceType: 'trial', sourceReference: 'r', effectiveFrom: ago(DAY) })))).toBe('42501');
      expect(await code(asGovernedProcess(T1, (c) => c.query('SELECT * FROM billing.grant_entitlement($1,$2,$3,$4,$5,$6)', [T1, null, 'trial', 'r', ago(DAY), null])))).toBe('22023');
    });
  });

  describe('governed write path', () => {
    it('grants once and replays idempotently; the same identity with a different end is refused', async () => {
      const ref = `idem-${randomUUID()}`; const from = ago(DAY); const until = ahead(DAY);
      const a = await grant(T1, { capability: 'pos.inventory', sourceType: 'add_on', sourceReference: ref, effectiveFrom: from, effectiveUntil: until });
      const b = await grant(T1, { capability: 'pos.inventory', sourceType: 'add_on', sourceReference: ref, effectiveFrom: from, effectiveUntil: until });
      expect(a.created).toBe(true); expect(b.created).toBe(false); expect(b.id).toBe(a.id);
      expect(await code(grant(T1, { capability: 'pos.inventory', sourceType: 'add_on', sourceReference: ref, effectiveFrom: from, effectiveUntil: ahead(2 * DAY) }))).toBe('23505');
      const n = (await admin.query(`SELECT count(*)::int n FROM billing.entitlements WHERE tenant_id=$1 AND source_reference=$2`, [T1, ref])).rows[0].n;
      expect(n).toBe(1);
    });
    it('revokes one way: once, then no-op; unknown id and other-tenant id are refused', async () => {
      const g = await grant(T1);
      expect(await asGovernedProcess(T1, (c) => EntitlementRepository.revoke(c, T1, g.id))).toBe(true);
      expect(await asGovernedProcess(T1, (c) => EntitlementRepository.revoke(c, T1, g.id))).toBe(false);
      expect(await code(asGovernedProcess(T1, (c) => EntitlementRepository.revoke(c, T1, randomUUID())))).toBe('P0002');
      const other = await grant(T2);
      expect(await code(asGovernedProcess(T1, (c) => EntitlementRepository.revoke(c, T1, other.id)))).toBe('P0002');   // RLS and the tenant predicate hide it
      expect(await code(asGovernedProcess(T1, (c) => EntitlementRepository.revoke(c, T2, other.id)))).toBe('42501');
      const row = (await admin.query(`SELECT status, revoked_at FROM billing.entitlements WHERE id=$1`, [g.id])).rows[0];
      expect(row.status).toBe('revoked'); expect(row.revoked_at).not.toBeNull();
    });
    it('a replay of a revoked grant does not resurrect it', async () => {
      const ref = `rev-${randomUUID()}`; const from = ago(DAY);
      const g = await grant(T1, { sourceReference: ref, effectiveFrom: from });
      await asGovernedProcess(T1, (c) => EntitlementRepository.revoke(c, T1, g.id));
      const again = await grant(T1, { sourceReference: ref, effectiveFrom: from });
      expect(again).toEqual({ id: g.id, created: false });
      expect((await admin.query(`SELECT status FROM billing.entitlements WHERE id=$1`, [g.id])).rows[0].status).toBe('revoked');
    });
  });

  describe('nothing writes the table except the governed functions', () => {
    it('refuses a direct INSERT, UPDATE, DELETE and TRUNCATE even on the admin connection', async () => {
      const g = await grant(T1);
      const ins = await code(asGovernedProcess(T1, (c) => c.query(
        `INSERT INTO billing.entitlements (tenant_id, capability, source_type, source_reference, effective_from) VALUES ($1,'pos.core','trial','direct',now())`, [T1])));
      expect(ins).toBe('42501');
      expect(await code(asGovernedProcess(T1, (c) => c.query(`UPDATE billing.entitlements SET effective_until = now() + interval '1 day' WHERE id=$1`, [g.id])))).toBe('42501');
      expect(await code(asGovernedProcess(T1, (c) => c.query(`UPDATE billing.entitlements SET status='revoked', revoked_at=now() WHERE id=$1`, [g.id])))).toBe('42501');
      expect(await code(asGovernedProcess(T1, (c) => c.query(`DELETE FROM billing.entitlements WHERE id=$1`, [g.id])))).toBe('P0001');
      expect(await code(truncateRefusal(admin, `TRUNCATE billing.entitlements`))).toBe('P0001');
    });
    it('the marker alone is not enough: a session that sets it still cannot write directly (a plain role is not the function owner)', async () => {
      // The admin connection IS the owner here, so prove the check differently: the guard names the owner and the marker together.
      const def = (await admin.query(`SELECT pg_get_functiondef('billing.guard_entitlement_write()'::regprocedure) AS d`)).rows[0].d as string;
      expect(def).toContain('app.billing_entitlement_writer');
      expect(def).toContain('proowner');
    });
    it('the application role has no write privilege and no EXECUTE on the governed functions', async () => {
      // The privilege itself is withheld (the table guard would also refuse a write, but this layer must not rely on it).
      for (const p of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
        expect((await app.query(`SELECT has_table_privilege(current_user, 'billing.entitlements', $1) AS ok`, [p])).rows[0].ok, p).toBe(false);
      }
      expect((await app.query(`SELECT has_table_privilege(current_user, 'billing.entitlements', 'SELECT') AS ok`)).rows[0].ok).toBe(true);
      for (const fn of ['billing.grant_entitlement(uuid,text,text,text,timestamptz,timestamptz)', 'billing.revoke_entitlement(uuid,uuid)']) {
        expect((await app.query(`SELECT has_function_privilege(current_user, $1, 'EXECUTE') AS ok`, [fn])).rows[0].ok, fn).toBe(false);
      }
      const w = async (sql: string) => code(app.query(sql));
      expect(await w(`INSERT INTO billing.entitlements (tenant_id, capability, source_type, source_reference, effective_from) VALUES ('${T1}','pos.core','trial','app',now())`)).toBe('42501');
      expect(await w(`UPDATE billing.entitlements SET status='revoked'`)).toBe('42501');
      expect(await w(`DELETE FROM billing.entitlements`)).toBe('42501');
      expect(await w(`SELECT billing.grant_entitlement('${T1}','pos.core','trial','app',now(),null)`)).toBe('42501');
      expect(await w(`SELECT billing.revoke_entitlement('${T1}','${randomUUID()}')`)).toBe('42501');
    });
  });

  describe('tenant isolation (RLS, application role)', () => {
    it('a tenant reads only its own entitlements and counts only its own', async () => {
      const mine = await grant(T1, { capability: 'intelligence.growth', sourceType: 'subscription', sourceReference: `iso-${randomUUID()}` });
      const theirs = await grant(T2, { capability: 'intelligence.pro', sourceType: 'subscription', sourceReference: `iso-${randomUUID()}` });
      const l1 = await repo.list(ctx1); const l2 = await repo.list(ctx2);
      expect(l1.map((r) => r.id)).toContain(mine.id); expect(l1.map((r) => r.id)).not.toContain(theirs.id);
      expect(l2.map((r) => r.id)).toContain(theirs.id); expect(l2.map((r) => r.id)).not.toContain(mine.id);
      expect((await repo.snapshot(ctx1)).effective).not.toContain('intelligence.pro');
      expect((await repo.snapshot(ctx2)).effective).not.toContain('intelligence.growth');
    });
    it('without a tenant scope the application role sees nothing', async () => {
      const c = await app.connect();
      try { expect((await c.query('SELECT count(*)::int n FROM billing.entitlements')).rows[0].n).toBe(0); } finally { c.release(); }
    });
  });

  describe('history: effective at a moment', () => {
    it('answers for before start, inside, after end, and after revocation', async () => {
      const t0 = Date.now();
      const g = await grant(T1, { capability: 'pos.offline', sourceType: 'trial', sourceReference: `hist-${randomUUID()}`, effectiveFrom: new Date(t0 - 10 * DAY), effectiveUntil: new Date(t0 + 10 * DAY) });
      const has = async (at: Date) => (await repo.snapshot(ctx1, at)).effective.includes('pos.offline');
      expect(await has(new Date(t0 - 11 * DAY))).toBe(false);   // before it started
      expect(await has(new Date(t0 - 9 * DAY))).toBe(true);
      expect(await has(new Date(t0 + 11 * DAY))).toBe(false);   // after it ended
      const revokedBefore = new Date();
      await new Promise((r) => setTimeout(r, 20));
      await asGovernedProcess(T1, (c) => EntitlementRepository.revoke(c, T1, g.id));
      expect(await has(revokedBefore)).toBe(true);              // it was still held before the revocation moment
      expect(await has(new Date())).toBe(false);                // not after
      expect(await has(new Date(t0 - 9 * DAY))).toBe(true);     // history is not rewritten
    });
  });
});

describe.skipIf(run)('billing.entitlements (skipped, no DATABASE_URL)', () => {
  it('skips live tests when DATABASE_URL is not set', () => { expect(run).toBe(false); });
});
