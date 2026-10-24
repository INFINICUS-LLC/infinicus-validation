import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { closePool, createPool, type TenantContext } from '../src/client.js';
import { SalesWindowEvidenceReviewRepository, type SalesWindowReviewInput } from '../src/repositories/bo/SalesWindowEvidenceReviewRepository.js';

const reader = new SalesWindowEvidenceReviewRepository();
const businessId = randomUUID();
const bounds: SalesWindowReviewInput = {
  businessId, currencyCode: 'USD', executionAt: '2026-10-02T00:00:00.000Z',
  baselineOpenedAt: '2026-10-01T00:00:00.000Z', baselineClosedAt: '2026-10-02T00:00:00.000Z',
  windowOpenedAt: '2026-10-02T00:00:00.000Z', windowClosedAt: '2026-10-03T00:00:00.000Z',
};
const ctx: TenantContext = { tenantId: randomUUID(), workspaceId: randomUUID(), userId: randomUUID() };

describe('window review input refusal', () => {
  it('rejects malformed UTC, uneven or noncontiguous periods, unapproved currency and execution mismatch before querying', async () => {
    for (const [change, blocker] of [
      [{ baselineOpenedAt: '2026-10-01T00:00:00Z' }, 'INVALID_UTC_BOUNDS'],
      [{ baselineOpenedAt: '2026-02-30T00:00:00.000Z' }, 'INVALID_UTC_BOUNDS'],
      [{ windowClosedAt: '2026-10-04T00:00:00.000Z' }, 'UNEQUAL_PERIODS'],
      [{ baselineClosedAt: '2026-10-01T23:00:00.000Z' }, 'INVALID_UTC_BOUNDS'],
      [{ executionAt: '2026-10-01T12:00:00.000Z' }, 'EXECUTION_BOUNDARY_MISMATCH'],
      [{ currencyCode: 'ZZZ' }, 'INVALID_SCOPE'],
    ] as const) {
      const result = await reader.read(ctx, { ...bounds, ...change });
      expect(result.authoritative).toBe(false);
      expect(result.blockers).toContain(blocker);
      expect(result.blockers).toContain('REFUND_SOURCE_UNAVAILABLE');
    }
  });
});

describe.runIf(!!process.env.DATABASE_URL && !!process.env.ADMIN_DATABASE_URL)('window review on disposable PostgreSQL', () => {
  let admin: Pool;
  beforeAll(async () => {
    createPool({ connectionString: process.env.DATABASE_URL! });
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL! });
    await admin.query(`INSERT INTO tenancy.tenants (id,name,slug,status,plan_code) VALUES ($1,'M2 test',$2,'active','test')`, [ctx.tenantId, `m2-${ctx.tenantId}`]);
    await admin.query(`INSERT INTO tenancy.workspaces (id,tenant_id,name,slug,status) VALUES ($1,$2,'M2 test',$3,'active')`, [ctx.workspaceId, ctx.tenantId, `m2-${ctx.workspaceId}`]);
    await admin.query(`INSERT INTO platform.businesses (id,tenant_id,workspace_id,legal_name,business_code,status) VALUES ($1,$2,$3,'M2 test',$4,'active')`, [businessId, ctx.tenantId, ctx.workspaceId, `m2-${businessId}`]);
  });
  afterAll(async () => { await admin?.end(); await closePool(); });
  const add = async (at: string, options: { business?: string; currency?: string; created?: string; amount?: string; order?: string } = {}) => {
    const order = options.order ?? randomUUID();
    if (!options.order) await admin.query(`INSERT INTO platform.orders
      (id,tenant_id,workspace_id,business_id,order_number,order_date,currency_code,total_amount,operational_status,created_at)
      VALUES ($1,$2,$3,$4,$5,'2026-10-01',$6,$7,'completed',$8)`,
    [order, ctx.tenantId, ctx.workspaceId, options.business ?? businessId, `m2-${order}`, options.currency ?? 'USD', options.amount ?? '10.0000', options.created ?? '2026-09-30T00:00:00Z']);
    const event = await admin.query<{ id: string }>(`INSERT INTO business_operations.order_events
      (tenant_id,workspace_id,business_id,order_id,event_type,previous_status,new_status,occurred_at)
      VALUES ($1,$2,$3,$4,'completed','planned','completed',$5) RETURNING id`,
    [ctx.tenantId, ctx.workspaceId, options.business ?? businessId, order, at]);
    return { order, event: event.rows[0].id };
  };

  it('uses half-open completion time rather than order creation and stays nonauthoritative', async () => {
    await add(bounds.baselineOpenedAt);
    await add(bounds.windowOpenedAt);
    await add(bounds.windowClosedAt);
    const result = await reader.read(ctx, bounds);
    expect(result).toMatchObject({ authoritative: false, baselineCount: 1, windowCount: 1 });
    expect(result.blockers).toContain('SOURCE_MUTABLE');
    expect(result.blockers).toContain('REFUND_SOURCE_UNAVAILABLE');
  });

  it('detects duplicate completion, currency mismatch, impossible timestamp and source correction', async () => {
    const first = await add('2026-10-02T12:00:00Z', { currency: 'EUR' });
    const before = await reader.read(ctx, bounds);
    expect(before.blockers).toContain('CURRENCY_MISMATCH');
    await add('2026-10-02T12:01:00Z', { order: first.order });
    await add('2026-10-02T12:02:00Z', { created: '2026-10-03T00:00:00Z' });
    const after = await reader.read(ctx, bounds);
    expect(after.blockers).toContain('DUPLICATE_COMPLETION');
    expect(after.blockers).toContain('INVALID_COMPLETION');
    expect(after.sourceDigest).not.toBe(before.sourceDigest);
    await admin.query(`UPDATE business_operations.order_events SET occurred_at='2026-10-02T12:03:00Z' WHERE id=$1`, [first.event]);
    expect((await reader.read(ctx, bounds)).sourceDigest).not.toBe(after.sourceDigest);
  });

  it('enforces tenant, workspace, and business scope', async () => {
    const foreignBusiness = randomUUID();
    await admin.query(`INSERT INTO platform.businesses (id,tenant_id,workspace_id,legal_name,business_code,status) VALUES ($1,$2,$3,'M2 foreign',$4,'active')`, [foreignBusiness, ctx.tenantId, ctx.workspaceId, `m2-${foreignBusiness}`]);
    await add('2026-10-02T10:00:00Z', { business: foreignBusiness });
    const own = await reader.read(ctx, bounds);
    expect(own.windowCount).toBe(4);
    for (const foreign of [{ ...ctx, tenantId: randomUUID() }, { ...ctx, workspaceId: randomUUID() }]) {
      const review = await reader.read(foreign, bounds);
      expect(review).toMatchObject({ authoritative: false, baselineCount: 0, windowCount: 0 });
    }
    expect((await reader.read(ctx, { ...bounds, businessId: foreignBusiness })).windowCount).toBe(1);
  });

  it('refuses an incomplete window', async () => {
    const review = await reader.read(ctx, { ...bounds,
      executionAt: '2099-10-02T00:00:00.000Z', baselineOpenedAt: '2099-10-01T00:00:00.000Z',
      baselineClosedAt: '2099-10-02T00:00:00.000Z', windowOpenedAt: '2099-10-02T00:00:00.000Z',
      windowClosedAt: '2099-10-03T00:00:00.000Z' });
    expect(review.authoritative).toBe(false);
    expect(review.blockers).toContain('WINDOW_OPEN');
  });
});
