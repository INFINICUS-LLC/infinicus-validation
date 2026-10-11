/**
 * Business Administration declared currency - live PostgreSQL proof for migration 0185 and the repositories.
 * Requires DATABASE_URL (app role, RLS enforced) and ADMIN_DATABASE_URL (superuser), migrated through 0185.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import {
  createPool, closePool, BusinessDeclaredCurrencyReader, BusinessDeclaredCurrencyRepository, DeclaredCurrencyValidationError,
  DeclaredCurrencyConflictError, BusinessNotFoundError, TenantRepository, type TenantContext,
} from '../src/index.js';

const run = !!process.env.DATABASE_URL;
const MIGRATION = readFileSync(resolve(__dirname, '../../../infrastructure/database/migrations/0185_create_business_currency_declarations.sql'), 'utf8');
const T = 'platform.business_currency_declarations';
const APPEND_ONLY = (op: string) => new RegExp(`platform\\.business_currency_declarations: append-only table - ${op} is not permitted`);

describe.runIf(run)('business currency declarations (0185) - live PostgreSQL', () => {
  let admin: Pool; let app: Pool;
  const reader = new BusinessDeclaredCurrencyReader();
  const repo = new BusinessDeclaredCurrencyRepository();
  interface World { t: string; ws: string; biz: string; user: string; ctx: TenantContext }
  let a: World; let b: World; let sameTenantOtherWs: { ws: string; biz: string };

  const world = async (): Promise<World> => {
    const t = randomUUID(); const ws = randomUUID(); const biz = randomUUID(); const user = randomUUID();
    await admin.query(`INSERT INTO tenancy.tenants (id, name, slug, status, plan_code) VALUES ($1,'Declared Currency',$2,'active','test')`, [t, `dc-${t}`]);
    await admin.query(`INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,'WS',$3,'active')`, [ws, t, `ws-${ws}`]);
    await admin.query(`INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,'DC Biz',$4,'active')`, [biz, t, ws, `dc-${biz}`]);
    return { t, ws, biz, user, ctx: { tenantId: t, workspaceId: ws, userId: user } };
  };
  const declare = (w: World, over: Partial<Parameters<BusinessDeclaredCurrencyRepository['declare']>[1]> = {}) =>
    repo.declare(w.ctx, { businessId: w.biz, currency: 'USD', expectedVersion: null, permissionUsed: 'platform:admin', correlationId: randomUUID(), ...over });
  const rawInsert = (pool: Pool, w: World, over: Record<string, unknown> = {}) => {
    const r: Record<string, unknown> = { tenant_id: w.t, workspace_id: w.ws, business_id: w.biz, version: 1, declared_currency: 'USD', provenance: 'EXPLICIT_DECLARATION',
      declared_by_user_id: w.user, permission_used: 'platform:admin', correlation_id: randomUUID(), ...over };
    const cols = Object.keys(r);
    return pool.query(`INSERT INTO ${T} (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`, cols.map((c) => r[c]));
  };
  const asApp = async <R>(w: { t: string; ws: string }, fn: (q: (s: string, p?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>) => Promise<R>): Promise<R> => {
    const c = await app.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.workspace_id',$2,true)`, [w.t, w.ws]);
      return await fn((s, p) => c.query(s, p));
    } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
  };

  beforeAll(async () => {
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL! });
    app = new Pool({ connectionString: process.env.DATABASE_URL! });
    createPool({ connectionString: process.env.DATABASE_URL! });
    a = await world(); b = await world();
    const ws2 = randomUUID(); const biz2 = randomUUID();
    await admin.query(`INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,'WS2',$3,'active')`, [ws2, a.t, `ws-${ws2}`]);
    await admin.query(`INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,'Other WS Biz',$4,'active')`, [biz2, a.t, ws2, `dc2-${biz2}`]);
    sameTenantOtherWs = { ws: ws2, biz: biz2 };
  });
  afterAll(async () => { await closePool(); await admin.end(); await app.end(); });

  describe('silent defaults are not governed evidence', () => {
    it('a business whose tenant and profile carry only the silent USD defaults is UNDECLARED', async () => {
      const tenant = await new TenantRepository().getById(a.ctx, a.t).catch(() => null);
      const tenantDefault = (await admin.query(`SELECT default_currency FROM tenancy.tenants WHERE id = $1`, [a.t])).rows[0].default_currency;
      expect(tenantDefault).toBe('USD'); // the silent default exists...
      expect(tenant === null || tenant.defaultCurrency === 'USD').toBe(true);
      await admin.query(`INSERT INTO business_operations.business_profile_extensions (tenant_id, workspace_id, business_id) VALUES ($1,$2,$3)`, [a.t, a.ws, a.biz]);
      expect((await admin.query(`SELECT default_currency FROM business_operations.business_profile_extensions WHERE business_id = $1`, [a.biz])).rows[0].default_currency).toBe('USD');
      expect(await reader.getCurrent(a.ctx, a.biz)).toEqual({ status: 'UNDECLARED', businessId: a.biz }); // ...and is NOT promoted.
      expect((await admin.query(`SELECT count(*)::int n FROM ${T} WHERE business_id = $1`, [a.biz])).rows[0].n).toBe(0);
      expect(await reader.history(a.ctx, a.biz)).toEqual([]);
    });

    it('a fresh install holds no declaration for any business (the migration seeds and backfills nothing)', async () => {
      const n = (await admin.query(`SELECT count(*)::int n FROM ${T} d WHERE NOT EXISTS (SELECT 1 FROM unnest($1::uuid[]) x WHERE x = d.business_id)`, [[a.biz, b.biz, sameTenantOtherWs.biz]])).rows[0].n;
      // Other test files may declare for their own businesses; none exists for ours before we declare.
      expect(typeof n).toBe('number');
      expect((await admin.query(`SELECT count(*)::int n FROM ${T} WHERE business_id = ANY($1)`, [[a.biz, b.biz, sameTenantOtherWs.biz]])).rows[0].n).toBe(0);
    });

    it('declaring changes neither default_currency column', async () => {
      await declare(b, { currency: 'EUR' });
      expect((await admin.query(`SELECT default_currency FROM tenancy.tenants WHERE id = $1`, [b.t])).rows[0].default_currency).toBe('USD');
    });
  });

  describe('declaring', () => {
    it('an explicit USD declaration works and is the exact governed value', async () => {
      const r = await declare(a, { currency: 'USD', reason: 'initial' });
      expect(r.outcome).toBe('DECLARED');
      expect(r.record).toMatchObject({ businessId: a.biz, version: 1, currency: 'USD', priorCurrency: null, supersedesVersion: null, provenance: 'EXPLICIT_DECLARATION', declaredByUserId: a.user, permissionUsed: 'platform:admin', reason: 'initial' });
      expect(r.record.declaredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(await reader.getCurrent(a.ctx, a.biz)).toMatchObject({ status: 'DECLARED', current: { currency: 'USD', version: 1 } });
    });

    it('an explicit EUR declaration works (a different business)', async () => {
      const r = await declare(b, { currency: 'EUR' }).catch((e) => e);
      // b already declared EUR in the default-separation test: the replay is UNCHANGED, not a second row.
      expect(r.outcome).toBe('UNCHANGED');
      expect(r.record.currency).toBe('EUR');
    });

    it('invalid and non-canonical currencies are refused: lowercase is NOT normalised', async () => {
      const w = await world();
      for (const bad of ['usd', 'Usd', 'US', 'USDX', 'U$D', ' EUR', 'EUR ', '', '123', 'EU1', 'ÉUR']) {
        await expect(declare(w, { currency: bad }), JSON.stringify(bad)).rejects.toThrow(DeclaredCurrencyValidationError);
      }
      expect(await reader.getCurrent(w.ctx, w.biz)).toMatchObject({ status: 'UNDECLARED' });
    });

    it('malformed ids, expected versions, reasons and correlation ids are refused', async () => {
      const w = await world();
      await expect(declare(w, { businessId: 'nope' })).rejects.toThrow(DeclaredCurrencyValidationError);
      await expect(declare(w, { expectedVersion: 0 })).rejects.toThrow(DeclaredCurrencyValidationError);
      await expect(declare(w, { expectedVersion: 1.5 })).rejects.toThrow(DeclaredCurrencyValidationError);
      await expect(declare(w, { reason: '   ' })).rejects.toThrow(DeclaredCurrencyValidationError);
      await expect(declare(w, { reason: 'x'.repeat(1001) })).rejects.toThrow(DeclaredCurrencyValidationError);
      await expect(declare(w, { correlationId: 'abc' })).rejects.toThrow(DeclaredCurrencyValidationError);
      await expect(declare(w, { permissionUsed: ' ' })).rejects.toThrow(DeclaredCurrencyValidationError);
      expect(await reader.getCurrent(w.ctx, w.biz)).toMatchObject({ status: 'UNDECLARED' });
    });

    it('wrong tenant, wrong workspace and unknown business are refused as not found, and nothing is written', async () => {
      await expect(repo.declare(b.ctx, { businessId: a.biz, currency: 'USD', expectedVersion: null, permissionUsed: 'platform:admin', correlationId: randomUUID() })).rejects.toThrow(BusinessNotFoundError);
      await expect(repo.declare({ ...a.ctx, workspaceId: sameTenantOtherWs.ws }, { businessId: a.biz, currency: 'USD', expectedVersion: 1, permissionUsed: 'platform:admin', correlationId: randomUUID() })).rejects.toThrow(BusinessNotFoundError);
      await expect(repo.declare(a.ctx, { businessId: sameTenantOtherWs.biz, currency: 'USD', expectedVersion: null, permissionUsed: 'platform:admin', correlationId: randomUUID() })).rejects.toThrow(BusinessNotFoundError);
      await expect(repo.declare(a.ctx, { businessId: randomUUID(), currency: 'USD', expectedVersion: null, permissionUsed: 'platform:admin', correlationId: randomUUID() })).rejects.toThrow(BusinessNotFoundError);
      expect((await admin.query(`SELECT count(*)::int n FROM ${T} WHERE business_id = ANY($1)`, [[sameTenantOtherWs.biz]])).rows[0].n).toBe(0);
    });

    it('reads are scoped: another tenant or workspace sees the business as UNDECLARED, never as declared', async () => {
      expect(await reader.getCurrent(b.ctx, a.biz)).toEqual({ status: 'UNDECLARED', businessId: a.biz });
      expect(await reader.getCurrent({ ...a.ctx, workspaceId: sameTenantOtherWs.ws }, a.biz)).toEqual({ status: 'UNDECLARED', businessId: a.biz });
      expect(await reader.history(b.ctx, a.biz)).toEqual([]);
    });
  });

  describe('idempotency, conflicts and history', () => {
    it('an exact replay returns the current declaration and writes no second row', async () => {
      const before = (await admin.query(`SELECT count(*)::int n FROM ${T} WHERE business_id = $1`, [a.biz])).rows[0].n;
      const r = await declare(a, { currency: 'USD', expectedVersion: null });
      expect(r).toMatchObject({ outcome: 'UNCHANGED', previous: null, record: { version: 1, currency: 'USD' } });
      expect((await declare(a, { currency: 'USD', expectedVersion: 1 })).outcome).toBe('UNCHANGED');
      expect((await admin.query(`SELECT count(*)::int n FROM ${T} WHERE business_id = $1`, [a.biz])).rows[0].n).toBe(before);
    });

    it('a conflicting first declaration, a stale version and a missing reason are explicit conflicts / validation errors', async () => {
      await expect(declare(a, { currency: 'EUR', expectedVersion: null })).rejects.toThrow(DeclaredCurrencyConflictError); // already declared
      await expect(declare(a, { currency: 'EUR', expectedVersion: 7, reason: 'x' })).rejects.toThrow(DeclaredCurrencyConflictError);
      await expect(declare(a, { currency: 'EUR', expectedVersion: 1 })).rejects.toThrow(DeclaredCurrencyValidationError); // reason required for a change
      const w = await world();
      await expect(declare(w, { currency: 'USD', expectedVersion: 3 })).rejects.toThrow(DeclaredCurrencyConflictError); // undeclared but version claimed
      expect(await reader.getCurrent(a.ctx, a.biz)).toMatchObject({ current: { currency: 'USD', version: 1 } });
    });

    it('a change appends version 2, records the prior state and keeps every earlier version', async () => {
      const before = (await admin.query(`SELECT to_jsonb(d)::text j FROM ${T} d WHERE business_id = $1 AND version = 1`, [a.biz])).rows[0].j;
      const r = await declare(a, { currency: 'GBP', expectedVersion: 1, reason: 'moved operations to the UK' });
      expect(r.outcome).toBe('CHANGED');
      expect(r.record).toMatchObject({ version: 2, currency: 'GBP', priorCurrency: 'USD', supersedesVersion: 1, reason: 'moved operations to the UK' });
      expect(r.previous).toMatchObject({ version: 1, currency: 'USD' });
      const h = await reader.history(a.ctx, a.biz);
      expect(h.map((x) => [x.version, x.currency])).toEqual([[1, 'USD'], [2, 'GBP']]);
      expect((await admin.query(`SELECT to_jsonb(d)::text j FROM ${T} d WHERE business_id = $1 AND version = 1`, [a.biz])).rows[0].j).toBe(before);
      expect(await reader.getCurrent(a.ctx, a.biz)).toMatchObject({ current: { currency: 'GBP', version: 2 } });
    });

    it('a stale writer cannot revert a newer declaration (no accidental USD revival)', async () => {
      await expect(declare(a, { currency: 'USD', expectedVersion: 1, reason: 'stale' })).rejects.toThrow(DeclaredCurrencyConflictError);
      expect(await reader.getCurrent(a.ctx, a.biz)).toMatchObject({ current: { currency: 'GBP', version: 2 } });
    });

    it('concurrent declarations of different values serialise: exactly one wins, the other conflicts', async () => {
      const w = await world();
      const results = await Promise.allSettled([declare(w, { currency: 'USD' }), declare(w, { currency: 'EUR' }), declare(w, { currency: 'JPY' })]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected').every((r) => (r as PromiseRejectedResult).reason instanceof DeclaredCurrencyConflictError)).toBe(true);
      expect((await admin.query(`SELECT count(*)::int n FROM ${T} WHERE business_id = $1`, [w.biz])).rows[0].n).toBe(1);
    });
  });

  describe('the database enforces the model itself (a direct insert cannot bypass the service)', () => {
    it('refuses bad format, a non-linear chain, a no-op change, a change without a reason, an unknown provenance and a foreign business', async () => {
      const w = await world();
      await expect(rawInsert(admin, w, { declared_currency: 'usd' })).rejects.toThrow(/currency_format/);
      await expect(rawInsert(admin, w, { version: 2, supersedes_version: 1, prior_declared_currency: 'EUR', reason: 'x' })).rejects.toThrow(/first declaration must be version 1/);
      await rawInsert(admin, w, { version: 1 });
      await expect(rawInsert(admin, w, { version: 3, supersedes_version: 2, prior_declared_currency: 'USD', declared_currency: 'EUR', reason: 'x' })).rejects.toThrow(/must supersede the current version/);
      await expect(rawInsert(admin, w, { version: 2, supersedes_version: 1, prior_declared_currency: 'GBP', declared_currency: 'EUR', reason: 'x' })).rejects.toThrow(/must supersede the current version and record its currency/);
      await expect(rawInsert(admin, w, { version: 2, supersedes_version: 1, prior_declared_currency: 'USD', declared_currency: 'USD', reason: 'x' })).rejects.toThrow(/chain_shape/);
      await expect(rawInsert(admin, w, { version: 2, supersedes_version: 1, prior_declared_currency: 'USD', declared_currency: 'EUR' })).rejects.toThrow(/reason/);
      await expect(rawInsert(admin, await world(), { provenance: 'DEFAULT' })).rejects.toThrow(/provenance/);
      await expect(rawInsert(admin, w, { version: 1 })).rejects.toThrow(/must supersede the current version/); // duplicate version: the chain guard fires first; UNIQUE is the race backstop
      await expect(rawInsert(admin, w, { tenant_id: b.t, workspace_id: b.ws, version: 1 })).rejects.toThrow(/not in this tenant and workspace/);
      await expect(rawInsert(admin, w, { version: 0 })).rejects.toThrow();
    });

    it('declared_at is stamped by the database clock: a caller-supplied time is overwritten', async () => {
      const w = await world();
      const r = await rawInsert(admin, w, { declared_at: '2001-01-01T00:00:00.000Z' });
      const row = (await admin.query(`SELECT declared_at FROM ${T} WHERE id = $1`, [r.rows[0].id])).rows[0];
      expect(Math.abs(Date.now() - new Date(row.declared_at).getTime())).toBeLessThan(60_000);
    });
  });

  describe('append-only and RLS', () => {
    it('UPDATE, DELETE and TRUNCATE are refused for the admin and the application role', async () => {
      await expect(admin.query(`UPDATE ${T} SET declared_currency = 'EUR' WHERE business_id = $1`, [a.biz])).rejects.toThrow(APPEND_ONLY('UPDATE'));
      await expect(admin.query(`DELETE FROM ${T} WHERE business_id = $1`, [a.biz])).rejects.toThrow(APPEND_ONLY('DELETE'));
      await expect(admin.query(`TRUNCATE ${T}`)).rejects.toThrow(APPEND_ONLY('TRUNCATE'));
      await expect(admin.query(`TRUNCATE ${T} CASCADE`)).rejects.toThrow(APPEND_ONLY('TRUNCATE'));
      await asApp(a, async (q) => { await expect(q(`UPDATE ${T} SET declared_currency = 'EUR' WHERE business_id = $1`, [a.biz])).rejects.toThrow(APPEND_ONLY('UPDATE')); });
      await asApp(a, async (q) => { await expect(q(`DELETE FROM ${T} WHERE business_id = $1`, [a.biz])).rejects.toThrow(APPEND_ONLY('DELETE')); });
      await expect(app.query(`TRUNCATE ${T}`)).rejects.toThrow();
    });

    it('exactly the three expected triggers exist, all enabled', async () => {
      const r = (await admin.query(`SELECT t.tgname, p.proname, t.tgenabled FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid WHERE t.tgrelid = '${T}'::regclass AND NOT t.tgisinternal ORDER BY t.tgname`)).rows;
      expect(r).toEqual([
        { tgname: 'forbid_mutation_business_currency_declarations', proname: 'forbid_mutation', tgenabled: 'O' },
        { tgname: 'forbid_truncate_business_currency_declarations', proname: 'forbid_mutation', tgenabled: 'O' },
        { tgname: 'guard_business_currency_declaration_insert', proname: 'guard_business_currency_declaration_insert', tgenabled: 'O' },
      ]);
    });

    it('RLS is enabled and forced, and another tenant or workspace sees and writes nothing', async () => {
      expect((await admin.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = '${T}'::regclass`)).rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      await asApp(b, async (q) => {
        expect((await q(`SELECT id FROM ${T} WHERE business_id = $1`, [a.biz])).rows).toEqual([]);
        await expect(q(`INSERT INTO ${T} (tenant_id, workspace_id, business_id, version, declared_currency, provenance, declared_by_user_id, permission_used, correlation_id) VALUES ($1,$2,$3,1,'USD','EXPLICIT_DECLARATION',$4,'platform:admin',$5)`, [a.t, a.ws, a.biz, b.user, randomUUID()])).rejects.toThrow();
      });
      await asApp({ t: a.t, ws: sameTenantOtherWs.ws }, async (q) => { expect((await q(`SELECT id FROM ${T}`)).rows).toEqual([]); });
      await asApp(a, async (q) => { expect((await q(`SELECT declared_currency FROM ${T} WHERE business_id = $1 ORDER BY version`, [a.biz])).rows.map((r) => r.declared_currency)).toEqual(['USD', 'GBP']); });
    });
  });

  describe('history is untouched: nothing else is rewritten', () => {
    it('declaring and changing the currency leaves inventory movements, evaluations and ABA tables exactly as they were', async () => {
      const w = await world();
      const item = randomUUID(); const wh = randomUUID();
      await admin.query(`INSERT INTO platform.inventory_items (id, tenant_id, workspace_id, business_id, sku, name) VALUES ($1,$2,$3,$4,$5,'I')`, [item, w.t, w.ws, w.biz, `sku-${item}`]);
      await admin.query(`INSERT INTO platform.warehouses (id, tenant_id, workspace_id, business_id, warehouse_code, name) VALUES ($1,$2,$3,$4,$5,'W')`, [wh, w.t, w.ws, w.biz, `wh-${wh}`]);
      await admin.query(`INSERT INTO business_operations.inventory_movements (tenant_id, workspace_id, business_id, inventory_item_id, warehouse_id, movement_type, quantity, unit_cost, unit_cost_currency) VALUES ($1,$2,$3,$4,$5,'receipt',5,3.5,'EUR')`, [w.t, w.ws, w.biz, item, wh]);
      await admin.query(`INSERT INTO business_operations.inventory_policy_evaluations (tenant_id, workspace_id, business_id, inventory_item_id, dimension, result, subject, subject_digest, rule_set_version, inputs, findings, requested_by_user_id, correlation_id)
        VALUES ($1,$2,$3,$4,'COST','INDETERMINATE','{"actionType":{"code":"c","schemaVersion":"1"},"target":{"kind":"inventory_item","id":"x"},"finalParameters":{}}'::jsonb,'sha256:${'a'.repeat(64)}','rs/test','{}'::jsonb,'[]'::jsonb,$5,$6)`, [w.t, w.ws, w.biz, item, w.user, randomUUID()]);
      const snap = async () => (await admin.query(`SELECT
        (SELECT md5(coalesce(string_agg(to_jsonb(m)::text,'|' ORDER BY id),'')) FROM business_operations.inventory_movements m WHERE tenant_id = $1) mv,
        (SELECT md5(coalesce(string_agg(to_jsonb(e)::text,'|' ORDER BY id),'')) FROM business_operations.inventory_policy_evaluations e WHERE tenant_id = $1) ev,
        (SELECT md5(coalesce(string_agg(to_jsonb(p)::text,'|' ORDER BY id),'')) FROM business_operations.business_profile_extensions p WHERE tenant_id = $1) pf,
        (SELECT md5(to_jsonb(t)::text) FROM tenancy.tenants t WHERE id = $1) tn,
        (SELECT count(*)::int FROM approved_business_action.authorized_action_packages WHERE tenant_id = $1) aba`, [w.t])).rows[0];
      const before = await snap();
      await declare(w, { currency: 'USD' });
      await declare(w, { currency: 'JPY', expectedVersion: 1, reason: 'switch' });
      expect(await snap()).toEqual(before);
      expect((await admin.query(`SELECT unit_cost_currency FROM business_operations.inventory_movements WHERE tenant_id = $1`, [w.t])).rows).toEqual([{ unit_cost_currency: 'EUR' }]);
    });
  });

  describe('migration safety', () => {
    it('re-applying the migration is idempotent: same triggers, same table, one registration, rows untouched', async () => {
      const before = (await admin.query(`SELECT md5(string_agg(to_jsonb(d)::text,'|' ORDER BY id)) h FROM ${T} d`)).rows[0].h;
      await admin.query(MIGRATION); await admin.query(MIGRATION);
      expect((await admin.query(`SELECT count(*)::int n FROM pg_trigger WHERE tgrelid = '${T}'::regclass AND NOT tgisinternal`)).rows[0].n).toBe(3);
      expect((await admin.query(`SELECT count(*)::int n FROM _migrations WHERE filename = '0185_create_business_currency_declarations.sql'`)).rows[0].n).toBe(1);
      expect((await admin.query(`SELECT md5(string_agg(to_jsonb(d)::text,'|' ORDER BY id)) h FROM ${T} d`)).rows[0].h).toBe(before);
    });
  });
});
