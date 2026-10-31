/**
 * BI-2-DEV-07: BI-owned warehouse row storage (migration 0223) against live PostgreSQL under the APPLICATION role (RLS enforced; the administrator connection builds
 * fixtures and tampers only). Datasets come from the real chain: a BO publication package, BI intake validation and dataset materialization, so every version carries
 * its true intake package, source reference and BO-declared record count. THE ROWS HERE ARE DEVELOPMENT FIXTURES, not production warehouse evidence: no BI ingestion
 * pathway delivers rows yet, so the repository is exercised directly. Requires DATABASE_URL and ADMIN_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createPool, closePool, withTenantTransaction, BiWarehouseRowRepository, WAREHOUSE_APPEND_BATCH_MAX, type TenantContext } from '@infinicus/database';
import { BusinessIntelligenceIntakeService } from '../src/BusinessIntelligenceIntakeService.js';
import { BusinessIntelligenceDatasetService } from '../src/BusinessIntelligenceDatasetService.js';
import { PostgresWarehouseRowSource } from '../src/PostgresWarehouseRowSource.js';
import { biCtx, createBiWorld, publishBoPackage, type BiWorld } from './helpers/boPublicationFixtures.js';

const run = !!process.env.DATABASE_URL && !!process.env.ADMIN_DATABASE_URL;
const NEW_TABLES = ['warehouse_dataset_rows', 'warehouse_dataset_version_seals', 'metric_calculation_runs', 'metric_calculation_run_inputs', 'metric_results'];

describe.runIf(run)('BI-2-DEV-07 warehouse row storage (live PostgreSQL, application role)', () => {
  let admin: Pool;
  const intake = new BusinessIntelligenceIntakeService();
  const datasets = new BusinessIntelligenceDatasetService();
  const repo = new BiWarehouseRowRepository();
  beforeAll(() => { createPool({ connectionString: process.env.DATABASE_URL! }); admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL }); });
  afterAll(async () => { await admin?.end(); await closePool(); });

  const q = async (sql: string, args: unknown[] = []) => (await admin.query(sql, args)).rows;
  /** A real BO package -> validated intake -> materialized dataset version, declaring `recordCount` records. */
  async function dataset(w: BiWorld, recordCount = 3, targetBlock = 'BI-16') {
    const p = await publishBoPackage(admin, w, { recordCount, targetBlock });
    const out = await intake.ingest(biCtx(w), p.handoff);
    if (out.outcome !== 'VALIDATED') throw new Error(JSON.stringify(out));
    const d = await datasets.materialize(biCtx(w), out.intakePackageId);
    const [source] = await q(`SELECT id FROM business_intelligence.intelligence_source_references WHERE intake_package_id = $1`, [out.intakePackageId]);
    return { datasetId: d.datasetId, versionId: d.datasetVersionId, sourceId: source.id as string, intakeId: out.intakePackageId as string, versionNumber: d.versionNumber };
  }
  const rowsOf = (n: number, from = 1) => Array.from({ length: n }, (_, i) => ({ rowNumber: from + i, data: { amount: `${(from + i) * 10}.50`, region: i % 2 ? 'north' : 'south', date: '2026-01-15T00:00:00Z' } }));
  const count = async (versionId: string) => Number((await q(`SELECT count(*) n FROM business_intelligence.warehouse_dataset_rows WHERE dataset_version_id = $1`, [versionId]))[0].n);
  /** Run SQL as the application role inside a tenant transaction (the way production code does). */
  const asApp = async <T>(ctx: TenantContext, fn: (query: (sql: string, args?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>) => Promise<T>) =>
    withTenantTransaction(ctx, (client) => fn((sql, args) => client.query(sql, args)));
  const refused = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return e as { name?: string; code?: string; message: string }; } };

  describe('schema integrity', () => {
    it('the five new tables exist with forced row-level security, a tenant/workspace policy and append-only triggers', async () => {
      for (const t of NEW_TABLES) {
        const [r] = await q(`SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS forced FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'business_intelligence' AND c.relname = $1`, [t]);
        expect(r, t).toEqual({ rls: true, forced: true });
        const policies = await q(`SELECT policyname, qual FROM pg_policies WHERE schemaname = 'business_intelligence' AND tablename = $1`, [t]);
        expect(policies.map((p) => p.policyname), t).toEqual([`${t}_tenant_isolation`]);
        expect(policies[0].qual).toMatch(/tenant_id = .*app\.tenant_id.*workspace_id = .*app\.workspace_id/s);
        const triggers = (await q(`SELECT tgname FROM pg_trigger WHERE tgrelid = ('business_intelligence.' || $1)::regclass AND NOT tgisinternal`, [t])).map((x) => x.tgname);
        expect(triggers, t).toEqual(expect.arrayContaining([`forbid_mutation_${t}`, `forbid_truncate_${t}`]));
      }
    });

    it('every reference carries the tenant, workspace and business: composite scope-aware foreign keys, 4 or 5 columns wide', async () => {
      const fks = await q(`SELECT conrelid::regclass::text AS tbl, conname, array_length(conkey, 1) AS cols, confrelid::regclass::text AS parent FROM pg_constraint
                            WHERE contype = 'f' AND conrelid::regclass::text = ANY($1) AND conname LIKE '%\\_fk' ORDER BY conname`,
        [NEW_TABLES.map((t) => `business_intelligence.${t}`)]);
      expect(fks.map((f) => f.conname)).toEqual([
        'metric_calculation_run_inputs_run_fk', 'metric_calculation_run_inputs_seal_fk', 'metric_results_dataset_fk', 'metric_results_definition_fk', 'metric_results_run_fk',
        'warehouse_dataset_rows_source_fk', 'warehouse_dataset_rows_version_fk', 'warehouse_dataset_version_seals_version_fk',
      ]);
      for (const f of fks) expect(Number(f.cols), f.conname).toBeGreaterThanOrEqual(4);
      expect((await q(`SELECT conname FROM pg_constraint WHERE conrelid IN ('business_intelligence.analytical_datasets'::regclass, 'business_intelligence.analytical_dataset_versions'::regclass,
                        'business_intelligence.intelligence_source_references'::regclass, 'business_intelligence.metric_definition_versions'::regclass) AND conname LIKE '%\\_scope\\_key' ORDER BY conname`)).map((c) => c.conname))
        .toEqual(['analytical_dataset_versions_dataset_scope_key', 'analytical_datasets_scope_key', 'intelligence_source_references_scope_key', 'metric_definition_versions_scope_key']);
    });

    it('migration 0223 is recorded and no earlier migration was altered by it (additive: the existing tables keep their rows and triggers)', async () => {
      expect((await q(`SELECT filename FROM _migrations WHERE filename LIKE '0223%'`)).map((r) => r.filename)).toEqual(['0223_bi10_warehouse_rows_and_calculation_persistence.sql']);
      expect(Number((await q(`SELECT count(*) n FROM pg_trigger WHERE tgrelid = 'business_intelligence.analytical_dataset_versions'::regclass AND tgname = 'forbid_mutation_analytical_dataset_versions'`))[0].n)).toBe(1);
    });
  });

  describe('appending rows', () => {
    it('records rows of a published version; the database computes the fingerprint and the time, whatever the caller states', async () => {
      const w = await createBiWorld(admin, 'W1'); const d = await dataset(w);
      expect(await repo.appendRows(biCtx(w), w.businessId, { datasetVersionId: d.versionId, sourceReferenceId: d.sourceId, rows: rowsOf(3) })).toEqual({ inserted: 3, replayed: 0 });
      const stored = await q(`SELECT row_number, row_data, row_fingerprint, source_reference_id, recorded_at FROM business_intelligence.warehouse_dataset_rows WHERE dataset_version_id = $1 ORDER BY row_number`, [d.versionId]);
      expect(stored.map((r) => r.row_number)).toEqual([1, 2, 3]);
      const [expected] = await q(`SELECT encode(sha256(convert_to($1::jsonb::text, 'UTF8')), 'hex') AS f`, [JSON.stringify(rowsOf(3)[0]!.data)]);
      expect(stored[0].row_fingerprint).toBe(expected.f);
      expect(stored.every((r) => r.source_reference_id === d.sourceId)).toBe(true);
      // a forged fingerprint and a back-dated time written directly under the application role are overwritten
      const ctx = biCtx(w);
      const d2 = await dataset(w, 1, 'BI-12');
      await asApp(ctx, (query) => query(
        `INSERT INTO business_intelligence.warehouse_dataset_rows (tenant_id, workspace_id, business_id, dataset_id, dataset_version_id, row_number, row_data, row_fingerprint, source_reference_id, recorded_at)
         VALUES ($1,$2,$3,$4,$5,1,'{"a":1}', repeat('f',64), $6, '2001-01-01')`, [w.tenantId, w.workspaceId, w.businessId, d2.datasetId, d2.versionId, d2.sourceId]));
      const [forged] = await q(`SELECT row_fingerprint, recorded_at FROM business_intelligence.warehouse_dataset_rows WHERE dataset_version_id = $1`, [d2.versionId]);
      expect(forged.row_fingerprint).not.toBe('f'.repeat(64));
      expect(forged.recorded_at.getFullYear()).toBeGreaterThanOrEqual(2026);
    });

    it('the fingerprint does not depend on key order', async () => {
      const w = await createBiWorld(admin, 'W2'); const d = await dataset(w, 2);
      await repo.appendRows(biCtx(w), w.businessId, { datasetVersionId: d.versionId, sourceReferenceId: d.sourceId, rows: [{ rowNumber: 1, data: { a: 1, b: 'x' } }, { rowNumber: 2, data: { b: 'x', a: 1 } }] });
      const [r1, r2] = await q(`SELECT row_fingerprint FROM business_intelligence.warehouse_dataset_rows WHERE dataset_version_id = $1 ORDER BY row_number`, [d.versionId]);
      expect(r1.row_fingerprint).toBe(r2.row_fingerprint);
    });

    it('is idempotent: the same rows again are a replay and write nothing; different content under a recorded row number is a conflict', async () => {
      const w = await createBiWorld(admin, 'W3'); const d = await dataset(w); const input = { datasetVersionId: d.versionId, sourceReferenceId: d.sourceId, rows: rowsOf(3) };
      await repo.appendRows(biCtx(w), w.businessId, input);
      expect(await repo.appendRows(biCtx(w), w.businessId, input)).toEqual({ inserted: 0, replayed: 3 });
      expect(await repo.appendRows(biCtx(w), w.businessId, { ...input, rows: rowsOf(2) })).toEqual({ inserted: 0, replayed: 2 });
      expect(await count(d.versionId)).toBe(3);
      const conflict = await refused(repo.appendRows(biCtx(w), w.businessId, { ...input, rows: [{ rowNumber: 2, data: { amount: '999', region: 'x', date: 'y' } }] }));
      expect(conflict?.name).toBe('ConflictError');
      expect(await count(d.versionId)).toBe(3);
    });

    it('is atomic: a call holding one new row and one conflicting row keeps neither', async () => {
      const w = await createBiWorld(admin, 'W4'); const d = await dataset(w, 5);
      await repo.appendRows(biCtx(w), w.businessId, { datasetVersionId: d.versionId, sourceReferenceId: d.sourceId, rows: rowsOf(2) });
      const failed = await refused(repo.appendRows(biCtx(w), w.businessId, { datasetVersionId: d.versionId, sourceReferenceId: d.sourceId, rows: [...rowsOf(1, 3), { rowNumber: 1, data: { different: true } }] }));
      expect(failed?.name).toBe('ConflictError');
      expect(await count(d.versionId)).toBe(2);
    });

    it('concurrent identical appends record each row once', async () => {
      const w = await createBiWorld(admin, 'W5'); const d = await dataset(w, 4); const input = { datasetVersionId: d.versionId, sourceReferenceId: d.sourceId, rows: rowsOf(4) };
      const results = await Promise.all(Array.from({ length: 6 }, () => repo.appendRows(biCtx(w), w.businessId, input)));
      expect(results.reduce((n, r) => n + r.inserted, 0)).toBe(4);
      expect(await count(d.versionId)).toBe(4);
    });

    it.each([
      ['an empty call', () => [] as never],
      ['a row number of 0', () => [{ rowNumber: 0, data: {} }]],
      ['a fractional row number', () => [{ rowNumber: 1.5, data: {} }]],
      ['a duplicate row number', () => [{ rowNumber: 1, data: {} }, { rowNumber: 1, data: {} }]],
      ['an array as a row', () => [{ rowNumber: 1, data: [1] as never }]],
      ['null as a row', () => [{ rowNumber: 1, data: null as never }]],
      ['NaN in a row', () => [{ rowNumber: 1, data: { a: Number.NaN } }]],
      ['Infinity in a row', () => [{ rowNumber: 1, data: { a: Number.POSITIVE_INFINITY } }]],
      ['undefined in a row', () => [{ rowNumber: 1, data: { a: undefined } }]],
      ['a Date in a row', () => [{ rowNumber: 1, data: { a: new Date() } }]],
      ['a bigint in a row', () => [{ rowNumber: 1, data: { a: 1n } }]],
      ['a class instance in a row', () => [{ rowNumber: 1, data: { a: new (class X { v = 1 })() } }]],
    ])('refuses %s before anything is written', async (_label, rows) => {
      const w = await createBiWorld(admin, 'W6'); const d = await dataset(w);
      const e = await refused(repo.appendRows(biCtx(w), w.businessId, { datasetVersionId: d.versionId, sourceReferenceId: d.sourceId, rows: rows() }));
      expect(e?.name).toBe('ValidationError');
      expect(await count(d.versionId)).toBe(0);
    });

    it('refuses more than the engineering batch bound in one call (never truncates)', async () => {
      const w = await createBiWorld(admin, 'W7'); const d = await dataset(w);
      const rows = Array.from({ length: WAREHOUSE_APPEND_BATCH_MAX + 1 }, (_, i) => ({ rowNumber: i + 1, data: {} }));
      expect((await refused(repo.appendRows(biCtx(w), w.businessId, { datasetVersionId: d.versionId, sourceReferenceId: d.sourceId, rows })))?.name).toBe('ValidationError');
    });

    it('refuses malformed identifiers, an unknown version and a missing source reference', async () => {
      const w = await createBiWorld(admin, 'W8'); const d = await dataset(w);
      const base = { datasetVersionId: d.versionId, sourceReferenceId: d.sourceId, rows: rowsOf(1) };
      expect((await refused(repo.appendRows(biCtx(w), w.businessId, { ...base, datasetVersionId: 'nope' })))?.name).toBe('ValidationError');
      expect((await refused(repo.appendRows(biCtx(w), w.businessId, { ...base, sourceReferenceId: '{x}' })))?.name).toBe('ValidationError');
      expect((await refused(repo.appendRows(biCtx(w), w.businessId, { ...base, datasetVersionId: randomUUID() })))?.name).toBe('NotFoundError');
      expect((await refused(repo.appendRows(biCtx(w), w.businessId, { ...base, sourceReferenceId: randomUUID() })))?.name).toBe('NotFoundError');
      expect(await count(d.versionId)).toBe(0);
    });

    it('accepts an upper-case identifier and treats it as the same version', async () => {
      const w = await createBiWorld(admin, 'W9'); const d = await dataset(w);
      expect(await repo.appendRows(biCtx(w), w.businessId.toUpperCase(), { datasetVersionId: d.versionId.toUpperCase(), sourceReferenceId: d.sourceId.toUpperCase(), rows: rowsOf(1) })).toEqual({ inserted: 1, replayed: 0 });
    });

    it('a row must cite a source reference of the intake package its version was built from: another dataset\'s source reference is refused', async () => {
      const w = await createBiWorld(admin, 'W10'); const a = await dataset(w, 2, 'BI-16'); const b = await dataset(w, 2, 'BI-12');
      const e = await refused(repo.appendRows(biCtx(w), w.businessId, { datasetVersionId: a.versionId, sourceReferenceId: b.sourceId, rows: rowsOf(1) }));
      expect(e?.name).toBe('ValidationError');
      expect(e?.message).not.toMatch(/intelligence_source_references|intake_package|trigger|business_intelligence/);
      expect(await count(a.versionId)).toBe(0);
    });

    it('only a published version takes rows (a draft version, made by the administrator for this test, is refused by the database)', async () => {
      const w = await createBiWorld(admin, 'W11'); const d = await dataset(w);
      const [draft] = await q(`INSERT INTO business_intelligence.analytical_dataset_versions (dataset_id, tenant_id, workspace_id, business_id, version_number, effective_start, publication_status, intake_package_id)
                               VALUES ($1,$2,$3,$4,9,now(),'draft',$5) RETURNING id`, [d.datasetId, w.tenantId, w.workspaceId, w.businessId, d.intakeId]);
      const e = await refused(repo.appendRows(biCtx(w), w.businessId, { datasetVersionId: draft.id, sourceReferenceId: d.sourceId, rows: rowsOf(1) }));
      expect(e?.name).toBe('ValidationError');
    });
  });

  describe('sealing', () => {
    async function filled(w: BiWorld, declared: number, rows = declared) {
      const d = await dataset(w, declared);
      if (rows > 0) await repo.appendRows(biCtx(w), w.businessId, { datasetVersionId: d.versionId, sourceReferenceId: d.sourceId, rows: rowsOf(rows) });
      return d;
    }

    it('the database computes the seal: row count, the declared count and a digest of the row fingerprints in order', async () => {
      const w = await createBiWorld(admin, 'S1'); const d = await filled(w, 3);
      const seal = await repo.sealVersion(biCtx(w), w.businessId, d.versionId);
      const fps = (await q(`SELECT row_fingerprint f FROM business_intelligence.warehouse_dataset_rows WHERE dataset_version_id = $1 ORDER BY row_number`, [d.versionId])).map((r) => r.f);
      expect(seal).toEqual({ datasetVersionId: d.versionId, rowCount: 3, rowsDigest: createHash('sha256').update(fps.join(',')).digest('hex'), replayed: false });
      const [stored] = await q(`SELECT row_count, declared_record_count, rows_digest, sealed_at FROM business_intelligence.warehouse_dataset_version_seals WHERE dataset_version_id = $1`, [d.versionId]);
      expect(stored).toMatchObject({ row_count: 3, declared_record_count: 3, rows_digest: seal.rowsDigest });
    });

    it('is idempotent and safe under concurrency: one seal, every caller sees it', async () => {
      const w = await createBiWorld(admin, 'S2'); const d = await filled(w, 2);
      const all = await Promise.all(Array.from({ length: 6 }, () => repo.sealVersion(biCtx(w), w.businessId, d.versionId)));
      expect(new Set(all.map((s) => s.rowsDigest)).size).toBe(1);
      expect(all.filter((s) => !s.replayed)).toHaveLength(1);
      expect(Number((await q(`SELECT count(*) n FROM business_intelligence.warehouse_dataset_version_seals WHERE dataset_version_id = $1`, [d.versionId]))[0].n)).toBe(1);
    });

    it('refuses to seal when the rows are fewer or more than BO declared, or numbered with a gap - and writes no seal', async () => {
      const w = await createBiWorld(admin, 'S3');
      const few = await filled(w, 3, 2);
      expect((await refused(repo.sealVersion(biCtx(w), w.businessId, few.versionId)))?.message).toMatch(/2 rows but 3 were declared/);
      const none = await filled(w, 3, 0);
      expect((await refused(repo.sealVersion(biCtx(w), w.businessId, none.versionId)))?.name).toBe('ValidationError');
      const gap = await dataset(w, 2, 'BI-12');
      await repo.appendRows(biCtx(w), w.businessId, { datasetVersionId: gap.versionId, sourceReferenceId: gap.sourceId, rows: [{ rowNumber: 1, data: {} }, { rowNumber: 3, data: {} }] });
      expect((await refused(repo.sealVersion(biCtx(w), w.businessId, gap.versionId)))?.message).toMatch(/without gaps/);
      expect(Number((await q(`SELECT count(*) n FROM business_intelligence.warehouse_dataset_version_seals WHERE business_id = $1`, [w.businessId]))[0].n)).toBe(0);
    });

    it('a sealed version takes no new row: through the repository (conflict) or directly (the database refuses)', async () => {
      const w = await createBiWorld(admin, 'S4'); const d = await filled(w, 2);
      await repo.sealVersion(biCtx(w), w.businessId, d.versionId);
      expect((await refused(repo.appendRows(biCtx(w), w.businessId, { datasetVersionId: d.versionId, sourceReferenceId: d.sourceId, rows: rowsOf(1, 3) })))?.name).toBe('ConflictError');
      expect(await repo.appendRows(biCtx(w), w.businessId, { datasetVersionId: d.versionId, sourceReferenceId: d.sourceId, rows: rowsOf(2) })).toEqual({ inserted: 0, replayed: 2 });
      const direct = await refused(asApp(biCtx(w), (query) => query(
        `INSERT INTO business_intelligence.warehouse_dataset_rows (tenant_id, workspace_id, business_id, dataset_id, dataset_version_id, row_number, row_data, source_reference_id)
         VALUES ($1,$2,$3,$4,$5,3,'{}',$6)`, [w.tenantId, w.workspaceId, w.businessId, d.datasetId, d.versionId, d.sourceId])));
      expect(direct?.code).toBe('23514');
      expect(await count(d.versionId)).toBe(2);
    });

    it('the database itself refuses a seal whose rows are not numbered 1..n, even when the count is right (direct SQL under the application role)', async () => {
      const w = await createBiWorld(admin, 'S6'); const d = await dataset(w, 2);
      await repo.appendRows(biCtx(w), w.businessId, { datasetVersionId: d.versionId, sourceReferenceId: d.sourceId, rows: [{ rowNumber: 1, data: {} }, { rowNumber: 3, data: {} }] });
      const e = await refused(asApp(biCtx(w), (query) => query(
        `INSERT INTO business_intelligence.warehouse_dataset_version_seals (tenant_id, workspace_id, business_id, dataset_id, dataset_version_id, row_count, declared_record_count, rows_digest)
         VALUES ($1,$2,$3,$4,$5, 2, 2, repeat('0', 64))`, [w.tenantId, w.workspaceId, w.businessId, d.datasetId, d.versionId])));
      expect(e?.code).toBe('23514'); expect(e?.message).toMatch(/without gaps/);
    });

    it('the database itself refuses a seal that disagrees with the declared record count (direct SQL: fewer rows than declared)', async () => {
      const w = await createBiWorld(admin, 'S5'); const d = await dataset(w, 3);
      await repo.appendRows(biCtx(w), w.businessId, { datasetVersionId: d.versionId, sourceReferenceId: d.sourceId, rows: rowsOf(2) });
      const e = await refused(asApp(biCtx(w), (query) => query(
        `INSERT INTO business_intelligence.warehouse_dataset_version_seals (tenant_id, workspace_id, business_id, dataset_id, dataset_version_id, row_count, declared_record_count, rows_digest)
         VALUES ($1,$2,$3,$4,$5, 0, 0, repeat('0', 64))`, [w.tenantId, w.workspaceId, w.businessId, d.datasetId, d.versionId])));
      expect(e?.code).toBe('23514');
    });

    it('the database itself refuses to seal a version that is not published (a draft version with a declared count of 0, made by the administrator)', async () => {
      const w = await createBiWorld(admin, 'S8'); const d = await dataset(w, 1);
      const [draft] = await q(`INSERT INTO business_intelligence.analytical_dataset_versions (dataset_id, tenant_id, workspace_id, business_id, version_number, effective_start, publication_status, intake_package_id)
                               VALUES ($1,$2,$3,$4,9,now(),'draft',$5) RETURNING id`, [d.datasetId, w.tenantId, w.workspaceId, w.businessId, d.intakeId]);
      await q(`INSERT INTO business_intelligence.dataset_data_references (dataset_version_id, tenant_id, workspace_id, business_id, reference_type, reference, record_count) VALUES ($1,$2,$3,$4,'test','{}',0)`, [draft.id, w.tenantId, w.workspaceId, w.businessId]);
      const e = await refused(asApp(biCtx(w), (query) => query(
        `INSERT INTO business_intelligence.warehouse_dataset_version_seals (tenant_id, workspace_id, business_id, dataset_id, dataset_version_id, row_count, declared_record_count, rows_digest)
         VALUES ($1,$2,$3,$4,$5, 0, 0, repeat('0', 64))`, [w.tenantId, w.workspaceId, w.businessId, d.datasetId, draft.id])));
      expect(e?.code).toBe('23514'); expect(e?.message).toMatch(/only a published dataset version/);
    });

    it('a seal supplied by the caller is ignored: counts and digest placeholders are replaced by the database values', async () => {
      const w = await createBiWorld(admin, 'S5'); const d = await filled(w, 2);
      await asApp(biCtx(w), (query) => query(
        `INSERT INTO business_intelligence.warehouse_dataset_version_seals (tenant_id, workspace_id, business_id, dataset_id, dataset_version_id, row_count, declared_record_count, rows_digest)
         VALUES ($1,$2,$3,$4,$5, 0, 0, repeat('a', 64))`, [w.tenantId, w.workspaceId, w.businessId, d.datasetId, d.versionId]));
      const [s] = await q(`SELECT row_count, declared_record_count, rows_digest FROM business_intelligence.warehouse_dataset_version_seals WHERE dataset_version_id = $1`, [d.versionId]);
      expect(s.row_count).toBe(2); expect(s.declared_record_count).toBe(2); expect(s.rows_digest).not.toBe('a'.repeat(64));
    });
  });

  describe('reading sealed rows', () => {
    it('returns the latest published version\'s rows in row order, with the seal; a version that is not sealed is refused, never read around', async () => {
      const w = await createBiWorld(admin, 'R1'); const v1 = await dataset(w, 2);
      await repo.appendRows(biCtx(w), w.businessId, { datasetVersionId: v1.versionId, sourceReferenceId: v1.sourceId, rows: rowsOf(2) });
      await repo.sealVersion(biCtx(w), w.businessId, v1.versionId);
      const read1 = await repo.readLatestSealed(biCtx(w), w.businessId, v1.datasetId, 100);
      expect(read1).toMatchObject({ datasetId: v1.datasetId, datasetVersionId: v1.versionId, versionNumber: 1, rowCount: 2, truncated: false });
      expect(read1.rows).toEqual(rowsOf(2).map((r) => r.data));
      // a second package for the same target block is version 2 of the same dataset; until it is sealed the dataset has no readable latest version
      const v2 = await dataset(w, 1);
      expect(v2.datasetId).toBe(v1.datasetId);
      const e = await refused(repo.readLatestSealed(biCtx(w), w.businessId, v1.datasetId, 100));
      expect(e?.name).toBe('ConflictError');
      await repo.appendRows(biCtx(w), w.businessId, { datasetVersionId: v2.versionId, sourceReferenceId: v2.sourceId, rows: rowsOf(1) });
      await repo.sealVersion(biCtx(w), w.businessId, v2.versionId);
      expect(await repo.readLatestSealed(biCtx(w), w.businessId, v1.datasetId, 100)).toMatchObject({ datasetVersionId: v2.versionId, versionNumber: 2, rowCount: 1 });
      expect(await repo.readSealedVersion(biCtx(w), w.businessId, v1.versionId, 100)).toMatchObject({ versionNumber: 1, rowCount: 2 });
    });

    it('flags truncation instead of hiding it when the caller asks for fewer rows than are sealed', async () => {
      const w = await createBiWorld(admin, 'R2'); const d = await dataset(w, 4);
      await repo.appendRows(biCtx(w), w.businessId, { datasetVersionId: d.versionId, sourceReferenceId: d.sourceId, rows: rowsOf(4) });
      await repo.sealVersion(biCtx(w), w.businessId, d.versionId);
      const r = await repo.readLatestSealed(biCtx(w), w.businessId, d.datasetId, 3);
      expect(r.rows).toHaveLength(3); expect(r.truncated).toBe(true); expect(r.rowCount).toBe(4);
      expect((await refused(repo.readLatestSealed(biCtx(w), w.businessId, d.datasetId, 0)))?.name).toBe('ValidationError');
    });

    it('fails closed when stored rows no longer match their seal (data altered, a row removed or added with the protections off)', async () => {
      const w = await createBiWorld(admin, 'R3'); const d = await dataset(w, 3);
      await repo.appendRows(biCtx(w), w.businessId, { datasetVersionId: d.versionId, sourceReferenceId: d.sourceId, rows: rowsOf(3) });
      await repo.sealVersion(biCtx(w), w.businessId, d.versionId);
      const tamper = async (sql: string) => { const c = await admin.connect(); try { await c.query('BEGIN'); await c.query("SET LOCAL session_replication_role = 'replica'"); await c.query(sql, [d.versionId]); await c.query('COMMIT'); } finally { c.release(); } };
      await tamper(`UPDATE business_intelligence.warehouse_dataset_rows SET row_data = '{"amount":"1.00"}' WHERE dataset_version_id = $1 AND row_number = 2`);
      const e = await refused(repo.readLatestSealed(biCtx(w), w.businessId, d.datasetId, 100));
      expect(e?.name).toBe('ConflictError'); expect(e?.message).toMatch(/no longer match their seal/);
      const w2 = await createBiWorld(admin, 'R3b'); const d2 = await dataset(w2, 3);
      await repo.appendRows(biCtx(w2), w2.businessId, { datasetVersionId: d2.versionId, sourceReferenceId: d2.sourceId, rows: rowsOf(3) });
      await repo.sealVersion(biCtx(w2), w2.businessId, d2.versionId);
      const c = await admin.connect(); try { await c.query('BEGIN'); await c.query("SET LOCAL session_replication_role = 'replica'"); await c.query(`DELETE FROM business_intelligence.warehouse_dataset_rows WHERE dataset_version_id = $1 AND row_number = 3`, [d2.versionId]); await c.query('COMMIT'); } finally { c.release(); }
      expect((await refused(repo.readLatestSealed(biCtx(w2), w2.businessId, d2.datasetId, 100)))?.name).toBe('ConflictError');
    });

    it('an unknown dataset, a malformed id and a dataset with no version are NotFound', async () => {
      const w = await createBiWorld(admin, 'R4');
      expect((await refused(repo.readLatestSealed(biCtx(w), w.businessId, randomUUID(), 10)))?.name).toBe('NotFoundError');
      expect((await refused(repo.readLatestSealed(biCtx(w), w.businessId, 'nope', 10)))?.name).toBe('NotFoundError');
    });
  });

  describe('isolation, RLS and immutability (application role)', () => {
    it('another business, workspace or tenant can neither read, append, seal nor see the rows (uniform NotFound), and a foreign id leaks nothing', async () => {
      const a = await createBiWorld(admin, 'I1a'); const b = await createBiWorld(admin, 'I1b'); const d = await dataset(a, 2);
      await repo.appendRows(biCtx(a), a.businessId, { datasetVersionId: d.versionId, sourceReferenceId: d.sourceId, rows: rowsOf(2) });
      await repo.sealVersion(biCtx(a), a.businessId, d.versionId);
      for (const call of [
        () => repo.readLatestSealed(biCtx(b), b.businessId, d.datasetId, 10),
        () => repo.readSealedVersion(biCtx(b), b.businessId, d.versionId, 10),
        () => repo.appendRows(biCtx(b), b.businessId, { datasetVersionId: d.versionId, sourceReferenceId: d.sourceId, rows: rowsOf(1, 3) }),
        () => repo.sealVersion(biCtx(b), b.businessId, d.versionId),
        () => repo.readLatestSealed(biCtx(b), a.businessId, d.datasetId, 10),
        () => repo.readLatestSealed(biCtx(a), b.businessId, d.datasetId, 10),
      ]) {
        const e = await refused(call());
        expect(e?.name).toBe('NotFoundError');
        expect([a.tenantId, b.tenantId].some((id) => e?.message.includes(id))).toBe(false);
      }
      expect(await count(d.versionId)).toBe(2);
    });

    it('a sibling business of the same workspace is isolated by the explicit business predicate (RLS alone would not separate it)', async () => {
      const a = await createBiWorld(admin, 'I2');
      const [sib] = await q(`INSERT INTO platform.businesses (tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,'Sibling',$3,'active') RETURNING id`, [a.tenantId, a.workspaceId, `sib-${randomUUID().slice(0, 8)}`]);
      const d = await dataset(a, 1);
      await repo.appendRows(biCtx(a), a.businessId, { datasetVersionId: d.versionId, sourceReferenceId: d.sourceId, rows: rowsOf(1) });
      await repo.sealVersion(biCtx(a), a.businessId, d.versionId);
      expect((await refused(repo.readLatestSealed(biCtx(a), sib.id, d.datasetId, 10)))?.name).toBe('NotFoundError');
      expect((await refused(repo.appendRows(biCtx(a), sib.id, { datasetVersionId: d.versionId, sourceReferenceId: d.sourceId, rows: rowsOf(1, 2) })))?.name).toBe('NotFoundError');
    });

    it('every entry point refuses a sibling business, including sealing and reading one specific version by id', async () => {
      const a = await createBiWorld(admin, 'I2b');
      const [sib] = await q(`INSERT INTO platform.businesses (tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,'Sibling',$3,'active') RETURNING id`, [a.tenantId, a.workspaceId, `sib-${randomUUID().slice(0, 8)}`]);
      const d = await dataset(a, 1);
      await repo.appendRows(biCtx(a), a.businessId, { datasetVersionId: d.versionId, sourceReferenceId: d.sourceId, rows: rowsOf(1) });
      for (const call of [
        () => repo.sealVersion(biCtx(a), sib.id, d.versionId),
        () => repo.readSealedVersion(biCtx(a), sib.id, d.versionId, 10),
        () => repo.appendRows(biCtx(a), sib.id, { datasetVersionId: d.versionId, sourceReferenceId: d.sourceId, rows: rowsOf(1, 2) }),
      ]) expect((await refused(call()))?.name).toBe('NotFoundError');
      expect(Number((await q(`SELECT count(*) n FROM business_intelligence.warehouse_dataset_version_seals WHERE dataset_version_id = $1`, [d.versionId]))[0].n)).toBe(0);
    });

    it('a soft-deleted business is treated as a business that does not exist', async () => {
      const w = await createBiWorld(admin, 'I2c'); const d = await dataset(w, 1);
      await repo.appendRows(biCtx(w), w.businessId, { datasetVersionId: d.versionId, sourceReferenceId: d.sourceId, rows: rowsOf(1) });
      await repo.sealVersion(biCtx(w), w.businessId, d.versionId);
      await admin.query(`UPDATE platform.businesses SET deleted_at = now() WHERE id = $1`, [w.businessId]);
      for (const call of [
        () => repo.readLatestSealed(biCtx(w), w.businessId, d.datasetId, 10),
        () => repo.readSealedVersion(biCtx(w), w.businessId, d.versionId, 10),
        () => repo.sealVersion(biCtx(w), w.businessId, d.versionId),
        () => repo.appendRows(biCtx(w), w.businessId, { datasetVersionId: d.versionId, sourceReferenceId: d.sourceId, rows: rowsOf(1) }),
      ]) expect((await refused(call()))?.name).toBe('NotFoundError');
    });

    it('the Postgres row source is bound to its caller: another tenant or workspace in the scope it is asked for is refused before any read', async () => {
      const a = await createBiWorld(admin, 'I2d'); const b = await createBiWorld(admin, 'I2e'); const d = await dataset(a, 1);
      await repo.appendRows(biCtx(a), a.businessId, { datasetVersionId: d.versionId, sourceReferenceId: d.sourceId, rows: rowsOf(1) });
      await repo.sealVersion(biCtx(a), a.businessId, d.versionId);
      const source = new PostgresWarehouseRowSource(biCtx(a));
      await expect(source.rows({ tenantId: b.tenantId, workspaceId: a.workspaceId, businessId: a.businessId }, d.datasetId)).rejects.toThrow(/another tenant or workspace/);
      await expect(source.rows({ tenantId: a.tenantId, workspaceId: b.workspaceId, businessId: a.businessId }, d.datasetId)).rejects.toThrow(/another tenant or workspace/);
      expect(source.inputs.size).toBe(0);
      expect((await source.rows({ tenantId: a.tenantId, workspaceId: a.workspaceId, businessId: a.businessId }, d.datasetId)).length).toBe(1);
      expect([...source.inputs.keys()]).toEqual([d.datasetId]);
    });

    it('row-level security: another tenant sees no rows or seals, and cannot insert a row into this one', async () => {
      const a = await createBiWorld(admin, 'I3a'); const b = await createBiWorld(admin, 'I3b'); const d = await dataset(a, 1);
      await repo.appendRows(biCtx(a), a.businessId, { datasetVersionId: d.versionId, sourceReferenceId: d.sourceId, rows: rowsOf(1) });
      await repo.sealVersion(biCtx(a), a.businessId, d.versionId);
      const seen = await asApp(biCtx(b), async (query) => ({
        rows: (await query('SELECT count(*)::int AS n FROM business_intelligence.warehouse_dataset_rows')).rows[0]!.n,
        seals: (await query('SELECT count(*)::int AS n FROM business_intelligence.warehouse_dataset_version_seals')).rows[0]!.n,
      }));
      expect(seen).toEqual({ rows: 0, seals: 0 });
      const forged = await refused(asApp(biCtx(b), (query) => query(
        `INSERT INTO business_intelligence.warehouse_dataset_rows (tenant_id, workspace_id, business_id, dataset_id, dataset_version_id, row_number, row_data, source_reference_id)
         VALUES ($1,$2,$3,$4,$5,9,'{}',$6)`, [a.tenantId, a.workspaceId, a.businessId, d.datasetId, d.versionId, d.sourceId])));
      expect(forged).not.toBeNull();
      expect(await count(d.versionId)).toBe(1);
    });

    it('a row cannot be recorded against a version of another business even with the right tenant (composite key)', async () => {
      const a = await createBiWorld(admin, 'I4');
      const [sib] = await q(`INSERT INTO platform.businesses (tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,'Sibling',$3,'active') RETURNING id`, [a.tenantId, a.workspaceId, `sib-${randomUUID().slice(0, 8)}`]);
      const d = await dataset(a, 1);
      const e = await refused(asApp(biCtx(a), (query) => query(
        `INSERT INTO business_intelligence.warehouse_dataset_rows (tenant_id, workspace_id, business_id, dataset_id, dataset_version_id, row_number, row_data, source_reference_id)
         VALUES ($1,$2,$3,$4,$5,1,'{}',$6)`, [a.tenantId, a.workspaceId, sib.id, d.datasetId, d.versionId, d.sourceId])));
      expect(e?.code).toBe('23503');
    });

    it('rows and seals are append-only: update and delete are refused, and truncate is blocked by trigger and by privilege on every new table', async () => {
      const w = await createBiWorld(admin, 'I5'); const d = await dataset(w, 1);
      await repo.appendRows(biCtx(w), w.businessId, { datasetVersionId: d.versionId, sourceReferenceId: d.sourceId, rows: rowsOf(1) });
      await repo.sealVersion(biCtx(w), w.businessId, d.versionId);
      for (const sql of [
        `UPDATE business_intelligence.warehouse_dataset_rows SET row_data = '{}' WHERE dataset_version_id = '${d.versionId}'`,
        `DELETE FROM business_intelligence.warehouse_dataset_rows WHERE dataset_version_id = '${d.versionId}'`,
        `UPDATE business_intelligence.warehouse_dataset_version_seals SET rows_digest = repeat('b', 64) WHERE dataset_version_id = '${d.versionId}'`,
        `DELETE FROM business_intelligence.warehouse_dataset_version_seals WHERE dataset_version_id = '${d.versionId}'`,
      ]) {
        const e = await refused(asApp(biCtx(w), (query) => query(sql)));
        expect(e?.message, sql).toMatch(/append-only table/);
      }
      // TRUNCATE is verified from the catalog, without sending it (a TRUNCATE requests an ACCESS EXCLUSIVE lock and can convoy parallel test files; the repository's
      // guard requires the shared helper, whose bounded retries cannot succeed while another file keeps reading these tables): the BEFORE TRUNCATE trigger is attached
      // to the append-only function on every new table, and the application role holds no TRUNCATE privilege.
      for (const t of NEW_TABLES) {
        const triggers = await q(`SELECT p.proname, (tg.tgtype & 32) = 32 AS on_truncate FROM pg_trigger tg JOIN pg_proc p ON p.oid = tg.tgfoid WHERE tg.tgrelid = ('business_intelligence.' || $1)::regclass AND tg.tgname = $2`, [t, `forbid_truncate_${t}`]);
        expect(triggers, t).toEqual([{ proname: 'forbid_mutation', on_truncate: true }]);
        const [priv] = (await asApp(biCtx(w), (query) => query(`SELECT has_table_privilege(current_user, $1, 'TRUNCATE') AS can`, [`business_intelligence.${t}`]))).rows;
        expect(priv.can, t).toBe(false);
      }
      expect(await count(d.versionId)).toBe(1);
    });

    it('never touches Business Operations data: the BO publication tables are identical before and after rows are recorded, sealed and read', async () => {
      const w = await createBiWorld(admin, 'I6'); const d = await dataset(w, 2);
      const snapshot = async () => JSON.stringify([await q(`SELECT * FROM business_operations.bo_publication_packages WHERE business_id = $1 ORDER BY id`, [w.businessId]), await q(`SELECT * FROM business_operations.bo_handoff_records WHERE business_id = $1 ORDER BY id`, [w.businessId])]);
      const before = await snapshot();
      await repo.appendRows(biCtx(w), w.businessId, { datasetVersionId: d.versionId, sourceReferenceId: d.sourceId, rows: rowsOf(2) });
      await repo.sealVersion(biCtx(w), w.businessId, d.versionId);
      await repo.readLatestSealed(biCtx(w), w.businessId, d.datasetId, 10);
      expect(await snapshot()).toBe(before);
    });
  });
});
