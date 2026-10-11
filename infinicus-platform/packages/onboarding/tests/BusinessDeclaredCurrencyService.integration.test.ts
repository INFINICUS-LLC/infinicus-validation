/**
 * Business Administration declared currency - service-level proof on live PostgreSQL (RLS enforced for the app role).
 * Requires DATABASE_URL (app role) and ADMIN_DATABASE_URL (inspection / fixtures), migrated through 0185.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import {
  createPool, closePool, BusinessAdministrationAuditRepository, BusinessDeclaredCurrencyReader, BusinessDeclaredCurrencyRepository, BusinessNotFoundError, DeclaredCurrencyConflictError,
  DeclaredCurrencyValidationError, type TenantContext,
} from '@infinicus/database';
import { BusinessDeclaredCurrencyService, DECLARED_CURRENCY_AUDIT_CHANGED, DECLARED_CURRENCY_AUDIT_DECLARED } from '../src/index.js';

const run = !!process.env.DATABASE_URL && !!process.env.ADMIN_DATABASE_URL;
const T = 'platform.business_currency_declarations';
const PERM = 'platform:admin';

describe.runIf(run)('BusinessDeclaredCurrencyService - live PostgreSQL', () => {
  let admin: Pool;
  const service = new BusinessDeclaredCurrencyService();

  interface W { ctx: TenantContext; biz: string }
  const world = async (): Promise<W> => {
    const t = randomUUID(); const ws = randomUUID(); const biz = randomUUID(); const user = randomUUID();
    await admin.query(`INSERT INTO tenancy.tenants (id, name, slug, status, plan_code) VALUES ($1,'DC Service',$2,'active','test')`, [t, `dcs-${t}`]);
    await admin.query(`INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,'WS',$3,'active')`, [ws, t, `ws-${ws}`]);
    await admin.query(`INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,'DC Biz',$4,'active')`, [biz, t, ws, `dcs-${biz}`]);
    return { ctx: { tenantId: t, workspaceId: ws, userId: user }, biz };
  };
  const rc = (correlationId: string = randomUUID()) => ({ permissionUsed: PERM, correlationId });
  const audits = async (w: W) => (await admin.query(
    `SELECT action, actor_id, entity_type, entity_id, business_id, metadata, correlation_id FROM audit.audit_events WHERE tenant_id = $1 AND action LIKE 'business_admin.%' ORDER BY occurred_at, id`, [w.ctx.tenantId])).rows;
  const rows = async (w: W) => (await admin.query(`SELECT version, declared_currency FROM ${T} WHERE business_id = $1 ORDER BY version`, [w.biz])).rows;

  beforeAll(async () => {
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
    createPool({ connectionString: process.env.DATABASE_URL! });
  });
  afterAll(async () => { await admin.end(); await closePool(); });

  it('a business with only silent USD defaults is UNDECLARED through the service and the read boundary', async () => {
    const w = await world();
    expect((await admin.query(`SELECT default_currency FROM tenancy.tenants WHERE id = $1`, [w.ctx.tenantId])).rows[0].default_currency).toBe('USD');
    expect(await service.getCurrent(w.ctx, w.biz)).toEqual({ status: 'UNDECLARED', businessId: w.biz });
    expect(await new BusinessDeclaredCurrencyReader().getCurrent(w.ctx, w.biz)).toEqual({ status: 'UNDECLARED', businessId: w.biz });
    expect(await rows(w)).toEqual([]);
    expect(await audits(w)).toEqual([]);
  });

  it('explicit USD and explicit EUR declarations work and are audited with actor, scope, permission, prior state and correlation id', async () => {
    const usd = await world(); const eur = await world();
    const c1 = randomUUID();
    const r1 = await service.declare(usd.ctx, rc(c1), { businessId: usd.biz, currency: 'USD', expectedVersion: null, reason: 'first' });
    const r2 = await service.declare(eur.ctx, rc(), { businessId: eur.biz, currency: 'EUR', expectedVersion: null });
    expect(r1).toMatchObject({ outcome: 'DECLARED', declaration: { currency: 'USD', version: 1 } });
    expect(r2).toMatchObject({ outcome: 'DECLARED', declaration: { currency: 'EUR', version: 1 } });
    const [row] = await audits(usd);
    expect(row).toMatchObject({ action: DECLARED_CURRENCY_AUDIT_DECLARED, actor_id: usd.ctx.userId, entity_type: 'BusinessDeclaredCurrency', entity_id: r1.declaration.declarationId, business_id: usd.biz, correlation_id: c1 });
    expect(row.metadata).toMatchObject({ permissionUsed: PERM, outcome: 'DECLARED', priorState: 'UNDECLARED', priorCurrency: null, priorVersion: null, newCurrency: 'USD', newVersion: 1, reason: 'first' });
    expect((await audits(usd))).toHaveLength(1);
  });

  it('exact replay returns the stored declaration and writes neither a second row nor a second audit entry', async () => {
    const w = await world();
    await service.declare(w.ctx, rc(), { businessId: w.biz, currency: 'USD', expectedVersion: null });
    const again = await service.declare(w.ctx, rc(), { businessId: w.biz, currency: 'USD', expectedVersion: null });
    expect(again.outcome).toBe('UNCHANGED');
    expect(again.declaration.version).toBe(1);
    expect(await rows(w)).toEqual([{ version: 1, declared_currency: 'USD' }]);
    expect(await audits(w)).toHaveLength(1);
  });

  it('a change records the prior state, requires expectedVersion and a reason, and preserves history; a conflicting request is an explicit 409-class error', async () => {
    const w = await world();
    await service.declare(w.ctx, rc(), { businessId: w.biz, currency: 'USD', expectedVersion: null });
    await expect(service.declare(w.ctx, rc(), { businessId: w.biz, currency: 'EUR', expectedVersion: null, reason: 'x' })).rejects.toThrow(DeclaredCurrencyConflictError);
    await expect(service.declare(w.ctx, rc(), { businessId: w.biz, currency: 'EUR', expectedVersion: 1 })).rejects.toThrow(DeclaredCurrencyValidationError);
    expect(await rows(w)).toEqual([{ version: 1, declared_currency: 'USD' }]);
    const changed = await service.declare(w.ctx, rc(), { businessId: w.biz, currency: 'EUR', expectedVersion: 1, reason: 'now trading in the euro area' });
    expect(changed).toMatchObject({ outcome: 'CHANGED', declaration: { version: 2, currency: 'EUR', priorCurrency: 'USD', supersedesVersion: 1 } });
    expect(await rows(w)).toEqual([{ version: 1, declared_currency: 'USD' }, { version: 2, declared_currency: 'EUR' }]);
    expect((await service.history(w.ctx, w.biz)).map((h) => h.currency)).toEqual(['USD', 'EUR']);
    const a = await audits(w);
    expect(a.map((x) => x.action)).toEqual([DECLARED_CURRENCY_AUDIT_DECLARED, DECLARED_CURRENCY_AUDIT_CHANGED]);
    expect(a[1].metadata).toMatchObject({ outcome: 'CHANGED', priorState: 'DECLARED', priorCurrency: 'USD', priorVersion: 1, newCurrency: 'EUR', newVersion: 2, reason: 'now trading in the euro area' });
  });

  it('an audit failure rolls the declaration back: no row, and UNDECLARED remains UNDECLARED', async () => {
    const w = await world();
    const failing = new BusinessDeclaredCurrencyService({ repository: new BusinessDeclaredCurrencyRepository({ recordWith: async () => { throw new Error('audit store unavailable'); } }) });
    await expect(failing.declare(w.ctx, rc(), { businessId: w.biz, currency: 'USD', expectedVersion: null })).rejects.toThrow('audit store unavailable');
    expect(await rows(w)).toEqual([]);
    expect(await service.getCurrent(w.ctx, w.biz)).toMatchObject({ status: 'UNDECLARED' });
    // and the same for a change
    await service.declare(w.ctx, rc(), { businessId: w.biz, currency: 'USD', expectedVersion: null });
    await expect(failing.declare(w.ctx, rc(), { businessId: w.biz, currency: 'EUR', expectedVersion: 1, reason: 'x' })).rejects.toThrow('audit store unavailable');
    expect(await rows(w)).toEqual([{ version: 1, declared_currency: 'USD' }]);
    expect(await audits(w)).toHaveLength(1);
  });

  it('a database-level audit failure (a real constraint violation) also rolls the declaration back', async () => {
    const w = await world();
    const real = new BusinessAdministrationAuditRepository();
    const bad = new BusinessDeclaredCurrencyService({ repository: new BusinessDeclaredCurrencyRepository({
      recordWith: (client, ctx, input) => real.recordWith(client, ctx, { ...input, entityId: 'not-a-uuid' }), // a real database error inside the same transaction
    }) });
    await expect(bad.declare(w.ctx, rc(), { businessId: w.biz, currency: 'USD', expectedVersion: null })).rejects.toThrow();
    expect(await rows(w)).toEqual([]);
  });

  it('wrong tenant, wrong workspace and wrong business are refused as not found and nothing is written or audited', async () => {
    const w = await world(); const other = await world();
    await expect(service.declare(other.ctx, rc(), { businessId: w.biz, currency: 'USD', expectedVersion: null })).rejects.toThrow(BusinessNotFoundError);
    await expect(service.declare({ ...w.ctx, workspaceId: randomUUID() }, rc(), { businessId: w.biz, currency: 'USD', expectedVersion: null })).rejects.toThrow();
    await expect(service.declare(w.ctx, rc(), { businessId: randomUUID(), currency: 'USD', expectedVersion: null })).rejects.toThrow(BusinessNotFoundError);
    expect(await rows(w)).toEqual([]);
    expect(await audits(w)).toEqual([]);
    expect(await audits(other)).toEqual([]);
  });

  it('lowercase and malformed currencies are refused without any write or audit', async () => {
    const w = await world();
    for (const bad of ['usd', 'US', 'USDX', '', 'U$D']) {
      await expect(service.declare(w.ctx, rc(), { businessId: w.biz, currency: bad, expectedVersion: null })).rejects.toThrow(DeclaredCurrencyValidationError);
    }
    expect(await rows(w)).toEqual([]);
    expect(await audits(w)).toEqual([]);
  });

  it('a non-UUID edge correlation id is normalised for storage and the original is kept in the audit metadata', async () => {
    const w = await world();
    await service.declare(w.ctx, rc('req-abc-123'), { businessId: w.biz, currency: 'USD', expectedVersion: null });
    const [row] = await audits(w);
    expect(row.correlation_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.metadata.requestCorrelationId).toBe('req-abc-123');
  });
});
