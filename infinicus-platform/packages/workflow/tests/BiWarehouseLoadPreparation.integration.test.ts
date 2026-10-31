/**
 * BI-08-DEV-01: warehouse load PREPARATION against live PostgreSQL under the APPLICATION role (RLS enforced; the administrator connection builds fixtures and tampers only).
 * The BO publication package, the BI intake and the dataset version are the REAL chain (BO package -> BI intake -> dataset materialization). The TRANSFORMED RECORDS are
 * DEVELOPMENT TEST DATA written here: no authoritative record-level BO publication exists, which is why the service never writes. The compatibility test stores the prepared
 * batches through the real repository ONLY to prove the format; production code has no such path. Requires DATABASE_URL and ADMIN_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { createPool, closePool, getPool, BiWarehouseRowRepository, BiNotFoundError as NotFoundError, WAREHOUSE_APPEND_BATCH_MAX } from '@infinicus/database';
import { BusinessIntelligenceIntakeService } from '../src/BusinessIntelligenceIntakeService.js';
import { BusinessIntelligenceDatasetService } from '../src/BusinessIntelligenceDatasetService.js';
import { BusinessIntelligenceWarehouseLoadPreparationService } from '../src/BusinessIntelligenceWarehouseLoadPreparationService.js';
import { PostgresWarehouseRowSource } from '../src/PostgresWarehouseRowSource.js';
import { SOURCE_RECORD_ID_KEY, type TransformedRecord, type WarehouseDatasetContract } from '../src/index.js';
import { biCtx, createBiWorld, publishBoPackage, type BiWorld } from './helpers/boPublicationFixtures.js';

const run = !!process.env.DATABASE_URL && !!process.env.ADMIN_DATABASE_URL;

const contract: WarehouseDatasetContract = {
  datasetContractId: 'dev-contract-1', datasetType: 'fact', loadMode: 'append', primaryKeyFields: ['orderId'], partitionFields: ['region'],
  fields: [
    { name: 'orderId', dataType: 'string', required: true },
    { name: 'region', dataType: 'string', required: true },
    { name: 'amount', dataType: 'currency', required: true, minimum: 0 },
    { name: 'date', dataType: 'datetime', required: true },
  ],
};
const records = (n: number): TransformedRecord[] => Array.from({ length: n }, (_, i) => ({
  sourceRecordId: `dev-src-${i + 1}`, sourceIndex: i, fields: { orderId: `o-${i + 1}`, region: i % 2 ? 'north' : 'south', amount: (i + 1) * 10.5, date: '2026-01-15T00:00:00Z' },
}));

describe.runIf(run)('BI-08-DEV-01 warehouse load preparation (live PostgreSQL, application role)', () => {
  let admin: Pool;
  const intake = new BusinessIntelligenceIntakeService();
  const datasets = new BusinessIntelligenceDatasetService();
  const service = new BusinessIntelligenceWarehouseLoadPreparationService();
  const warehouse = new BiWarehouseRowRepository();
  beforeAll(() => { createPool({ connectionString: process.env.DATABASE_URL! }); admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL }); });
  afterAll(async () => { await admin?.end(); await closePool(); });

  const q = async (sql: string, args: unknown[] = []) => (await admin.query(sql, args)).rows;
  async function dataset(w: BiWorld, recordCount = 3) {
    const p = await publishBoPackage(admin, w, { recordCount });
    const out = await intake.ingest(biCtx(w), p.handoff);
    if (out.outcome !== 'VALIDATED') throw new Error(JSON.stringify(out));
    const d = await datasets.materialize(biCtx(w), out.intakePackageId);
    const [source] = await q(`SELECT id FROM business_intelligence.intelligence_source_references WHERE intake_package_id = $1`, [out.intakePackageId]);
    return { datasetId: d.datasetId, versionId: d.datasetVersionId, sourceId: source.id as string, intakeId: out.intakePackageId as string, boPackageId: p.packageId };
  }
  const prep = (w: BiWorld, versionId: string, recs: TransformedRecord[] = records(3), c: WarehouseDatasetContract = contract) =>
    service.prepare(biCtx(w), w.businessId, { datasetVersionId: versionId, contract: c, records: recs });
  const code = (r: Awaited<ReturnType<typeof prep>>) => (r.ok ? 'OK' : r.code);
  const tamper = async (sql: string, args: unknown[]) => { const c = await admin.connect(); try { await c.query('BEGIN'); await c.query("SET LOCAL session_replication_role = 'replica'"); await c.query(sql, args); await c.query('COMMIT'); } finally { c.release(); } };
  const refused = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return e; } };

  describe('a verified chain', () => {
    it('prepares the load: identities from the verified chain, rows in the exact AppendRowsInput format, nothing written', async () => {
      const w = await createBiWorld(admin, 'P1'); const d = await dataset(w);
      const before = await q(`SELECT (SELECT count(*) FROM business_intelligence.warehouse_dataset_rows) r, (SELECT count(*) FROM business_intelligence.warehouse_dataset_version_seals) s`);
      const r = await prep(w, d.versionId);
      expect(r.ok).toBe(true); if (!r.ok) return;
      expect(r.load).toMatchObject({ datasetId: d.datasetId, datasetVersionId: d.versionId, intakePackageId: d.intakeId, boPublicationPackageId: d.boPackageId, sourceReferenceId: d.sourceId, declaredRecordCount: 3, recordCount: 3 });
      expect(r.load.preparedLoadId).toMatch(/^[0-9a-f]{64}$/);
      expect(r.load.appendBatches).toHaveLength(1);
      expect(r.load.appendBatches[0]).toMatchObject({ datasetVersionId: d.versionId, sourceReferenceId: d.sourceId });
      expect(r.load.appendBatches[0]!.rows.map((x) => x.rowNumber)).toEqual([1, 2, 3]);
      expect(r.load.appendBatches[0]!.rows[0]!.data[SOURCE_RECORD_ID_KEY]).toBe('dev-src-1');
      expect(await q(`SELECT (SELECT count(*) FROM business_intelligence.warehouse_dataset_rows) r, (SELECT count(*) FROM business_intelligence.warehouse_dataset_version_seals) s`)).toEqual(before);
    });

    it('is repeatable: the same chain and records give the same prepared load id and fingerprint; different records give different ones', async () => {
      const w = await createBiWorld(admin, 'P2'); const d = await dataset(w);
      const a = await prep(w, d.versionId); const b = await prep(w, d.versionId);
      const changed = await prep(w, d.versionId, records(3).map((x, i) => (i === 2 ? { ...x, fields: { ...x.fields, amount: 1 } } : x)));
      expect(a.ok && b.ok && changed.ok).toBe(true); if (!a.ok || !b.ok || !changed.ok) return;
      expect(b.load).toEqual(a.load);
      expect(changed.load.preparedLoadId).not.toBe(a.load.preparedLoadId);
      expect(changed.load.rowsFingerprint).not.toBe(a.load.rowsFingerprint);
      // another version (another BO package) gives another load id for identical records
      const w2 = await createBiWorld(admin, 'P2b'); const d2 = await dataset(w2);
      const other = await prep(w2, d2.versionId); if (!other.ok) throw new Error('x');
      expect(other.load.rowsFingerprint).toBe(a.load.rowsFingerprint);
      expect(other.load.preparedLoadId).not.toBe(a.load.preparedLoadId);
    });

    it('is compatible with the warehouse row repository and BI-10: the prepared batches append, seal against the BO-declared count, and are read back sealed with their source identity', async () => {
      const w = await createBiWorld(admin, 'P3'); const d = await dataset(w);
      const r = await prep(w, d.versionId); if (!r.ok) throw new Error('x');
      for (const batch of r.load.appendBatches) expect(await warehouse.appendRows(biCtx(w), w.businessId, batch)).toEqual({ inserted: batch.rows.length, replayed: 0 });
      const seal = await warehouse.sealVersion(biCtx(w), w.businessId, d.versionId);
      expect(seal.rowCount).toBe(3);
      const source = new PostgresWarehouseRowSource(biCtx(w));
      const rows = await source.rows({ tenantId: w.tenantId, workspaceId: w.workspaceId, businessId: w.businessId } as never, d.datasetId);
      expect(rows).toHaveLength(3);
      expect(rows.map((x) => x[SOURCE_RECORD_ID_KEY])).toEqual(['dev-src-1', 'dev-src-2', 'dev-src-3']);
      expect(rows[2]).toMatchObject({ orderId: 'o-3', amount: 31.5 });
      // a replay of the same append is idempotent, and once sealed the version is refused for preparation
      expect(await warehouse.appendRows(biCtx(w), w.businessId, r.load.appendBatches[0]!)).toEqual({ inserted: 0, replayed: 3 });
      expect(code(await prep(w, d.versionId))).toBe('TARGET_ALREADY_SEALED');
    });

    it('splits a large load at the repository batch bound without losing or reordering a row', async () => {
      const w = await createBiWorld(admin, 'P4'); const n = WAREHOUSE_APPEND_BATCH_MAX + 5; const d = await dataset(w, n);
      const r = await prep(w, d.versionId, records(n)); if (!r.ok) throw new Error(JSON.stringify(r));
      expect(r.load.appendBatches.map((b) => b.rows.length)).toEqual([WAREHOUSE_APPEND_BATCH_MAX, 5]);
      const all = r.load.appendBatches.flatMap((b) => b.rows.map((x) => x.rowNumber));
      expect(all).toEqual(Array.from({ length: n }, (_, i) => i + 1));
    });
  });

  describe('record-count agreement (BO, BI intake, offered records)', () => {
    it('refuses fewer or more records than were declared, before validating them', async () => {
      const w = await createBiWorld(admin, 'C1'); const d = await dataset(w, 3);
      expect(code(await prep(w, d.versionId, records(2)))).toBe('RECORD_COUNT_MISMATCH');
      expect(code(await prep(w, d.versionId, records(4)))).toBe('RECORD_COUNT_MISMATCH');
      expect(code(await prep(w, d.versionId, []))).toBe('NO_RECORDS');
    });
    it('refuses when BO and the BI intake record disagree about the count', async () => {
      const w = await createBiWorld(admin, 'C2'); const d = await dataset(w, 3);
      await tamper(`UPDATE business_operations.bo_publication_packages SET record_count = 4 WHERE id = $1`, [d.boPackageId]);
      expect(code(await prep(w, d.versionId, records(3)))).toBe('DECLARED_COUNT_CONFLICT');
      expect(code(await prep(w, d.versionId, records(4)))).toBe('DECLARED_COUNT_CONFLICT');
    });
  });

  describe('source verification', () => {
    it.each([
      ['a BO package that failed', `UPDATE business_operations.bo_publication_packages SET package_status = 'failed' WHERE id = $1`, 'SOURCE_NOT_PUBLISHED'],
      ['a BO package that is still a draft', `UPDATE business_operations.bo_publication_packages SET package_status = 'draft' WHERE id = $1`, 'SOURCE_NOT_PUBLISHED'],
      ['a BO package addressed to another layer', `UPDATE business_operations.bo_publication_packages SET target_layer = 'simulation' WHERE id = $1`, 'SOURCE_NOT_FOR_BI'],
    ])('refuses %s', async (_l, sql, expected) => {
      const w = await createBiWorld(admin, 'S1'); const d = await dataset(w);
      await tamper(sql, [d.boPackageId]);
      expect(code(await prep(w, d.versionId))).toBe(expected);
    });
    it('refuses a version whose intake is not processed, a version that is not published, and a source reference that is missing or ambiguous', async () => {
      const w = await createBiWorld(admin, 'S2'); const d = await dataset(w);
      await tamper(`UPDATE business_intelligence.intelligence_intake_packages SET status = 'rejected' WHERE id = $1`, [d.intakeId]);
      expect(code(await prep(w, d.versionId))).toBe('INTAKE_NOT_PROCESSED');
      const w2 = await createBiWorld(admin, 'S2b'); const d2 = await dataset(w2);
      await tamper(`UPDATE business_intelligence.analytical_dataset_versions SET publication_status = 'draft' WHERE id = $1`, [d2.versionId]);
      expect(code(await prep(w2, d2.versionId))).toBe('TARGET_NOT_PUBLISHED');
      const w3 = await createBiWorld(admin, 'S2c'); const d3 = await dataset(w3);
      const deleted = await tamper(`DELETE FROM business_intelligence.intelligence_source_references WHERE id = $1`, [d3.sourceId]).then(() => true, () => false);
      const remaining = Number((await q(`SELECT count(*) n FROM business_intelligence.intelligence_source_references WHERE intake_package_id = $1`, [d3.intakeId]))[0].n);
      expect(remaining).toBe(deleted ? 0 : 1);
      // with no source reference the version has no verifiable source: refused. (If the store refuses the delete, the chain is intact and must still prepare.)
      expect(code(await prep(w3, d3.versionId))).toBe(deleted ? 'SOURCE_REFERENCE_AMBIGUOUS' : 'OK');
    });
    it('prevents duplicate processing: a version that already holds rows is refused (nothing is appended twice)', async () => {
      const w = await createBiWorld(admin, 'S3'); const d = await dataset(w);
      await warehouse.appendRows(biCtx(w), w.businessId, { datasetVersionId: d.versionId, sourceReferenceId: d.sourceId, rows: [{ rowNumber: 1, data: { a: 1 } }] });
      expect(code(await prep(w, d.versionId))).toBe('TARGET_HAS_ROWS');
    });
  });

  describe('validation through the service', () => {
    it('refuses a bad record and a bad contract with sanitized, value-free issues', async () => {
      const w = await createBiWorld(admin, 'V1'); const d = await dataset(w);
      const bad = records(3); bad[1] = { ...bad[1]!, fields: { ...bad[1]!.fields, amount: 'SECRET-VALUE' } };
      const r = await prep(w, d.versionId, bad);
      expect(r).toMatchObject({ ok: false, code: 'RECORDS_REJECTED', issueCount: 1, issues: [{ code: 'FIELD_TYPE', recordIndex: 1, field: 'amount' }] });
      expect(JSON.stringify(r)).not.toMatch(/SECRET|tenant|workspace|SELECT|business_/i);
      expect(code(await prep(w, d.versionId, records(3), { ...contract, loadMode: 'upsert' }))).toBe('LOAD_MODE_UNSUPPORTED');
      expect(code(await prep(w, d.versionId, records(3), { ...contract, primaryKeyFields: [] }))).toBe('CONTRACT_INVALID');
    });
    it('does not trust a claim carried in the records: identity, ids and counts offered by the caller change nothing about the verified target', async () => {
      const w = await createBiWorld(admin, 'V2'); const d = await dataset(w);
      const forged = records(3).map((x) => ({ ...x, tenantId: w.tenantId, datasetVersionId: 'forged' }) as unknown as TransformedRecord);
      expect(code(await prep(w, d.versionId, forged))).toBe('RECORDS_REJECTED');
    });
  });

  describe('isolation', () => {
    it('another business, workspace or tenant cannot prepare a load for this version: not found, identical to a version that does not exist', async () => {
      const a = await createBiWorld(admin, 'I1'); const b = await createBiWorld(admin, 'I2'); const d = await dataset(a);
      const foreign = await refused(service.prepare(biCtx(b), b.businessId, { datasetVersionId: d.versionId, contract, records: records(3) }));
      const missing = await refused(service.prepare(biCtx(b), b.businessId, { datasetVersionId: '00000000-0000-4000-8000-000000000000', contract, records: records(3) }));
      expect(foreign).toBeInstanceOf(NotFoundError); expect(missing).toBeInstanceOf(NotFoundError);
      expect((foreign as Error).message.replace(d.versionId, 'X')).toBe((missing as Error).message.replace('00000000-0000-4000-8000-000000000000', 'X'));
      // the owner's workspace with another business id inside it
      const wrongBusiness = await refused(service.prepare(biCtx(a), b.businessId, { datasetVersionId: d.versionId, contract, records: records(3) }));
      expect(wrongBusiness).toBeInstanceOf(NotFoundError);
      for (const bad of ['not-a-uuid', '', null, 5]) expect(await refused(service.prepare(biCtx(a), a.businessId, { datasetVersionId: bad as never, contract, records: records(3) })), String(bad)).toBeInstanceOf(NotFoundError);
    });
  });

  describe('BO / BI boundary', () => {
    it('reads only the dataset chain and the BO publication package header, writes nothing, and leaves every BO record unchanged', async () => {
      const w = await createBiWorld(admin, 'B1'); const d = await dataset(w);
      const bo = async () => JSON.stringify([await q(`SELECT * FROM business_operations.bo_publication_packages WHERE business_id = $1 ORDER BY id`, [w.businessId]), await q(`SELECT * FROM business_operations.bo_handoff_records WHERE business_id = $1 ORDER BY id`, [w.businessId])]);
      const biState = async () => JSON.stringify(await q(`SELECT (SELECT count(*) FROM business_intelligence.warehouse_dataset_rows WHERE business_id = $1) r, (SELECT count(*) FROM business_intelligence.analytical_dataset_versions WHERE business_id = $1) v, (SELECT count(*) FROM business_intelligence.intelligence_intake_packages WHERE business_id = $1) i`, [w.businessId]));
      const boBefore = await bo(); const biBefore = await biState();
      const pool = getPool(); const statements: string[] = []; const originalConnect = pool.connect.bind(pool);
      vi.spyOn(pool, 'connect').mockImplementation((async () => {
        const client = await originalConnect(); const original = client.query.bind(client);
        (client as unknown as { query: unknown }).query = (...args: unknown[]) => { const a0 = args[0] as string | { text: string }; statements.push(typeof a0 === 'string' ? a0 : a0.text); return (original as (...x: unknown[]) => unknown)(...args); };
        return client;
      }) as never);
      try { expect((await prep(w, d.versionId)).ok).toBe(true); expect(code(await prep(w, d.versionId, records(2)))).toBe('RECORD_COUNT_MISMATCH'); } finally { vi.restoreAllMocks(); }
      expect(statements.filter((s) => /^\s*(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE)\b/i.test(s))).toEqual([]);
      const touchingBo = statements.filter((s) => /business_operations/i.test(s));
      expect(touchingBo.length).toBeGreaterThan(0);
      for (const s of touchingBo) { expect(s).toMatch(/^\s*SELECT\b/); expect(s.match(/business_operations\.[a-z_]+/gi)!.every((t) => t === 'business_operations.bo_publication_packages')).toBe(true); }
      expect(await bo()).toBe(boBefore); expect(await biState()).toBe(biBefore);
    });
  });
});
