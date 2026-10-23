/**
 * NEW-BDT-01: BusinessPerformanceTwinService against live PostgreSQL under the application role (RLS enforced). The BI readers are stubs returning real BI
 * report objects, so this proves the twin side: snapshot construction through the existing lifecycle, provenance evidence, determinism, per-currency
 * representation, missing/insufficient/inconsistent handling (nothing persisted), tenant and business isolation, supersession, integrity re-verification
 * (tampering is detected) and that nothing operational or BI is written. Requires DATABASE_URL (application role) and ADMIN_DATABASE_URL (fixtures).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createPool, closePool, type TenantContext } from '@infinicus/database';
import { BO_FINANCIAL_FACTS_CONTRACT, type FinancialFacts } from '@infinicus/handoff-contracts';
import { buildFinancialReport } from '../src/financial/financialReport.js';
import type { FinancialReportOutcome } from '../src/financial/FinancialIntelligenceService.js';
import type { SalesReportResult } from '../src/SalesReportService.js';
import { BusinessPerformanceTwinService, TWIN_EVIDENCE_BI_FINANCIAL_REPORT, type FinancialReportReader, type SalesReportReader } from '../src/performance/BusinessPerformanceTwinService.js';
import { addBusiness, createWorld, type World } from '../../database/tests/helpers/financialFixtures.js';

const run = !!process.env.DATABASE_URL && !!process.env.ADMIN_DATABASE_URL;
const PERIOD = { from: '2026-10-01', to: '2026-10-31' };
const ctxOf = (w: World): TenantContext => ({ tenantId: w.tenantId, workspaceId: w.workspaceId, userId: '00000000-0000-4000-8000-000000000001' });

function readers(w: { businessId: string }, o: { fin?: () => FinancialReportOutcome; sales?: () => SalesReportResult; usdCents?: number } = {}) {
  const calls: { financial: unknown[]; sales: unknown[] } = { financial: [], sales: [] };
  const usd = o.usdCents ?? 15000;
  const facts = (): FinancialFacts => ({
    contract: BO_FINANCIAL_FACTS_CONTRACT, businessId: w.businessId, range: PERIOD,
    completedOrders: [{ date: '2026-10-05', currency: 'USD', amount: '150.0000', count: 2 }, { date: '2026-10-20', currency: 'KWD', amount: '31.5000', count: 1 }],
    ordersByStatus: [], expenseItems: [], expenseItemsExcludedForCurrency: 0, goodsReceived: [], goodsReceivedWithoutCost: 0, costOfSales: [], indicators: [],
  });
  const financial: FinancialReportReader = {
    async report(_c, r) { calls.financial.push(r); return o.fin ? o.fin() : { outcome: 'REPORT', report: buildFinancialReport({ current: facts(), previous: null, granularity: 'month' }) }; },
  };
  const sales: SalesReportReader = {
    async report(_c, r) {
      calls.sales.push(r);
      return o.sales ? o.sales() : {
        outcome: 'REPORT',
        report: {
          businessId: w.businessId, period: { ...PERIOD, days: 31, basis: 'order_date', inclusive: true },
          source: { layer: 'BO', definition: 'completed orders; net = order total; gross = non-discount lines; discounts = discount lines' },
          currencies: [
            { currency: { code: 'KWD', minorUnitExponent: 3 }, totals: { completedOrders: 1, voidedOrders: 0, openOrders: 0, otherStatusOrders: 0, grossMinor: 31500, discountMinor: 0, netMinor: 31500, averageOrderNetMinor: 31500, reconciles: true }, daily: [] },
            { currency: { code: 'USD', minorUnitExponent: 2 }, totals: { completedOrders: 2, voidedOrders: 0, openOrders: 0, otherStatusOrders: 0, grossMinor: usd, discountMinor: 0, netMinor: usd, averageOrderNetMinor: usd / 2, reconciles: true }, daily: [] },
          ],
        },
      };
    },
  };
  return { financial, sales, calls };
}

describe.runIf(run)('BusinessPerformanceTwinService (live PostgreSQL, application role)', () => {
  let admin: Pool;
  beforeAll(() => { createPool({ connectionString: process.env.DATABASE_URL! }); admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL }); });
  afterAll(async () => { await admin?.end(); await closePool(); });
  const world = async () => createWorld(admin, 'Bdt');
  const counts = async (w: World) => Object.fromEntries(await Promise.all(['digital_twin_definitions', 'digital_twin_instances', 'digital_twin_snapshots'].map(async (t) =>
    [t, Number((await admin.query(`SELECT count(*) n FROM business_digital_twin.${t} WHERE business_id = $1`, [w.businessId])).rows[0].n)])));

  it('publishes through the existing lifecycle: definition, instance, a PUBLISHED snapshot, the figures per currency, and provenance evidence', async () => {
    const w = await world(); const r = readers(w);
    const svc = new BusinessPerformanceTwinService({ ...r, now: () => new Date('2026-11-02T10:00:00.000Z') });
    const out = await svc.publish(ctxOf(w), { businessId: w.businessId, ...PERIOD });
    if (out.outcome !== 'PUBLISHED') throw new Error(JSON.stringify(out));
    expect(out.effectiveAt).toBe('2026-11-02T10:00:00.000Z');
    expect(out.state.evidence.financial).toMatchObject({ status: 'PROVIDED' });
    expect(out.state.evidence.crossCheck).toEqual({ performed: true, revenue: [{ currency: 'KWD', state: 'AGREE' }, { currency: 'USD', state: 'AGREE' }] });
    expect(r.calls.financial).toEqual([{ businessId: w.businessId, ...PERIOD, granularity: 'month', compare: 'none' }]);   // BI is asked for the SAME period, once each
    expect(r.calls.sales).toEqual([{ businessId: w.businessId, ...PERIOD }]);
    expect(await counts(w)).toEqual({ digital_twin_definitions: 1, digital_twin_instances: 1, digital_twin_snapshots: 1 });
    const snap = await admin.query(`SELECT status FROM business_digital_twin.digital_twin_snapshots WHERE id = $1`, [out.snapshotId]);
    expect(snap.rows[0].status).toBe('published');
    const ev = await admin.query(`SELECT evidence_type, evidence_reference FROM business_digital_twin.digital_twin_snapshot_evidence WHERE snapshot_version_id = $1 ORDER BY evidence_type`, [out.snapshotVersionId]);
    expect(ev.rows.map((x) => x.evidence_type)).toEqual(['bi_financial_report', 'bi_performance_evidence', 'bi_sales_report']);
    expect(ev.rows.find((x) => x.evidence_type === TWIN_EVIDENCE_BI_FINANCIAL_REPORT).evidence_reference).toMatchObject({ contract: 'bi-financial-report/1', period: PERIOD });
    expect(ev.rows.find((x) => x.evidence_type === 'bi_performance_evidence').evidence_reference.evidenceDigest).toBe(out.evidenceDigest);
  });

  it('getLatest returns the stored state with its integrity verified; a second publish reuses the instance, supersedes the first and is deterministic', async () => {
    const w = await world(); const r = readers(w);
    let t = new Date('2026-11-02T10:00:00.000Z');
    const svc = new BusinessPerformanceTwinService({ ...r, now: () => t });
    const first = await svc.publish(ctxOf(w), { businessId: w.businessId, ...PERIOD });
    t = new Date('2026-11-02T10:00:05.000Z');
    const second = await svc.publish(ctxOf(w), { businessId: w.businessId, ...PERIOD });
    if (first.outcome !== 'PUBLISHED' || second.outcome !== 'PUBLISHED') throw new Error('expected published');
    expect(second.evidenceDigest).toBe(first.evidenceDigest);                         // same BI evidence, same digest
    expect(second.instanceId).toBe(first.instanceId);
    expect(await counts(w)).toEqual({ digital_twin_definitions: 1, digital_twin_instances: 1, digital_twin_snapshots: 2 });
    const latest = await svc.getLatest(ctxOf(w), w.businessId);
    expect(latest).toMatchObject({ snapshotId: second.snapshotId, integrity: { valid: true, reasons: [] } });
    expect(await svc.assessFreshness(ctxOf(w), w.businessId, first.snapshotId)).toEqual({ usable: true, newerPublishedExists: true });
    expect(await svc.assessFreshness(ctxOf(w), w.businessId, second.snapshotId)).toEqual({ usable: true, newerPublishedExists: false });
  });

  it('a stored state that describes another business is never returned (defence in depth behind the per-business instance)', async () => {
    const w = await world(); const sib = await addBusiness(admin, w);
    const svc = new BusinessPerformanceTwinService({ ...readers(w) });
    const out = await svc.publish(ctxOf(w), { businessId: w.businessId, ...PERIOD });
    if (out.outcome !== 'PUBLISHED') throw new Error('x');
    const row = await admin.query(`SELECT id, value_json FROM business_digital_twin.digital_twin_snapshot_values WHERE snapshot_version_id = $1`, [out.snapshotVersionId]);
    const doctored = row.rows[0].value_json; doctored.evidence.businessId = sib.businessId;
    await admin.query(`ALTER TABLE business_digital_twin.digital_twin_snapshot_values DISABLE TRIGGER USER`);
    try { await admin.query(`UPDATE business_digital_twin.digital_twin_snapshot_values SET value_json = $2 WHERE id = $1`, [row.rows[0].id, doctored]); }
    finally { await admin.query(`ALTER TABLE business_digital_twin.digital_twin_snapshot_values ENABLE TRIGGER USER`); }
    expect(await svc.getLatest(ctxOf(w), w.businessId)).toBeNull();
  });

  it('the newest published state wins, selected by period: a later publish of the same period supersedes the earlier', async () => {
    const w = await world(); const r = readers(w);
    let ms = 0;
    const svc = new BusinessPerformanceTwinService({ ...r, now: () => new Date(Date.parse('2026-11-02T10:00:00.000Z') + (ms += 7)) });
    await svc.publish(ctxOf(w), { businessId: w.businessId, ...PERIOD });
    const later = await svc.publish(ctxOf(w), { businessId: w.businessId, ...PERIOD });
    if (later.outcome !== 'PUBLISHED') throw new Error('x');
    expect((await svc.getLatest(ctxOf(w), w.businessId))!.snapshotId).toBe(later.snapshotId);
    expect((await svc.getLatest(ctxOf(w), w.businessId, PERIOD))!.snapshotId).toBe(later.snapshotId);
  });

  it('a different reporting period is a different state: getLatest can select by period, and returns null for a period never published', async () => {
    const w = await world();
    const svc = new BusinessPerformanceTwinService({ ...readers(w) });
    await svc.publish(ctxOf(w), { businessId: w.businessId, ...PERIOD });
    expect(await svc.getLatest(ctxOf(w), w.businessId, PERIOD)).not.toBeNull();
    expect(await svc.getLatest(ctxOf(w), w.businessId, { from: '2026-09-01', to: '2026-09-30' })).toBeNull();
    expect(await svc.getLatest(ctxOf(await world()), w.businessId)).toBeNull();     // another tenant sees nothing
  });

  it('detects tampering with the stored state: the integrity re-check fails when a stored figure is changed behind the twin\'s back', async () => {
    const w = await world();
    const svc = new BusinessPerformanceTwinService({ ...readers(w) });
    const out = await svc.publish(ctxOf(w), { businessId: w.businessId, ...PERIOD });
    if (out.outcome !== 'PUBLISHED') throw new Error('x');
    const row = await admin.query(`SELECT id, value_json FROM business_digital_twin.digital_twin_snapshot_values WHERE snapshot_version_id = $1`, [out.snapshotVersionId]);
    const doctored = row.rows[0].value_json; doctored.evidence.sales.currencies[1].netMinor = 99999999;
    await admin.query(`ALTER TABLE business_digital_twin.digital_twin_snapshot_values DISABLE TRIGGER USER`);
    try { await admin.query(`UPDATE business_digital_twin.digital_twin_snapshot_values SET value_json = $2 WHERE id = $1`, [row.rows[0].id, doctored]); }
    finally { await admin.query(`ALTER TABLE business_digital_twin.digital_twin_snapshot_values ENABLE TRIGGER USER`); }
    const latest = await svc.getLatest(ctxOf(w), w.businessId);
    expect(latest!.integrity).toEqual({ valid: false, reasons: ['evidence_digest_mismatch'] });
  });

  it('missing, insufficient and inconsistent BI evidence publish NOTHING (no definition, instance or snapshot is created)', async () => {
    const w = await world();
    const down = { fin: (): FinancialReportOutcome => ({ outcome: 'UNAVAILABLE', code: 'FACTS_UNAVAILABLE', detail: 'down' }), sales: (): SalesReportResult => ({ outcome: 'NOT_AVAILABLE', code: 'UNSUPPORTED_CURRENCY', detail: 'xyz' }) };
    expect(await new BusinessPerformanceTwinService({ ...readers(w, down) }).publish(ctxOf(w), { businessId: w.businessId, ...PERIOD })).toMatchObject({ outcome: 'NOT_PUBLISHED', code: 'BI_EVIDENCE_MISSING' });
    const empty = {
      fin: (): FinancialReportOutcome => ({ outcome: 'REPORT', report: buildFinancialReport({ current: { contract: BO_FINANCIAL_FACTS_CONTRACT, businessId: w.businessId, range: PERIOD, completedOrders: [], ordersByStatus: [], expenseItems: [], expenseItemsExcludedForCurrency: 0, goodsReceived: [], goodsReceivedWithoutCost: 0, costOfSales: [], indicators: [] }, previous: null, granularity: 'month' }) }),
      sales: (): SalesReportResult => ({ outcome: 'REPORT', report: { businessId: w.businessId, period: { ...PERIOD, days: 31, basis: 'order_date', inclusive: true }, source: { layer: 'BO', definition: 'x' as never }, currencies: [] } }),
    };
    expect(await new BusinessPerformanceTwinService({ ...readers(w, empty) }).publish(ctxOf(w), { businessId: w.businessId, ...PERIOD })).toMatchObject({ outcome: 'NOT_PUBLISHED', code: 'BI_EVIDENCE_INSUFFICIENT' });
    expect(await new BusinessPerformanceTwinService({ ...readers(w, { usdCents: 15001 }) }).publish(ctxOf(w), { businessId: w.businessId, ...PERIOD })).toMatchObject({ outcome: 'NOT_PUBLISHED', code: 'BI_EVIDENCE_INCONSISTENT' });
    expect(await counts(w)).toEqual({ digital_twin_definitions: 0, digital_twin_instances: 0, digital_twin_snapshots: 0 });
  });

  it('one unavailable domain publishes the other with the missing one explicit (no zeros), and records evidence only for the provided domain', async () => {
    const w = await world();
    const svc = new BusinessPerformanceTwinService({ ...readers(w, { fin: () => ({ outcome: 'UNAVAILABLE', code: 'FACTS_UNAVAILABLE', detail: 'down' }) }) });
    const out = await svc.publish(ctxOf(w), { businessId: w.businessId, ...PERIOD });
    if (out.outcome !== 'PUBLISHED') throw new Error(JSON.stringify(out));
    expect(out.state.evidence.financial).toEqual({ status: 'MISSING', code: 'FACTS_UNAVAILABLE', detail: 'down' });
    expect(out.state.evidence.crossCheck).toEqual({ performed: false, revenue: [] });
    const ev = await admin.query(`SELECT evidence_type FROM business_digital_twin.digital_twin_snapshot_evidence WHERE snapshot_version_id = $1 ORDER BY 1`, [out.snapshotVersionId]);
    expect(ev.rows.map((x) => x.evidence_type)).toEqual(['bi_performance_evidence', 'bi_sales_report']);
  });

  it('invalid requests are refused before BI is asked: bad business id, impossible dates, reversed or over-long period', async () => {
    const w = await world(); const r = readers(w);
    const svc = new BusinessPerformanceTwinService({ ...r });
    for (const req of [
      { businessId: 'nope', ...PERIOD }, { businessId: w.businessId, from: '2026-02-30', to: '2026-03-10' }, { businessId: w.businessId, from: '2026-13-01', to: '2026-13-02' },
      { businessId: w.businessId, from: '2026-11-01', to: '2026-10-01' }, { businessId: w.businessId, from: '2025-01-01', to: '2026-12-31' },
    ]) expect(await svc.publish(ctxOf(w), req), JSON.stringify(req)).toMatchObject({ outcome: 'NOT_PUBLISHED', code: 'INVALID_REQUEST' });
    expect(r.calls).toEqual({ financial: [], sales: [] });
    expect(await counts(w)).toEqual({ digital_twin_definitions: 0, digital_twin_instances: 0, digital_twin_snapshots: 0 });
  });

  it('isolates businesses and tenants: a sibling business has its own twin; another tenant cannot read this business\'s state', async () => {
    const w = await world(); const sib = await addBusiness(admin, w); const other = await world();
    const a = new BusinessPerformanceTwinService({ ...readers(w) });
    await a.publish(ctxOf(w), { businessId: w.businessId, ...PERIOD });
    expect(await a.getLatest(ctxOf(w), sib.businessId)).toBeNull();
    const b = new BusinessPerformanceTwinService({ ...readers(sib) });
    const out = await b.publish(ctxOf(sib), { businessId: sib.businessId, ...PERIOD });
    if (out.outcome !== 'PUBLISHED') throw new Error('x');
    expect(out.state.evidence.businessId).toBe(sib.businessId);
    expect((await a.getLatest(ctxOf(w), w.businessId))!.state.evidence.businessId).toBe(w.businessId);
    expect(await a.getLatest(ctxOf(other), w.businessId)).toBeNull();
    expect(await a.getLatest(ctxOf(other), sib.businessId)).toBeNull();
    // evidence that describes another business is refused at the boundary even when the reader hands it over
    const mixed = new BusinessPerformanceTwinService({ ...readers(sib) });
    expect(await mixed.publish(ctxOf(w), { businessId: w.businessId, ...PERIOD })).toMatchObject({ outcome: 'NOT_PUBLISHED', code: 'BI_EVIDENCE_INCONSISTENT' });
  });

  it('writes only Digital Twin tables: no operational, BI or order row changes', async () => {
    const w = await world();
    const tables = ['platform.orders', 'business_operations.expense_items', 'business_operations.inventory_movements', 'business_intelligence.insight_packages', 'business_intelligence.metric_calculated_values'];
    const snap = async () => Promise.all(tables.map(async (t) => Number((await admin.query(`SELECT count(*)::int n FROM ${t} WHERE tenant_id = $1`, [w.tenantId])).rows[0].n)));
    const before = await snap();
    const svc = new BusinessPerformanceTwinService({ ...readers(w) });
    await svc.publish(ctxOf(w), { businessId: w.businessId, ...PERIOD });
    await svc.getLatest(ctxOf(w), w.businessId);
    expect(await snap()).toEqual(before);
  });
});
