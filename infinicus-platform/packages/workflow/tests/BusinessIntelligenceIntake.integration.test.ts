/**
 * BI-1: governed BO -> BI intake against live PostgreSQL under the application role (RLS enforced). Fixtures reproduce exactly what Business Operations writes
 * when it dispatches a publication package (bo_publication_packages + a 'dispatch' bo_handoff_records row, see OperationalPublicationService), and the handoff has
 * the shape BO builds. Proves: the intake is persisted atomically with its provenance, replays and concurrent deliveries are idempotent, every claim is checked
 * against BO's own record (rejections are recorded with reasons and leave no half-ingested data), an unpublished or foreign package is refused without a
 * trace, tenant / workspace / business isolation and RLS hold, and BO's tables are never changed. Requires DATABASE_URL and ADMIN_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createPool, closePool, withTenantTransaction, BiConflictError, type TenantContext } from '@infinicus/database';
import { BO_TO_BI_CONTRACT_VERSION, validateBOToBIHandoff, type BOToBIHandoff } from '@infinicus/handoff-contracts';
import { BI_INTAKE_DOMAINS, BiIntakeRejectedError, BusinessIntelligenceIntakeService } from '../src/BusinessIntelligenceIntakeService.js';
import { addBusiness, createWorld as baseCreateWorld, type World } from '../../database/tests/helpers/financialFixtures.js';

const run = !!process.env.DATABASE_URL && !!process.env.ADMIN_DATABASE_URL;
/** The user of each fixture world (created_by references identity.users; in production the caller's context carries a real user). */
const users = new Map<string, string>();
const ctxOf = (w: World): TenantContext => ({ tenantId: w.tenantId, workspaceId: w.workspaceId, userId: users.get(w.tenantId) ?? randomUUID() });
const PERIOD = { start: '2026-10-01T00:00:00.000Z', end: '2026-11-01T00:00:00.000Z' };

describe.runIf(run)('BusinessIntelligenceIntakeService (live PostgreSQL, application role)', () => {
  let admin: Pool;
  const svc = new BusinessIntelligenceIntakeService();
  let seq = 0;
  const createWorld = async (pool: Pool, label: string): Promise<World> => {
    const w = await baseCreateWorld(pool, label); const userId = randomUUID();
    await pool.query(`INSERT INTO identity.users (id, email, status) VALUES ($1,$2,'active')`, [userId, `${userId}@bi-intake.example.test`]);
    users.set(w.tenantId, userId); return w;
  };
  beforeAll(() => { createPool({ connectionString: process.env.DATABASE_URL! }); admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL }); });
  afterAll(async () => { await admin?.end(); await closePool(); });

  interface Published { packageId: string; handoffId: string; correlationId: string; version: number; handoff: BOToBIHandoff }
  /** What BO does on dispatch: a package row, a dispatch record, and the handoff built from them. */
  async function publish(w: World, o: { targetBlock?: string; status?: string; targetLayer?: string; recordCount?: number; payloadReference?: Record<string, unknown>; dispatch?: boolean } = {}): Promise<Published> {
    const packageId = randomUUID(); const handoffId = randomUUID(); const correlationId = randomUUID();
    const targetBlock = o.targetBlock ?? 'BI-16'; const recordCount = o.recordCount ?? 42; const payloadReference = o.payloadReference ?? { table: 'inventory_movements', rows: 42 };
    const packageCode = `pkg-${Date.now()}-${++seq}`;
    await admin.query(
      `INSERT INTO business_operations.bo_publication_packages
         (id, tenant_id, workspace_id, business_id, package_code, target_layer, target_block, period_start, period_end, record_count, payload_reference, package_status, correlation_id, version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,2)`,
      [packageId, w.tenantId, w.workspaceId, w.businessId, packageCode, o.targetLayer ?? 'business_intelligence', targetBlock, PERIOD.start, PERIOD.end, recordCount, JSON.stringify(payloadReference), o.status ?? 'dispatched', correlationId]);
    if (o.dispatch !== false) {
      await admin.query(
        `INSERT INTO business_operations.bo_handoff_records
           (id, tenant_id, workspace_id, business_id, publication_id, handoff_type, source_layer, target_layer, target_block, record_count, payload, occurred_at, correlation_id)
         VALUES ($1,$2,$3,$4,$5,'dispatch','business_operations','business_intelligence',$6,$7,$8,now(),$9)`,
        [handoffId, w.tenantId, w.workspaceId, w.businessId, packageId, targetBlock, recordCount, JSON.stringify({ packageCode, payloadReference, schemaVersion: '1.0' }), correlationId]);
    }
    const handoff: BOToBIHandoff = {
      handoffId, sourceLayer: 'BO', sourceBlock: 'BO-RUNTIME', targetLayer: 'BI', targetBlock, correlationId, lineage: [], status: 'ready', createdAt: new Date().toISOString(),
      payload: {
        contractVersion: BO_TO_BI_CONTRACT_VERSION, tenantId: w.tenantId, workspaceId: w.workspaceId, businessId: w.businessId, boPublicationPackageId: packageId,
        packageStatus: 'dispatched', targetBlock, periodStart: PERIOD.start, periodEnd: PERIOD.end, recordCount, source: { packageCode, payloadReference }, schemaVersion: '1.0',
        idempotencyKey: `bo-to-bi:${packageId}:2`,
      },
    };
    return { packageId, handoffId, correlationId, version: 2, handoff };
  }
  const q = async (sql: string, args: unknown[]) => (await admin.query(sql, args)).rows;
  const biCounts = async (w: World) => Object.fromEntries(await Promise.all(['intelligence_intake_packages', 'intelligence_intake_package_versions', 'intelligence_source_references', 'intelligence_domain_inputs', 'intelligence_processing_status_history'].map(async (t) =>
    [t, Number((await q(`SELECT count(*) n FROM business_intelligence.${t} WHERE business_id = $1`, [w.businessId]))[0].n)])));
  const boFingerprint = async (w: World) => JSON.stringify([
    await q(`SELECT * FROM business_operations.bo_publication_packages WHERE business_id = $1 ORDER BY id`, [w.businessId]),
    await q(`SELECT * FROM business_operations.bo_handoff_records WHERE business_id = $1 ORDER BY id`, [w.businessId]),
  ]);

  it('the handoffs these tests build are valid under the shared BO -> BI contract (the shape BO produces)', async () => {
    const w = await createWorld(admin, 'Bi1'); const p = await publish(w);
    expect(validateBOToBIHandoff(p.handoff)).toEqual({ valid: true, reasons: [] });
  });

  it('ingests a published package: the intake is persisted atomically with status history, version, source reference to the BO dispatch record and a pending domain input', async () => {
    const w = await createWorld(admin, 'Bi1'); const p = await publish(w); const before = await boFingerprint(w);
    const out = await svc.ingest(ctxOf(w), p.handoff);
    expect(out).toMatchObject({ outcome: 'VALIDATED', domain: 'inventory_supply', versionNumber: 1, idempotentReplay: false });
    if (out.outcome !== 'VALIDATED') throw new Error('unreachable');

    const [pkg] = await q(`SELECT * FROM business_intelligence.intelligence_intake_packages WHERE id = $1`, [out.intakePackageId]);
    expect(pkg).toMatchObject({
      tenant_id: w.tenantId, workspace_id: w.workspaceId, business_id: w.businessId, bo_publication_package_id: p.packageId, domain: 'inventory_supply', status: 'validated',
      rejection_reason: null, schema_version: '1.0', idempotency_key: `bo-to-bi:${p.packageId}:2`, correlation_id: p.correlationId, causation_id: p.handoffId,
    });
    expect((await q(`SELECT from_status, to_status FROM business_intelligence.intelligence_processing_status_history WHERE intake_package_id = $1`, [out.intakePackageId]))
      .map((r) => `${r.from_status}>${r.to_status}`).sort()).toEqual(['null>received', 'received>validating', 'validating>validated']);
    const [version] = await q(`SELECT * FROM business_intelligence.intelligence_intake_package_versions WHERE intake_package_id = $1`, [out.intakePackageId]);
    expect(version).toMatchObject({ version_number: 1, record_count: 42, payload_reference: { table: 'inventory_movements', rows: 42 }, correlation_id: p.correlationId });
    const [ref] = await q(`SELECT * FROM business_intelligence.intelligence_source_references WHERE intake_package_id = $1`, [out.intakePackageId]);
    expect(ref).toMatchObject({ source_system: 'business_operations', bo_handoff_record_id: p.handoffId, tenant_id: w.tenantId });
    expect(ref.source_reference).toMatchObject({ boPublicationPackageId: p.packageId, handoffId: p.handoffId, contractVersion: BO_TO_BI_CONTRACT_VERSION, schemaVersion: '1.0' });
    const [input] = await q(`SELECT * FROM business_intelligence.intelligence_domain_inputs WHERE intake_package_id = $1`, [out.intakePackageId]);
    expect(input).toMatchObject({ domain: 'inventory_supply', status: 'pending' });
    expect(await boFingerprint(w)).toBe(before); // BI only ever reads: not one BO row changed
  });

  it('is idempotent: delivering the same handoff again returns the same intake and writes nothing', async () => {
    const w = await createWorld(admin, 'Bi1'); const p = await publish(w);
    const first = await svc.ingest(ctxOf(w), p.handoff);
    const counts = await biCounts(w);
    const again = await svc.ingest(ctxOf(w), p.handoff);
    expect(again).toMatchObject({ outcome: 'VALIDATED', idempotentReplay: true, intakePackageId: (first as { intakePackageId: string }).intakePackageId, versionNumber: 1 });
    expect(await biCounts(w)).toEqual(counts);
    expect(counts).toEqual({ intelligence_intake_packages: 1, intelligence_intake_package_versions: 1, intelligence_source_references: 1, intelligence_domain_inputs: 1, intelligence_processing_status_history: 3 });
  });

  it('concurrent deliveries of one package create exactly one intake', async () => {
    const w = await createWorld(admin, 'Bi1'); const p = await publish(w);
    const results = await Promise.all([1, 2, 3, 4].map(() => svc.ingest(ctxOf(w), p.handoff)));
    expect(new Set(results.map((r) => (r as { intakePackageId: string }).intakePackageId)).size).toBe(1);
    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect((await biCounts(w)).intelligence_intake_packages).toBe(1);
  });

  it('a different idempotency key for an already-ingested package is a conflict and changes nothing', async () => {
    const w = await createWorld(admin, 'Bi1'); const p = await publish(w);
    await svc.ingest(ctxOf(w), p.handoff); const counts = await biCounts(w);
    const other = { ...p.handoff, payload: { ...p.handoff.payload, idempotencyKey: `bo-to-bi:${p.packageId}:3` } };
    await expect(svc.ingest(ctxOf(w), other)).rejects.toBeInstanceOf(BiConflictError);
    expect(await biCounts(w)).toEqual(counts);
  });

  it('every claim is checked against BO: a handoff that disagrees with BO is recorded as a rejected intake with its reasons and leaves no half-ingested data', async () => {
    const w = await createWorld(admin, 'Bi1'); const before = (p: Published) => p;
    const cases: Array<[string, (p: Published) => BOToBIHandoff, string]> = [
      ['record count', (p) => ({ ...p.handoff, payload: { ...p.handoff.payload, recordCount: 43 } }), 'claimed_record_count_differs_from_bo'],
      ['payload reference', (p) => ({ ...p.handoff, payload: { ...p.handoff.payload, source: { ...p.handoff.payload.source, payloadReference: { table: 'other', rows: 42 } } } }), 'claimed_payload_reference_differs_from_bo'],
      ['package code', (p) => ({ ...p.handoff, payload: { ...p.handoff.payload, source: { ...p.handoff.payload.source, packageCode: 'forged' } } }), 'claimed_package_code_differs_from_bo'],
      ['period start', (p) => ({ ...p.handoff, payload: { ...p.handoff.payload, periodStart: '2026-09-01T00:00:00.000Z' } }), 'claimed_period_start_differs_from_bo'],
      ['period end', (p) => ({ ...p.handoff, payload: { ...p.handoff.payload, periodEnd: '2026-12-01T00:00:00.000Z' } }), 'claimed_period_end_differs_from_bo'],
    ];
    for (const [name, mutate, reason] of cases) {
      const p = before(await publish(w)); const h = mutate(p);
      const out = await svc.ingest(ctxOf(w), h);
      expect(out, name).toMatchObject({ outcome: 'REJECTED', idempotentReplay: false });
      expect((out as { reasons: string[] }).reasons, name).toEqual([reason]);
      const id = (out as { intakePackageId: string }).intakePackageId;
      expect((await q(`SELECT status, rejection_reason FROM business_intelligence.intelligence_intake_packages WHERE id = $1`, [id]))[0], name).toEqual({ status: 'rejected', rejection_reason: reason });
      for (const t of ['intelligence_intake_package_versions', 'intelligence_source_references', 'intelligence_domain_inputs']) {
        expect(await q(`SELECT 1 FROM business_intelligence.${t} WHERE intake_package_id = $1`, [id]), `${name}: ${t}`).toEqual([]);
      }
      const replay = await svc.ingest(ctxOf(w), h);
      expect(replay, name).toMatchObject({ outcome: 'REJECTED', idempotentReplay: true, intakePackageId: id, reasons: [reason] });
    }
  });

  it('an unpublished, wrongly addressed or never-dispatched BO package is rejected, however the handoff describes it', async () => {
    const w = await createWorld(admin, 'Bi1');
    const draft = await publish(w, { status: 'draft' });
    expect(await svc.ingest(ctxOf(w), draft.handoff)).toMatchObject({ outcome: 'REJECTED', reasons: ['bo_package_status_not_intakable'] });
    const wrongLayer = await publish(w, { targetLayer: 'business_digital_twin' });
    expect(await svc.ingest(ctxOf(w), wrongLayer.handoff)).toMatchObject({ outcome: 'REJECTED', reasons: ['bo_package_not_addressed_to_business_intelligence'] });
    const forged = await publish(w, { dispatch: false });   // BO never dispatched it: there is no dispatch record behind the handoff
    expect(await svc.ingest(ctxOf(w), forged.handoff)).toMatchObject({ outcome: 'REJECTED', reasons: ['bo_dispatch_record_not_found'] });
    const wrongDispatch = await publish(w);                 // a real dispatch record, but of ANOTHER package
    const other = await publish(w);
    const borrowed = { ...wrongDispatch.handoff, handoffId: other.handoffId };
    expect(await svc.ingest(ctxOf(w), borrowed)).toMatchObject({ outcome: 'REJECTED', reasons: ['bo_dispatch_record_not_found'] });
  });

  it('a package BO never published in this scope is refused without a trace: unknown id, another business, another tenant', async () => {
    const w = await createWorld(admin, 'Bi1'); const sibling = await addBusiness(admin, w); const foreign = await createWorld(admin, 'Bi1x');
    const counts = await Promise.all([w, sibling, foreign].map(biCounts));

    const missing = await publish(w);
    const ghost = { ...missing.handoff, payload: { ...missing.handoff.payload, boPublicationPackageId: randomUUID() } };
    ghost.payload.idempotencyKey = `bo-to-bi:${ghost.payload.boPublicationPackageId}:2`;
    expect(await svc.ingest(ctxOf(w), ghost).then(() => null, (e: unknown) => (e as BiIntakeRejectedError).reasons)).toEqual(['bo_publication_package_not_found_in_scope']);

    const mine = await publish(w);
    const asSibling = { ...mine.handoff, payload: { ...mine.handoff.payload, businessId: sibling.businessId } };   // the sibling business claims w's package
    expect(await svc.ingest(ctxOf(sibling), asSibling).then(() => null, (e: unknown) => (e as BiIntakeRejectedError).reasons)).toEqual(['bo_publication_package_not_found_in_scope']);

    const theirs = await publish(foreign);                                                                   // another tenant's package delivered by w
    expect(await svc.ingest(ctxOf(w), theirs.handoff).then(() => null, (e: unknown) => (e as BiIntakeRejectedError).reasons)).toEqual(['tenant_differs_from_caller', 'workspace_differs_from_caller']);
    const rebadged = { ...theirs.handoff, payload: { ...theirs.handoff.payload, tenantId: w.tenantId, workspaceId: w.workspaceId, businessId: w.businessId } };
    expect(await svc.ingest(ctxOf(w), rebadged).then(() => null, (e: unknown) => (e as BiIntakeRejectedError).reasons)).toEqual(['bo_publication_package_not_found_in_scope']);

    expect(await Promise.all([w, sibling, foreign].map(biCounts))).toEqual(counts);
  });

  it('row-level security: the intake is invisible to another tenant and to another workspace, and a foreign-scope insert is refused', async () => {
    const w = await createWorld(admin, 'Bi1'); const other = await createWorld(admin, 'Bi1y'); const p = await publish(w);
    const out = await svc.ingest(ctxOf(w), p.handoff) as { intakePackageId: string };
    const seen = (c: TenantContext) => withTenantTransaction(c, async (client) => (await client.query(`SELECT id FROM business_intelligence.intelligence_intake_packages WHERE id = $1`, [out.intakePackageId])).rowCount);
    expect(await seen(ctxOf(w))).toBe(1);
    expect(await seen(ctxOf(other))).toBe(0);
    expect(await seen({ ...ctxOf(w), workspaceId: randomUUID() })).toBe(0);
    await expect(withTenantTransaction(ctxOf(other), (client) => client.query(
      `INSERT INTO business_intelligence.intelligence_intake_packages (tenant_id, workspace_id, business_id, bo_publication_package_id, intake_code, domain, idempotency_key)
       VALUES ($1,$2,$3,$4,'x','cross_domain','k')`, [w.tenantId, w.workspaceId, w.businessId, p.packageId]))).rejects.toBeDefined();
  });

  it('every BI block maps to a domain the table accepts (parity with the live CHECK), and the domain stored is the one derived from the block', async () => {
    const [{ def }] = await q(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'intelligence_intake_packages_domain_check'`, []);
    for (const d of BI_INTAKE_DOMAINS) expect(def, d).toContain(`'${d}'`);
    expect((def.match(/'[a-z_]+'::text/g) ?? []).length).toBe(BI_INTAKE_DOMAINS.length);
    const w = await createWorld(admin, 'Bi1');
    for (const [block, domain] of [['BI-11', 'financial'], ['BI-14', 'marketing'], ['BI-18', 'market_competitive'], ['BI-01', 'cross_domain'], ['BI-25', 'cross_domain']] as const) {
      const p = await publish(w, { targetBlock: block });
      expect(await svc.ingest(ctxOf(w), p.handoff), block).toMatchObject({ outcome: 'VALIDATED', domain });
    }
  });

  it('a block that is not a BI block is refused before BO is even consulted', async () => {
    const w = await createWorld(admin, 'Bi1'); const p = await publish(w, { targetBlock: 'DT-01' });
    const counts = await biCounts(w);
    await expect(svc.ingest(ctxOf(w), p.handoff)).rejects.toMatchObject({ reasons: ['target_block_is_not_a_bi_block'] });
    expect(await biCounts(w)).toEqual(counts);
  });
});
