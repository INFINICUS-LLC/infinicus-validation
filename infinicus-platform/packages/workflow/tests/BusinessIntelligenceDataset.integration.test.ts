/**
 * BI-1: a validated BO -> BI intake becomes a versioned analytical dataset, against live PostgreSQL under the application role (RLS enforced). Intakes are made by
 * the real BusinessIntelligenceIntakeService from handoffs shaped exactly as BO builds them. Proves the dataset, its version (period, schema reference, NULL
 * scores), data reference, lineage, the intake's move to processed, versioning across packages, idempotent replay and concurrent calls, refusal of intakes that are
 * not validated, tenant / workspace isolation and RLS, compatibility with the existing BI reader, and that BO's tables are never changed.
 * Requires DATABASE_URL and ADMIN_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createPool, closePool, withTenantTransaction, IntelligenceIntakeRepository, type TenantContext } from '@infinicus/database';
import { BusinessIntelligenceIntakeService } from '../src/BusinessIntelligenceIntakeService.js';
import { BusinessIntelligenceDatasetService, IntakeNotMaterializableError } from '../src/BusinessIntelligenceDatasetService.js';
import { biCtx, createBiWorld, publishBoPackage, type BiWorld } from './helpers/boPublicationFixtures.js';

const run = !!process.env.DATABASE_URL && !!process.env.ADMIN_DATABASE_URL;

describe.runIf(run)('BusinessIntelligenceDatasetService (live PostgreSQL, application role)', () => {
  let admin: Pool;
  const intake = new BusinessIntelligenceIntakeService();
  const datasets = new BusinessIntelligenceDatasetService();
  beforeAll(() => { createPool({ connectionString: process.env.DATABASE_URL! }); admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL }); });
  afterAll(async () => { await admin?.end(); await closePool(); });

  const q = async (sql: string, args: unknown[]) => (await admin.query(sql, args)).rows;
  /** An intake that BI has validated, through the real intake service. */
  async function validatedIntake(w: BiWorld, o: Parameters<typeof publishBoPackage>[2] = {}) {
    const p = await publishBoPackage(admin, w, o); const out = await intake.ingest(biCtx(w), p.handoff);
    if (out.outcome !== 'VALIDATED') throw new Error(JSON.stringify(out));
    return { ...p, intakeId: out.intakePackageId };
  }
  const biCounts = async (w: BiWorld) => Object.fromEntries(await Promise.all(['analytical_datasets', 'analytical_dataset_versions', 'dataset_data_references', 'dataset_lineage'].map(async (t) =>
    [t, Number((await q(`SELECT count(*) n FROM business_intelligence.${t} WHERE business_id = $1`, [w.businessId]))[0].n)])));
  const boFingerprint = async (w: BiWorld) => JSON.stringify([
    await q(`SELECT * FROM business_operations.bo_publication_packages WHERE business_id = $1 ORDER BY id`, [w.businessId]),
    await q(`SELECT * FROM business_operations.bo_handoff_records WHERE business_id = $1 ORDER BY id`, [w.businessId]),
  ]);

  it('materializes a validated intake: dataset, published version for the BO period, data reference, lineage, mapped input, processed intake - and no BO row changes', async () => {
    const w = await createBiWorld(admin, 'Ds'); const i = await validatedIntake(w); const before = await boFingerprint(w);
    const out = await datasets.materialize(biCtx(w), i.intakeId);
    expect(out).toMatchObject({ datasetCode: 'bo-bi-16', versionNumber: 1, domain: 'inventory_supply', recordCount: 42, idempotentReplay: false });
    expect(out.effectiveStart.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(out.effectiveEnd.toISOString()).toBe('2026-11-01T00:00:00.000Z');

    const [ds] = await q(`SELECT * FROM business_intelligence.analytical_datasets WHERE id = $1`, [out.datasetId]);
    expect(ds).toMatchObject({ tenant_id: w.tenantId, workspace_id: w.workspaceId, business_id: w.businessId, dataset_code: 'bo-bi-16', domain: 'inventory_supply', status: 'active', latest_version: 1 });
    const [v] = await q(`SELECT * FROM business_intelligence.analytical_dataset_versions WHERE id = $1`, [out.datasetVersionId]);
    expect(v).toMatchObject({ dataset_id: out.datasetId, version_number: 1, publication_status: 'published', intake_package_id: i.intakeId, quality_score: null, completeness_score: null, correlation_id: i.correlationId });
    expect(v.schema_reference).toEqual({ contract: 'bo-publication-reference/1', fields: [{ name: 'complete', type: 'boolean' }, { name: 'rows', type: 'number' }, { name: 'table', type: 'string' }] });
    const [ref] = await q(`SELECT * FROM business_intelligence.dataset_data_references WHERE dataset_version_id = $1`, [out.datasetVersionId]);
    expect(ref).toMatchObject({ reference_type: 'bo_publication_package', record_count: 42, tenant_id: w.tenantId });
    expect(ref.reference).toMatchObject({ boPublicationPackageId: i.packageId, targetBlock: 'BI-16', payloadReference: { table: 'inventory_movements', rows: 42, complete: true } });
    const [source] = await q(`SELECT id FROM business_intelligence.intelligence_source_references WHERE intake_package_id = $1`, [i.intakeId]);
    const lineage = await q(`SELECT * FROM business_intelligence.dataset_lineage WHERE dataset_version_id = $1`, [out.datasetVersionId]);
    expect(lineage).toHaveLength(1);
    expect(lineage[0]).toMatchObject({ lineage_type: 'derived_from', source_reference_id: source.id, parent_dataset_version_id: null });
    expect((await q(`SELECT status FROM business_intelligence.intelligence_domain_inputs WHERE intake_package_id = $1`, [i.intakeId]))[0].status).toBe('mapped');
    expect((await q(`SELECT status FROM business_intelligence.intelligence_intake_packages WHERE id = $1`, [i.intakeId]))[0].status).toBe('processed');
    expect((await q(`SELECT from_status, to_status FROM business_intelligence.intelligence_processing_status_history WHERE intake_package_id = $1 AND to_status = 'processed'`, [i.intakeId])))
      .toEqual([{ from_status: 'validated', to_status: 'processed' }]);
    expect(await boFingerprint(w)).toBe(before);
  });

  it('is idempotent: materializing again returns the same version and writes nothing', async () => {
    const w = await createBiWorld(admin, 'Ds'); const i = await validatedIntake(w);
    const first = await datasets.materialize(biCtx(w), i.intakeId); const counts = await biCounts(w);
    const again = await datasets.materialize(biCtx(w), i.intakeId);
    expect(again).toMatchObject({ datasetVersionId: first.datasetVersionId, versionNumber: 1, idempotentReplay: true, recordCount: 42, datasetCode: 'bo-bi-16' });
    expect(await biCounts(w)).toEqual(counts);
    expect(counts).toEqual({ analytical_datasets: 1, analytical_dataset_versions: 1, dataset_data_references: 1, dataset_lineage: 1 });
  });

  it('concurrent calls for one intake create exactly one version', async () => {
    const w = await createBiWorld(admin, 'Ds'); const i = await validatedIntake(w);
    const results = await Promise.all([1, 2, 3, 4].map(() => datasets.materialize(biCtx(w), i.intakeId)));
    expect(new Set(results.map((r) => r.datasetVersionId)).size).toBe(1);
    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect((await biCounts(w)).analytical_dataset_versions).toBe(1);
  });

  it('later packages of the same BI block are the next versions of the SAME dataset, each for its own period; another block is another dataset', async () => {
    const w = await createBiWorld(admin, 'Ds');
    const oct = await validatedIntake(w); const nov = await validatedIntake(w, { periodStart: '2026-11-01T00:00:00.000Z', periodEnd: '2026-12-01T00:00:00.000Z', recordCount: 7, payloadReference: { table: 'inventory_movements', rows: 7 } });
    const finance = await validatedIntake(w, { targetBlock: 'BI-11' });
    const a = await datasets.materialize(biCtx(w), oct.intakeId); const b = await datasets.materialize(biCtx(w), nov.intakeId); const c = await datasets.materialize(biCtx(w), finance.intakeId);
    expect([a.versionNumber, b.versionNumber]).toEqual([1, 2]);
    expect(b.datasetId).toBe(a.datasetId);
    expect(b.effectiveStart.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(b.recordCount).toBe(7);
    expect(c).toMatchObject({ datasetCode: 'bo-bi-11', domain: 'financial', versionNumber: 1 });
    expect(c.datasetId).not.toBe(a.datasetId);
    expect((await q(`SELECT latest_version FROM business_intelligence.analytical_datasets WHERE id = $1`, [a.datasetId]))[0].latest_version).toBe(2);
    expect((await biCounts(w))).toEqual({ analytical_datasets: 2, analytical_dataset_versions: 3, dataset_data_references: 3, dataset_lineage: 3 });
  });

  it('only a validated intake can become a dataset: a rejected one, an unknown id and a malformed id are refused and nothing is created', async () => {
    const w = await createBiWorld(admin, 'Ds'); const counts = await biCounts(w);
    const p = await publishBoPackage(admin, w);
    const tampered = { ...p.handoff, payload: { ...p.handoff.payload, recordCount: 43 } };    // disagrees with BO: recorded as a rejected intake
    const rejected = await intake.ingest(biCtx(w), tampered);
    expect(rejected.outcome).toBe('REJECTED');
    await expect(datasets.materialize(biCtx(w), (rejected as { intakePackageId: string }).intakePackageId)).rejects.toMatchObject({ reason: 'status_is_rejected_not_validated' });
    await expect(datasets.materialize(biCtx(w), randomUUID())).rejects.toThrow(/not found/);
    await expect(datasets.materialize(biCtx(w), 'not-a-uuid')).rejects.toMatchObject({ reason: 'intake_package_id_not_a_uuid' });
    await expect(datasets.materialize(biCtx(w), 'x')).rejects.toBeInstanceOf(IntakeNotMaterializableError);
    expect(await biCounts(w)).toEqual(counts);
  });

  it('isolation: another tenant or another workspace cannot materialize the intake or see its dataset (row-level security)', async () => {
    const w = await createBiWorld(admin, 'Ds'); const other = await createBiWorld(admin, 'Dsx'); const i = await validatedIntake(w); const counts = await biCounts(w);
    await expect(datasets.materialize(biCtx(other), i.intakeId)).rejects.toThrow(/not found/);
    await expect(datasets.materialize({ ...biCtx(w), workspaceId: randomUUID() }, i.intakeId)).rejects.toThrow(/not found/);
    expect(await biCounts(w)).toEqual(counts);
    const out = await datasets.materialize(biCtx(w), i.intakeId);
    const seen = (c: TenantContext) => withTenantTransaction(c, async (client) => (await client.query(`SELECT id FROM business_intelligence.analytical_dataset_versions WHERE id = $1`, [out.datasetVersionId])).rowCount);
    expect(await seen(biCtx(w))).toBe(1);
    expect(await seen(biCtx(other))).toBe(0);
    expect(await seen({ ...biCtx(w), workspaceId: randomUUID() })).toBe(0);
  });

  it('downstream compatibility: the existing BI reader returns the version as published, linked to its intake, with no scores', async () => {
    const w = await createBiWorld(admin, 'Ds'); const i = await validatedIntake(w); const out = await datasets.materialize(biCtx(w), i.intakeId);
    const read = await new IntelligenceIntakeRepository().findDatasetVersion(biCtx(w), out.datasetVersionId);
    expect(read).toMatchObject({ id: out.datasetVersionId, datasetId: out.datasetId, versionNumber: 1, publicationStatus: 'published', intakePackageId: i.intakeId, qualityScore: null, completenessScore: null });
  });

  it('the dataset record is append-only for the application role: a published version cannot be rewritten', async () => {
    const w = await createBiWorld(admin, 'Ds'); const i = await validatedIntake(w); const out = await datasets.materialize(biCtx(w), i.intakeId);
    await expect(withTenantTransaction(biCtx(w), (c) => c.query(`UPDATE business_intelligence.analytical_dataset_versions SET quality_score = 1 WHERE id = $1`, [out.datasetVersionId]))).rejects.toBeDefined();
    await expect(withTenantTransaction(biCtx(w), (c) => c.query(`DELETE FROM business_intelligence.dataset_lineage WHERE dataset_version_id = $1`, [out.datasetVersionId]))).rejects.toBeDefined();
  });
});
