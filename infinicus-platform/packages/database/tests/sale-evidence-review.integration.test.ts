import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { closePool, createPool, type TenantContext } from '../src/client.js';
import { SaleEvidenceReviewRepository, storedAmountToMinor } from '../src/repositories/bo/SaleEvidenceReviewRepository.js';

const run = !!process.env.DATABASE_URL && !!process.env.ADMIN_DATABASE_URL;

describe('exact stored money conversion', () => {
  it('uses integer minor units and rejects fractional minor units or unknown currencies', () => {
    expect(storedAmountToMinor('12.3400', 'USD')).toBe(1234n);
    expect(storedAmountToMinor('12.0000', 'JPY')).toBe(12n);
    expect(storedAmountToMinor('1.2340', 'KWD')).toBe(1234n);
    expect(storedAmountToMinor('12.3401', 'USD')).toBeNull();
    expect(storedAmountToMinor('1.00', 'ZZZ')).toBeNull();
  });
});

describe.runIf(run)('read-only BO sale evidence inspection on PostgreSQL', () => {
  const reader = new SaleEvidenceReviewRepository();
  let admin: Pool; let ctx: TenantContext; let businessId: string; let orderId: string; let invoiceId: string; let customerId: string;
  beforeAll(async () => {
    createPool({ connectionString: process.env.DATABASE_URL! });
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL! });
    const tenantId = randomUUID(); const workspaceId = randomUUID(); businessId = randomUUID();
    orderId = randomUUID(); invoiceId = randomUUID(); customerId = randomUUID();
    ctx = { tenantId, workspaceId, userId: randomUUID() };
    await admin.query(`INSERT INTO tenancy.tenants (id,name,slug,status,plan_code) VALUES ($1,'M1 test',$2,'active','test')`, [tenantId, `m1-${tenantId}`]);
    await admin.query(`INSERT INTO tenancy.workspaces (id,tenant_id,name,slug,status) VALUES ($1,$2,'M1 test',$3,'active')`, [workspaceId, tenantId, `m1-${workspaceId}`]);
    await admin.query(`INSERT INTO platform.businesses (id,tenant_id,workspace_id,legal_name,business_code,status) VALUES ($1,$2,$3,'M1 test',$4,'active')`, [businessId, tenantId, workspaceId, `m1-${businessId}`]);
    await admin.query(`INSERT INTO platform.customers (id,tenant_id,workspace_id,business_id,display_name) VALUES ($1,$2,$3,$4,'M1 customer')`, [customerId, tenantId, workspaceId, businessId]);
    await admin.query(`INSERT INTO platform.orders (id,tenant_id,workspace_id,business_id,customer_id,order_number,order_date,currency_code,total_amount,operational_status,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,'2026-10-01','USD',100.0000,'completed','2026-10-01T08:00:00Z')`,
    [orderId, tenantId, workspaceId, businessId, customerId, `m1-${orderId}`]);
    await admin.query(`INSERT INTO platform.invoices (id,tenant_id,workspace_id,business_id,customer_id,order_id,invoice_number,issue_date,due_date,currency_code)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'2026-10-01','2026-10-31','USD')`,
    [invoiceId, tenantId, workspaceId, businessId, customerId, orderId, `m1-${invoiceId}`]);
  });
  afterAll(async () => { await admin?.end(); await closePool(); });
  const read = () => reader.read(ctx, businessId, orderId);
  const credit = (amount: string, currency = 'USD', status = 'applied') => admin.query(`INSERT INTO business_operations.credit_notes
    (tenant_id,workspace_id,business_id,customer_id,invoice_id,credit_note_number,currency_code,amount,credit_note_status,reason)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'synthetic test') RETURNING id`,
    [ctx.tenantId, ctx.workspaceId, businessId, customerId, invoiceId, `m1-${randomUUID()}`, currency, amount, status]);

  it('distinguishes order creation from completion and detects duplicate lifecycle events', async () => {
    expect((await read()).blockers).toContain('COMPLETION_EVENT_MISSING');
    const event = () => admin.query(`INSERT INTO business_operations.order_events
      (tenant_id,workspace_id,business_id,order_id,event_type,previous_status,new_status,occurred_at)
      VALUES ($1,$2,$3,$4,'completed','planned','completed','2026-10-01T09:00:00Z')`,
    [ctx.tenantId, ctx.workspaceId, businessId, orderId]);
    await event();
    expect(await read()).toMatchObject({ authoritative: false, completionAt: '2026-10-01T09:00:00.000Z', saleMinor: '10000' });
    await expect(event()).rejects.toThrow();
    expect((await read()).blockers).not.toContain('DUPLICATE_COMPLETION');
  });

  it('shows linked partial, full, cancelled, and mismatched-currency credits without certifying refunds', async () => {
    const first = (await credit('20.0000')).rows[0].id;
    let review = await read();
    expect(review.linkedCredits).toContainEqual({ id: first, status: 'applied', amountMinor: '2000' });
    expect(review.blockers).toContain('REFUND_APPLICATION_TIME_MISSING');
    await credit('80.0000');
    review = await read();
    expect(review.linkedCredits.filter((c) => c.status === 'applied').map((c) => c.amountMinor).sort()).toEqual(['2000', '8000']);
    await credit('5.0000', 'USD', 'cancelled');
    await credit('1.0000', 'EUR');
    review = await read();
    expect(review.blockers).toContain('CREDIT_CANCELLED');
    expect(review.blockers).toContain('CURRENCY_MISMATCH');
  });

  it('does not silently infer an unlinked credit or accept a cross-business invoice as order evidence', async () => {
    const before = await read();
    await admin.query(`INSERT INTO business_operations.credit_notes
      (tenant_id,workspace_id,business_id,customer_id,credit_note_number,currency_code,amount,credit_note_status,reason)
      VALUES ($1,$2,$3,$4,$5,'USD',1.0000,'applied','synthetic test')`,
    [ctx.tenantId, ctx.workspaceId, businessId, customerId, `m1-${randomUUID()}`]);
    expect((await read()).linkedCredits).toHaveLength(before.linkedCredits.length);
    expect((await read()).blockers).toContain('UNLINKED_REFUNDS_UNDETECTABLE');
    const foreignBusiness = randomUUID();
    await admin.query(`INSERT INTO platform.businesses (id,tenant_id,workspace_id,legal_name,business_code,status)
      VALUES ($1,$2,$3,'M1 foreign',$4,'active')`, [foreignBusiness, ctx.tenantId, ctx.workspaceId, `m1-${foreignBusiness}`]);
    const foreignInvoice = randomUUID();
    await admin.query(`INSERT INTO platform.invoices
      (id,tenant_id,workspace_id,business_id,order_id,invoice_number,issue_date,due_date,currency_code)
      VALUES ($1,$2,$3,$4,$5,$6,'2026-10-01','2026-10-31','USD')`,
    [foreignInvoice, ctx.tenantId, ctx.workspaceId, foreignBusiness, orderId, `m1-${foreignInvoice}`]);
    expect((await read()).linkedCredits).toHaveLength(before.linkedCredits.length);
  });

  it('refuses invalid completion timestamp ordering', async () => {
    const laterOrder = randomUUID();
    await admin.query(`INSERT INTO platform.orders
      (id,tenant_id,workspace_id,business_id,order_number,order_date,currency_code,total_amount,operational_status,created_at)
      VALUES ($1,$2,$3,$4,$5,'2026-10-02','USD',0,'completed','2026-10-02T10:00:00Z')`,
    [laterOrder, ctx.tenantId, ctx.workspaceId, businessId, `m1-${laterOrder}`]);
    await admin.query(`INSERT INTO business_operations.order_events
      (tenant_id,workspace_id,business_id,order_id,event_type,previous_status,new_status,occurred_at)
      VALUES ($1,$2,$3,$4,'completed','planned','completed','2026-10-02T09:00:00Z')`,
    [ctx.tenantId, ctx.workspaceId, businessId, laterOrder]);
    expect((await reader.read(ctx, businessId, laterOrder)).blockers).toContain('INVALID_COMPLETION_TIME');
  });

  it('changes its digest after a source correction, remains read-only, and hides foreign scope', async () => {
    const before = await read();
    await admin.query(`UPDATE business_operations.credit_notes SET amount=21.0000 WHERE id=$1`, [before.linkedCredits[0].id]);
    const after = await read();
    expect(after.sourceDigest).not.toBe(before.sourceDigest);
    expect(after.blockers).toContain('SOURCE_HISTORY_MUTABLE');
    await expect(admin.query(`UPDATE business_operations.order_events SET occurred_at='2026-10-01T09:01:00Z'
      WHERE order_id=$1 AND event_type='completed'`, [orderId])).rejects.toThrow();
    expect((await read()).sourceDigest).toBe(after.sourceDigest);
    const otherTenantReview = await reader.read({ ...ctx, tenantId: randomUUID() }, businessId, orderId);
    expect(otherTenantReview.blockers).toContain('ORDER_NOT_FOUND');
    // A review digest must bind the complete scope even when neither caller can see an order.
    const otherWorkspaceReview = await reader.read({ ...ctx, workspaceId: randomUUID() }, businessId, orderId);
    expect(otherWorkspaceReview.blockers).toContain('ORDER_NOT_FOUND');
    expect(otherTenantReview.sourceDigest).not.toBe(otherWorkspaceReview.sourceDigest);
    expect(otherTenantReview.sourceDigest).not.toBe((await read()).sourceDigest);
    expect((await reader.read({ ...ctx, workspaceId: randomUUID() }, businessId, orderId)).blockers).toContain('ORDER_NOT_FOUND');
    expect((await reader.read(ctx, randomUUID(), orderId)).blockers).toContain('ORDER_NOT_FOUND');
  });
});
