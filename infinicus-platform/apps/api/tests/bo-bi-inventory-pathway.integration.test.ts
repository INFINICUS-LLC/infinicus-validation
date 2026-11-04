/**
 * BI-08-DEV-02: the first authentic BO -> BI record-level data pathway, end to end on real PostgreSQL under the APPLICATION role (the administrator connection builds fixtures, simulates the
 * header transitions and tampers only):
 *
 *   BO ledger (BO's own command executor) -> BO-owned publication evidence (BO-PUB-DEV-02, test authority) -> BI intake + dataset (real chain) -> BI evidence ingestion -> sealed
 *   BI warehouse rows -> BI-10 calculation -> compared with an INDEPENDENT SQL aggregation of the BO ledger.
 *
 * Nothing here is a production fixture path: the only data is real BO ledger rows written for the test; the ingestion service accepts no rows. Publication itself is fail-closed in
 * production (no approving authority exists), so in production no evidence exists to ingest until it is activated. Requires DATABASE_URL and ADMIN_DATABASE_URL.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- tests read arbitrary rows */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { BiWarehouseRowRepository, BiNotFoundError, closePool, createPool, getPool, withTenantTransaction, type TenantContext } from '@infinicus/database';
import {
  InventoryMovementEvidencePublicationService, InventoryMovementEvidenceReader, OperationalCommandExecutor, type OperationalCommand, type PublicationAuthority,
} from '@infinicus/business-operations-runtime';
import {
  BusinessIntelligenceCalculationPersistenceService, BusinessIntelligenceDatasetService, BusinessIntelligenceIntakeService, BusinessIntelligenceInventoryEvidenceIngestionService,
  BusinessIntelligenceMetricCalculationService, BusinessIntelligenceMetricRegistryService, BusinessIntelligenceWarehouseLoadPreparationService, INVENTORY_MOVEMENT_WAREHOUSE_CONTRACT,
  toTransformedRecords, verifyConsumedInventoryEvidence, type InventoryMovementEvidenceSource, type MetricDefinitionInput,
} from '@infinicus/workflow';
import { biCtx, createBiWorld, publishBoPackage, type BiWorld } from '../../../packages/workflow/tests/helpers/boPublicationFixtures.js';
import { deleteMovementsForTenants } from '../../../packages/business-operations-runtime/tests/helpers/movementCleanup.js';

const run = !!process.env.DATABASE_URL && !!process.env.ADMIN_DATABASE_URL;
const BO = 'business_operations'; const BIS = 'business_intelligence';
const PERIOD = { periodStart: '2026-01-01T00:00:00.000Z', periodEnd: '2026-02-01T00:00:00.000Z' };
const ALLOW: PublicationAuthority = { mayPublish: async () => true };

describe.runIf(run)('BI-08-DEV-02: verified BO inventory evidence -> BI warehouse -> seal -> BI-10 (live PostgreSQL, application role)', () => {
  let admin: Pool; const tenantIds: string[] = [];
  const executor = new OperationalCommandExecutor();
  const publication = new InventoryMovementEvidencePublicationService(ALLOW);
  const boReader = new InventoryMovementEvidenceReader();
  const intake = new BusinessIntelligenceIntakeService(); const datasets = new BusinessIntelligenceDatasetService();
  const registry = new BusinessIntelligenceMetricRegistryService(); const warehouse = new BiWarehouseRowRepository();
  const preparation = new BusinessIntelligenceWarehouseLoadPreparationService();
  const calculation = new BusinessIntelligenceMetricCalculationService(undefined, new BusinessIntelligenceCalculationPersistenceService());
  const ingestion = new BusinessIntelligenceInventoryEvidenceIngestionService(boReader);
  let seq = 0; const unique = (p: string) => `${p}-${Date.now()}-${++seq}`;

  beforeAll(() => { createPool({ connectionString: process.env.DATABASE_URL! }); admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL }); });
  afterAll(async () => {
    const c = await admin.connect();
    try { await c.query('BEGIN'); await c.query("SET LOCAL session_replication_role = 'replica'"); await c.query(`DELETE FROM ${BO}.bo_publication_evidence WHERE tenant_id = ANY($1)`, [tenantIds]); await c.query('COMMIT'); }
    catch { await c.query('ROLLBACK').catch(() => undefined); } finally { c.release(); }
    await deleteMovementsForTenants(admin, tenantIds).catch(() => undefined); await admin?.end(); await closePool();
  });

  const q = async (sql: string, args: unknown[] = []) => (await admin.query(sql, args)).rows;
  const tw = (w: BiWorld) => ({ tenantId: w.tenantId, workspaceId: w.workspaceId, businessId: w.businessId });
  async function master(w: BiWorld) {
    const sku = unique('SKU'); const warehouseCode = unique('WH');
    await admin.query(`INSERT INTO platform.inventory_items (tenant_id, workspace_id, business_id, sku, name, status) VALUES ($1,$2,$3,$4,'Item','active')`, [w.tenantId, w.workspaceId, w.businessId, sku]);
    await admin.query(`INSERT INTO platform.warehouses (tenant_id, workspace_id, business_id, warehouse_code, name) VALUES ($1,$2,$3,$4,'WH')`, [w.tenantId, w.workspaceId, w.businessId, warehouseCode]);
    return { sku, warehouseCode };
  }
  async function move(w: BiWorld, m: { sku: string; warehouseCode: string }, p: Record<string, unknown>) {
    const ctx = biCtx(w);
    const command = { type: 'record_keyed_inventory_movement', payload: { inventoryItemSku: m.sku, warehouseCode: m.warehouseCode, movementType: 'receipt', quantity: 5, ...p },
      context: { tenantId: w.tenantId, workspaceId: w.workspaceId, businessId: w.businessId, correlationId: randomUUID(), sourceReference: 'path-1#0', provenanceReference: randomUUID(), idempotencyKey: `dal-to-bo:${randomUUID()}:1:path-1#0`, actorId: 'actor-1', occurredAt: new Date().toISOString() } } as unknown as OperationalCommand;
    await withTenantTransaction(ctx, (client) => executor.executeOn(client, ctx, command));
  }
  /** Three movements in January with exact-decimal edge values (the widest numeric(18,4) value is inserted as exact TEXT: a JS number would round it), two outside the period. */
  async function seedLedger(w: BiWorld) {
    const m = await master(w); const [item] = await q(`SELECT id FROM platform.inventory_items WHERE business_id = $1`, [w.businessId]); const [wh] = await q(`SELECT id FROM platform.warehouses WHERE business_id = $1`, [w.businessId]);
    await admin.query(`INSERT INTO ${BO}.inventory_movements (tenant_id, workspace_id, business_id, inventory_item_id, warehouse_id, movement_type, quantity, reference_type, unit_cost, unit_cost_currency, occurred_at, notes)
                       VALUES ($1,$2,$3,$4,$5,'receipt','99999999999999.9999','manual','0.0001','USD','2026-01-10T08:30:00.123456Z','SECRET-NOTE')`, [w.tenantId, w.workspaceId, w.businessId, item.id, wh.id]);
    await move(w, m, { quantity: 1234.5, unitCost: 12.3456, unitCostCurrency: 'EUR', occurredAt: '2026-01-31T23:59:59.999999Z' });
    await move(w, m, { quantity: 0.1, movementType: 'issue', occurredAt: '2026-01-11T00:00:00.000001Z' });
    await move(w, m, { quantity: 99, occurredAt: '2026-02-01T00:00:00.000000Z' }); // exactly the exclusive end
    await move(w, m, { quantity: 98, occurredAt: '2025-12-31T23:59:59.999999Z' }); // before the period
  }
  const setStatus = (headerId: string, status: string) => admin.query(`UPDATE ${BO}.bo_publication_packages SET package_status = $2 WHERE id = $1`, [headerId, status]);
  /**
   * The whole BO side and the BI intake/dataset: header (ready) -> evidence published -> header dispatched (what a future dispatch would do) -> BI intake -> dataset version.
   * `publish: false` leaves a header with NO evidence.
   */
  async function chain(opts: { publish?: boolean } = {}) {
    const w = await createBiWorld(admin, 'PATH'); tenantIds.push(w.tenantId); await seedLedger(w);
    const p = await publishBoPackage(admin, tw(w), { recordCount: 3, ...PERIOD, targetBlock: 'BI-16' });
    await setStatus(p.packageId, 'ready');
    let evidenceId: string | null = null;
    if (opts.publish !== false) {
      const r = await publication.publish(biCtx(w), { businessId: w.businessId, boPublicationPackageId: p.packageId, ...PERIOD, correlationId: randomUUID() });
      if (!r.ok) throw new Error('publish ' + r.code); evidenceId = r.evidence.evidenceId;
    }
    await setStatus(p.packageId, 'dispatched');
    const out = await intake.ingest(biCtx(w), p.handoff); if (out.outcome !== 'VALIDATED') throw new Error(JSON.stringify(out));
    const d = await datasets.materialize(biCtx(w), out.intakePackageId);
    const [source] = await q(`SELECT id FROM ${BIS}.intelligence_source_references WHERE intake_package_id = $1`, [out.intakePackageId]);
    return { w, headerId: p.packageId, evidenceId, datasetId: d.datasetId, versionId: d.datasetVersionId, sourceId: source.id as string };
  }
  const req = (c: { headerId: string; versionId: string }) => ({ datasetVersionId: c.versionId, boPublicationPackageId: c.headerId });
  const rowsOf = async (versionId: string) => q(`SELECT row_number, row_data FROM ${BIS}.warehouse_dataset_rows WHERE dataset_version_id = $1 ORDER BY row_number`, [versionId]);
  const sealOf = async (versionId: string) => (await q(`SELECT row_count, rows_digest FROM ${BIS}.warehouse_dataset_version_seals WHERE dataset_version_id = $1`, [versionId]))[0];
  const asSource = (read: InventoryMovementEvidenceSource['read']): InventoryMovementEvidenceSource => ({ read });
  const ok = <T extends { ok: boolean }>(r: T) => { if (!r.ok) throw new Error(JSON.stringify(r)); return r as Extract<T, { ok: true }>; };
  const canon = (t: string) => { const [i, f = ''] = t.replace(/^(-?)/, '$1').split('.'); const frac = f.replace(/0+$/, ''); return frac ? `${i}.${frac}` : i; };

  describe('the pathway, end to end', () => {
    it('ingests the BO evidence into sealed BI warehouse rows that are exactly the BO ledger for the period, with exact decimals, source identity and order', async () => {
      const c = await chain(); const r = ok(await ingestion.ingest(biCtx(c.w), c.w.businessId, req(c)));
      expect(r).toMatchObject({ datasetVersionId: c.versionId, boPublicationPackageId: c.headerId, evidenceId: c.evidenceId, recordCount: 3, inserted: 3, replayedRows: 0, sealed: { rowCount: 3, replayed: false } });
      expect(r.sealed.rowsDigest).toMatch(/^[0-9a-f]{64}$/); expect(r.preparedLoadId).toMatch(/^[0-9a-f]{64}$/);
      const rows = await rowsOf(c.versionId); expect(rows.map((x) => x.row_number)).toEqual([1, 2, 3]);
      expect(await sealOf(c.versionId)).toMatchObject({ row_count: 3, rows_digest: r.sealed.rowsDigest });
      // the rows ARE the BO ledger rows of the period (identity, order, values), nothing else: ledger ids and values compared with an independent read of the ledger
      const ledger = await q(`SELECT id, movement_type, quantity::text AS quantity, unit_cost::text AS unit_cost, unit_cost_currency FROM ${BO}.inventory_movements
                               WHERE business_id = $1 AND occurred_at >= $2 AND occurred_at < $3 ORDER BY occurred_at, id`, [c.w.businessId, PERIOD.periodStart, PERIOD.periodEnd]);
      expect(rows.map((x) => x.row_data.__source_record_id)).toEqual(ledger.map((l) => l.id));
      expect(rows.map((x) => x.row_data.quantity)).toEqual(ledger.map((l) => canon(l.quantity)));
      expect(rows.map((x) => x.row_data.movementType)).toEqual(ledger.map((l) => l.movement_type));
      expect(rows.map((x) => x.row_data.unitCost ?? null)).toEqual(ledger.map((l) => (l.unit_cost === null ? null : canon(l.unit_cost))));
      expect(rows.map((x) => x.row_data.unitCostCurrency ?? null)).toEqual(ledger.map((l) => l.unit_cost_currency));
      expect(rows.map((x) => x.row_data.quantity).sort()).toEqual(['0.1', '1234.5', '99999999999999.9999']); // a double would give 100000000000000
      expect(JSON.stringify(rows)).not.toMatch(/SECRET-NOTE|notes|performed/);
      // the ledger rows outside the period never entered
      expect(Number((await q(`SELECT count(*) n FROM ${BIS}.warehouse_dataset_rows WHERE dataset_version_id = $1`, [c.versionId]))[0].n)).toBe(3);
    });

    it('feeds BI-10: the governed metrics calculated over the sealed rows equal an INDEPENDENT aggregation of the BO ledger, exactly', async () => {
      const c = await chain(); ok(await ingestion.ingest(biCtx(c.w), c.w.businessId, req(c)));
      const base = (over: MetricDefinitionInput): MetricDefinitionInput => ({ name: 'M', code: unique('m').replace(/-/g, '_'), warehouseDatasetId: c.datasetId, metricType: 'base', aggregation: 'sum', sourceField: 'quantity', unit: 'units', timeGrain: 'month', governanceStatus: 'approved', formula: { timeField: 'occurredAt' }, ...over });
      const reg = async (i: MetricDefinitionInput) => ((ok(await registry.register(biCtx(c.w), c.w.businessId, i) as any)) as any).metric.metricId as string;
      const received = await reg(base({ code: 'received_qty', filters: [{ field: 'movementType', operator: 'eq', value: 'receipt' }] }));
      const issued = await reg(base({ code: 'issued_qty', filters: [{ field: 'movementType', operator: 'eq', value: 'issue' }] }));
      await reg(base({ code: 'movement_count', aggregation: 'count', sourceField: undefined, unit: 'movements' }));
      await reg(base({ code: 'net_qty', metricType: 'derived', aggregation: undefined, sourceField: undefined, dependencies: [received, issued], formula: { operator: 'subtract', timeField: 'occurredAt' } }));
      const out = ok(await calculation.calculateAndPersist(biCtx(c.w), c.w.businessId, { correlationId: randomUUID() }));
      const byCode = (code: string) => out.run.results.filter((x) => x.metricCode === code).map((x) => ({ bucket: x.group.timeBucket, value: x.value }));
      // independent expectation straight from the BO ledger with PostgreSQL's own exact arithmetic
      const expectSum = async (type: string) => { const [r] = await q(`SELECT sum(quantity)::text AS s FROM ${BO}.inventory_movements WHERE business_id = $1 AND movement_type = $2 AND occurred_at >= $3 AND occurred_at < $4`, [c.w.businessId, type, PERIOD.periodStart, PERIOD.periodEnd]); return canon(r.s); };
      expect(byCode('received_qty')).toEqual([{ bucket: '2026-01', value: await expectSum('receipt') }]);
      expect(byCode('received_qty')[0]!.value).toBe('100000000001234.4999');
      expect(byCode('issued_qty')).toEqual([{ bucket: '2026-01', value: await expectSum('issue') }]); expect(byCode('issued_qty')[0]!.value).toBe('0.1');
      expect(byCode('movement_count')).toEqual([{ bucket: '2026-01', value: '3' }]); expect(byCode('net_qty')).toEqual([{ bucket: '2026-01', value: '100000000001234.3999' }]);
      // the run read the SEALED version this ingestion produced
      expect(out.inputs.map((i) => ({ v: i.datasetVersionId, n: i.rowCount }))).toEqual([{ v: c.versionId, n: 3 }]);
    });

    it('lineage: the rows belong to a dataset version built from the BO publication header whose evidence they came from (one evidence per header)', async () => {
      const c = await chain(); ok(await ingestion.ingest(biCtx(c.w), c.w.businessId, req(c)));
      const [lin] = await q(`SELECT i.bo_publication_package_id AS header, e.evidence_id, e.digest FROM ${BIS}.analytical_dataset_versions v JOIN ${BIS}.intelligence_intake_packages i ON i.id = v.intake_package_id
                               JOIN ${BO}.bo_publication_evidence e ON e.publication_package_id = i.bo_publication_package_id WHERE v.id = $1`, [c.versionId]);
      expect(lin.header).toBe(c.headerId); expect(lin.evidence_id).toBe(c.evidenceId);
      const first = (await rowsOf(c.versionId))[0]!.row_data; expect(first.__source_index).toBe(0); expect(first.tenantId).toBe(c.w.tenantId);
    });
  });

  describe('idempotency, resume and conflict', () => {
    it('running it again confirms the same sealed result and changes nothing; concurrent runs converge on one sealed version', async () => {
      const c = await chain(); const a = ok(await ingestion.ingest(biCtx(c.w), c.w.businessId, req(c))); const before = JSON.stringify(await rowsOf(c.versionId));
      const b = ok(await ingestion.ingest(biCtx(c.w), c.w.businessId, req(c)));
      expect(b).toMatchObject({ inserted: 0, replayedRows: 3, sealed: { rowCount: 3, rowsDigest: a.sealed.rowsDigest, replayed: true } }); expect(JSON.stringify(await rowsOf(c.versionId))).toBe(before);
      const d = await chain(); const results = await Promise.all(Array.from({ length: 6 }, () => ingestion.ingest(biCtx(d.w), d.w.businessId, req(d))));
      expect(results.every((r) => r.ok)).toBe(true); expect(new Set(results.map((r) => (r.ok ? r.sealed.rowsDigest : ''))).size).toBe(1);
      expect(results.reduce((n, r) => n + (r.ok ? r.inserted : 0), 0)).toBe(3); expect((await rowsOf(d.versionId)).length).toBe(3);
    });
    it('resumes after a crash between batches: rows already written are replayed, the rest inserted, then sealed; the result equals an uninterrupted run', async () => {
      const c = await chain(); const e = ok(await boReader.read(biCtx(c.w), c.w.businessId, c.headerId)).evidence;
      const prepared = ok(await preparation.prepare(biCtx(c.w), c.w.businessId, { datasetVersionId: c.versionId, contract: INVENTORY_MOVEMENT_WAREHOUSE_CONTRACT, records: toTransformedRecords(e as any), existing: 'allow' } as any) as any) as any;
      await warehouse.appendRows(biCtx(c.w), c.w.businessId, { ...prepared.load.appendBatches[0], rows: prepared.load.appendBatches[0].rows.slice(0, 2) }); // the "crash": 2 of 3 rows written, nothing sealed
      expect(await sealOf(c.versionId)).toBeUndefined();
      const r = ok(await ingestion.ingest(biCtx(c.w), c.w.businessId, req(c)));
      expect(r).toMatchObject({ inserted: 1, replayedRows: 2, sealed: { rowCount: 3, replayed: false } });
      const clean = await chain(); const cr = ok(await ingestion.ingest(biCtx(clean.w), clean.w.businessId, req(clean)));
      expect((await rowsOf(c.versionId)).map((x) => x.row_data.quantity)).toEqual((await rowsOf(clean.versionId)).map((x) => x.row_data.quantity)); expect(cr.recordCount).toBe(r.recordCount);
    });
    it('a row already recorded with DIFFERENT content is a conflict: nothing is overwritten, nothing is sealed, and BI-10 fails closed', async () => {
      const c = await chain();
      await warehouse.appendRows(biCtx(c.w), c.w.businessId, { datasetVersionId: c.versionId, sourceReferenceId: c.sourceId, rows: [{ rowNumber: 1, data: { forged: true } }] });
      expect(await ingestion.ingest(biCtx(c.w), c.w.businessId, req(c))).toEqual({ ok: false, code: 'INGESTION_CONFLICT' });
      expect((await rowsOf(c.versionId)).map((x) => x.row_data)).toEqual([{ forged: true }]); expect(await sealOf(c.versionId)).toBeUndefined();
      const calc = await calculation.calculateAndPersist(biCtx(c.w), c.w.businessId, { correlationId: randomUUID() }); expect(calc.ok).toBe(false);
    });
    it('a SEALED version re-ingested with different evidence content is a conflict and the sealed rows are untouched', async () => {
      const c = await chain(); const first = ok(await ingestion.ingest(biCtx(c.w), c.w.businessId, req(c))); const before = JSON.stringify(await rowsOf(c.versionId));
      const real = ok(await boReader.read(biCtx(c.w), c.w.businessId, c.headerId)).evidence as any; const altered = JSON.parse(JSON.stringify(real));
      altered.records[0].quantity = '1'; const { consumedDigest, consumedEvidenceId } = await import('@infinicus/workflow'); altered.digest.value = consumedDigest(altered); altered.evidenceId = consumedEvidenceId(altered.digest.value);
      const svc = new BusinessIntelligenceInventoryEvidenceIngestionService(asSource(async () => ({ ok: true, evidence: altered })));
      expect(await svc.ingest(biCtx(c.w), c.w.businessId, req(c))).toEqual({ ok: false, code: 'INGESTION_CONFLICT' });
      expect(JSON.stringify(await rowsOf(c.versionId))).toBe(before); expect((await sealOf(c.versionId)).rows_digest).toBe(first.sealed.rowsDigest);
    });
  });

  describe('fail closed on evidence the BI side must not accept', () => {
    it('no evidence published for the header: nothing is written and BI-10 has no sealed rows', async () => {
      const c = await chain({ publish: false });
      expect(await ingestion.ingest(biCtx(c.w), c.w.businessId, req(c))).toEqual({ ok: false, code: 'EVIDENCE_NOT_FOUND' });
      expect(await rowsOf(c.versionId)).toEqual([]); expect(await sealOf(c.versionId)).toBeUndefined();
    });
    it.each([
      ['an altered quantity (digest not re-sealed)', (e: any) => { e.records[1].quantity = '999'; }, 'EVIDENCE_REJECTED'],
      ['a record of another business', (e: any) => { e.records[0].businessId = randomUUID(); }, 'EVIDENCE_REJECTED'],
      ['a forbidden notes property', (e: any) => { e.records[0].notes = 'free text'; }, 'EVIDENCE_REJECTED'],
      ['a dropped record', (e: any) => { e.records.pop(); e.recordCount = 2; }, 'EVIDENCE_REJECTED'],
      ['another publication header', (e: any) => { e.source.boPublicationPackageId = randomUUID(); }, 'HEADER_MISMATCH'],
    ])('evidence handed over by the port with %s is refused, nothing written', async (_l, tamperIt, expected) => {
      const c = await chain(); const real = ok(await boReader.read(biCtx(c.w), c.w.businessId, c.headerId)).evidence as any; const forged = JSON.parse(JSON.stringify(real)); tamperIt(forged);
      const svc = new BusinessIntelligenceInventoryEvidenceIngestionService(asSource(async () => ({ ok: true, evidence: forged })));
      const r = await svc.ingest(biCtx(c.w), c.w.businessId, req(c)); expect(r.ok === false && r.code).toBe(expected);
      expect(await rowsOf(c.versionId)).toEqual([]); expect(await sealOf(c.versionId)).toBeUndefined();
    });
    it('self-consistent evidence with FEWER records than the dataset version declared is refused by the count agreement (re-sealed so only the count is wrong)', async () => {
      const c = await chain(); const real = ok(await boReader.read(biCtx(c.w), c.w.businessId, c.headerId)).evidence as any; const f = JSON.parse(JSON.stringify(real));
      f.records.pop(); f.recordCount = 2; const { consumedDigest, consumedEvidenceId } = await import('@infinicus/workflow'); f.digest.value = consumedDigest(f); f.evidenceId = consumedEvidenceId(f.digest.value);
      expect(verifyConsumedInventoryEvidence(f, { tenantId: c.w.tenantId, workspaceId: c.w.workspaceId, businessId: c.w.businessId, boPublicationPackageId: c.headerId }).ok).toBe(true);
      const svc = new BusinessIntelligenceInventoryEvidenceIngestionService(asSource(async () => ({ ok: true, evidence: f })));
      expect(await svc.ingest(biCtx(c.w), c.w.businessId, req(c))).toMatchObject({ ok: false, code: 'RECORD_COUNT_MISMATCH' }); expect(await rowsOf(c.versionId)).toEqual([]);
    });
    it('a dataset version built from a DIFFERENT header than the evidence is refused; the evidence of one header never fills another header\'s version', async () => {
      const a = await chain(); const b = await chain();
      // a's evidence (read in a's scope), offered for b's dataset version, under b's header id: scope and header disagree
      const aEvidence = ok(await boReader.read(biCtx(a.w), a.w.businessId, a.headerId)).evidence;
      const svc = new BusinessIntelligenceInventoryEvidenceIngestionService(asSource(async () => ({ ok: true, evidence: aEvidence })));
      expect((await svc.ingest(biCtx(b.w), b.w.businessId, req(b))).ok).toBe(false);
      const wrongVersion = await svc.ingest(biCtx(a.w), a.w.businessId, { datasetVersionId: a.versionId, boPublicationPackageId: b.headerId }); expect(wrongVersion.ok).toBe(false);
      expect(await rowsOf(a.versionId)).toEqual([]); expect(await rowsOf(b.versionId)).toEqual([]);
    });
  });

  describe('isolation', () => {
    it('another tenant, another business of the same workspace and an unknown version cannot ingest this evidence; uniform non-disclosing outcomes and zero writes', async () => {
      const c = await chain(); const other = await createBiWorld(admin, 'OTH'); tenantIds.push(other.tenantId);
      const sib = (await admin.query(`INSERT INTO platform.businesses (tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,'Sibling',$3,'active') RETURNING id`, [c.w.tenantId, c.w.workspaceId, unique('sib')])).rows[0].id as string;
      expect(await ingestion.ingest(biCtx(other), other.businessId, req(c))).toEqual({ ok: false, code: 'EVIDENCE_NOT_FOUND' });
      expect(await ingestion.ingest(biCtx(c.w), sib, req(c))).toEqual({ ok: false, code: 'EVIDENCE_NOT_FOUND' });
      expect(await ingestion.ingest(biCtx(other), c.w.businessId, req(c))).toEqual({ ok: false, code: 'EVIDENCE_NOT_FOUND' });
      // with the evidence port satisfied, an unknown or foreign dataset version is still uniformly "not found"
      const realEvidence = ok(await boReader.read(biCtx(c.w), c.w.businessId, c.headerId)).evidence;
      const svc = new BusinessIntelligenceInventoryEvidenceIngestionService(asSource(async () => ({ ok: true, evidence: realEvidence })));
      for (const version of [randomUUID(), 'not-a-uuid', c.versionId.replace(/.$/, (last) => (last === '0' ? '1' : '0'))]) await expect(svc.ingest(biCtx(c.w), c.w.businessId, { datasetVersionId: version, boPublicationPackageId: c.headerId })).rejects.toBeInstanceOf(BiNotFoundError);
      expect(await rowsOf(c.versionId)).toEqual([]);
    });
  });

  describe('BO / BI boundary', () => {
    it('BI never reads a BO ledger or balance table and never writes a BO table; its writes are the two warehouse tables only; BO records are unchanged', async () => {
      const c = await chain();
      const bo = async () => JSON.stringify([await q(`SELECT * FROM ${BO}.inventory_movements WHERE business_id = $1 ORDER BY id`, [c.w.businessId]), await q(`SELECT * FROM ${BO}.inventory_balances WHERE business_id = $1 ORDER BY id`, [c.w.businessId]),
        await q(`SELECT * FROM ${BO}.bo_publication_packages WHERE business_id = $1 ORDER BY id`, [c.w.businessId]), await q(`SELECT * FROM ${BO}.bo_publication_evidence WHERE business_id = $1 ORDER BY id`, [c.w.businessId]),
        await q(`SELECT count(*) n FROM events.outbox_events WHERE tenant_id = $1`, [c.w.tenantId])]);
      const before = await bo(); const statements: string[] = []; const pool = getPool(); const originalConnect = pool.connect.bind(pool); const patched = new WeakSet<object>(); let sink: string[] | null = statements;
      const spy = vi.spyOn(pool, 'connect').mockImplementation((async () => {
        const client = await originalConnect();
        if (!patched.has(client)) { patched.add(client); const original = client.query.bind(client); (client as unknown as { query: unknown }).query = (...args: unknown[]) => { const a0 = args[0] as string | { text: string }; sink?.push(typeof a0 === 'string' ? a0 : a0.text); return (original as (...x: unknown[]) => unknown)(...args); }; }
        return client;
      }) as never);
      try { ok(await ingestion.ingest(biCtx(c.w), c.w.businessId, req(c))); } finally { spy.mockRestore(); sink = null; }
      const sql = statements.map((s) => s.replace(/\s+/g, ' '));
      expect(sql.join('\n')).not.toMatch(/inventory_movements|inventory_balances/);
      const boTables = new Set(sql.flatMap((s) => s.match(/business_operations\.[a-z_]+/g) ?? [])); expect([...boTables].sort()).toEqual(['business_operations.bo_publication_evidence', 'business_operations.bo_publication_packages']);
      for (const s of sql.filter((x) => /business_operations\./.test(x))) expect(s).toMatch(/^\s*SELECT\b/);
      const writes = sql.filter((s) => /^\s*(INSERT|UPDATE|DELETE|TRUNCATE)\b/i.test(s));
      expect(writes.length).toBeGreaterThan(0); for (const s of writes) expect(s).toMatch(/^\s*INSERT INTO business_intelligence\.(warehouse_dataset_rows|warehouse_dataset_version_seals)\b/);
      expect(sql.join('\n')).not.toMatch(/events\.|audit\./); expect(await bo()).toBe(before);
    });
    it('every outcome is a closed code with no SQL, schema, constraint, identifier or value text', async () => {
      const c = await chain({ publish: false }); const none = await ingestion.ingest(biCtx(c.w), c.w.businessId, req(c));
      const d = await chain(); await warehouse.appendRows(biCtx(d.w), d.w.businessId, { datasetVersionId: d.versionId, sourceReferenceId: d.sourceId, rows: [{ rowNumber: 1, data: { forged: 'SECRET-VALUE' } }] });
      const conflict = await ingestion.ingest(biCtx(d.w), d.w.businessId, req(d));
      for (const r of [none, conflict]) { expect(r.ok).toBe(false); expect(JSON.stringify(r)).not.toMatch(/SELECT|INSERT|constraint|violat|business_|tenant|SECRET|[0-9a-f]{8}-[0-9a-f]{4}/i); }
    });
  });
});
