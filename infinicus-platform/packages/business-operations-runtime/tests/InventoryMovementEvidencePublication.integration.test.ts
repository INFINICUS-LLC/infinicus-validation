/**
 * BO-PUB-DEV-02: durable inventory movement publication evidence against live PostgreSQL under the APPLICATION role (RLS enforced; the administrator connection builds
 * fixtures and tampers only). Ledger rows come from Business Operations' own command executor; headers are real bo_publication_packages rows. The contract is the
 * development candidate of BO-PUB-DEV-01 (PROPOSED, not active); publication here is driven by a TEST authority because the shipped default denies.
 * Requires DATABASE_URL (application role) and ADMIN_DATABASE_URL.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- tests read arbitrary rows */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { BoPublicationEvidenceRepository, closePool, createPool, getPool, withTenantTransaction, type TenantContext } from '@infinicus/database';
import { OperationalCommandExecutor } from '../src/OperationalCommandExecutor.js';
import {
  InventoryMovementEvidencePublicationService, InventoryMovementEvidenceReader, DisabledPublicationAuthority, InventoryMovementEvidenceExtractor,
  canonicalEvidenceBody, verifyInventoryMovementEvidence, type PublicationAuthority,
} from '../src/index.js';
import type { OperationalCommand } from '../src/types.js';
import { deleteMovementsForTenants } from './helpers/movementCleanup.js';
import { truncateRefusal } from './helpers/truncateRefusal.js';

const run = Boolean(process.env.DATABASE_URL && process.env.ADMIN_DATABASE_URL);
const BO = 'business_operations';
const PERIOD = { periodStart: '2026-01-01T00:00:00.000Z', periodEnd: '2026-02-01T00:00:00.000Z' };
const ALLOW: PublicationAuthority = { mayPublish: async () => true };

describe.runIf(run)('BO-PUB-DEV-02 durable publication evidence (live PostgreSQL, application role)', () => {
  let admin: Pool;
  const tenantIds: string[] = [];
  const executor = new OperationalCommandExecutor();
  const repo = new BoPublicationEvidenceRepository();
  const service = new InventoryMovementEvidencePublicationService(ALLOW);
  const reader = new InventoryMovementEvidenceReader();
  let seq = 0;
  const unique = (p: string) => `${p}-${Date.now()}-${++seq}`;
  beforeAll(() => { admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL }); createPool({ connectionString: process.env.DATABASE_URL as string }); });
  afterAll(async () => { await cleanup().catch(() => undefined); await deleteMovementsForTenants(admin, tenantIds).catch(() => undefined); await admin?.end(); await closePool(); });

  /** Test teardown of append-only evidence, by the same privileged pattern as the movement cleanup helper (replica role for ONE transaction; never in production code). */
  async function cleanup() {
    const c = await admin.connect();
    try {
      await c.query('BEGIN'); await c.query("SET LOCAL session_replication_role = 'replica'");
      await c.query(`DELETE FROM ${BO}.bo_publication_evidence_records WHERE tenant_id = ANY($1)`, [tenantIds]); await c.query(`DELETE FROM ${BO}.bo_publication_evidence WHERE tenant_id = ANY($1)`, [tenantIds]);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
  }
  interface World { ctx: TenantContext; tenantId: string; workspaceId: string; businessId: string; sku: string; warehouseCode: string }
  async function world(): Promise<World> {
    const tenantId = randomUUID(); const workspaceId = randomUUID(); const userId = randomUUID(); tenantIds.push(tenantId);
    const slug = `pe${tenantId.slice(0, 8)}`;
    await admin.query(`INSERT INTO tenancy.tenants (id, name, slug, status, plan_code) VALUES ($1,$2,$3,'active','test')`, [tenantId, slug, slug]);
    await admin.query(`INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,$3,$4,'active')`, [workspaceId, tenantId, slug, slug]);
    await admin.query(`INSERT INTO identity.users (id, email, status) VALUES ($1,$2,'active')`, [userId, `${slug}@publication.example.test`]);
    const businessId = (await admin.query(`INSERT INTO platform.businesses (tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,'Publication biz',$3,'active') RETURNING id`, [tenantId, workspaceId, unique('pe-biz')])).rows[0].id as string;
    return { ctx: { tenantId, workspaceId, userId }, tenantId, workspaceId, businessId, ...(await masterData(tenantId, workspaceId, businessId)) };
  }
  async function masterData(tenantId: string, workspaceId: string, businessId: string) {
    const sku = unique('SKU'); const warehouseCode = unique('WH');
    await admin.query(`INSERT INTO platform.inventory_items (tenant_id, workspace_id, business_id, sku, name, status) VALUES ($1,$2,$3,$4,'Item','active')`, [tenantId, workspaceId, businessId, sku]);
    await admin.query(`INSERT INTO platform.warehouses (tenant_id, workspace_id, business_id, warehouse_code, name) VALUES ($1,$2,$3,$4,'WH')`, [tenantId, workspaceId, businessId, warehouseCode]);
    return { sku, warehouseCode };
  }
  async function sibling(w: World): Promise<World> {
    const businessId = (await admin.query(`INSERT INTO platform.businesses (tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,'Sibling',$3,'active') RETURNING id`, [w.tenantId, w.workspaceId, unique('pe-sib')])).rows[0].id as string;
    return { ...w, businessId, ...(await masterData(w.tenantId, w.workspaceId, businessId)) };
  }
  const context = (w: World) => ({ tenantId: w.tenantId, workspaceId: w.workspaceId, businessId: w.businessId, correlationId: randomUUID(), sourceReference: 'pe-1#0', provenanceReference: randomUUID(), idempotencyKey: `dal-to-bo:${randomUUID()}:1:pe-1#0`, actorId: 'actor-1', occurredAt: new Date().toISOString() });
  async function move(w: World, p: Record<string, unknown>) {
    const command = { type: 'record_keyed_inventory_movement', context: context(w), payload: { inventoryItemSku: w.sku, warehouseCode: w.warehouseCode, movementType: 'receipt', quantity: 5, ...p } } as unknown as OperationalCommand;
    await withTenantTransaction(w.ctx, (client) => executor.executeOn(client, w.ctx, command));
  }
  /** Three movements in the period with exact-decimal edge values, two outside it. */
  const seed = async (w: World) => {
    // The widest numeric(18,4) value cannot be written through the command API (a JS number rounds it), so this row is inserted as exact TEXT, like the ledger stores it.
    const [item] = await q(`SELECT id FROM platform.inventory_items WHERE business_id = $1`, [w.businessId]); const [wh] = await q(`SELECT id FROM platform.warehouses WHERE business_id = $1`, [w.businessId]);
    await admin.query(`INSERT INTO ${BO}.inventory_movements (tenant_id, workspace_id, business_id, inventory_item_id, warehouse_id, movement_type, quantity, reference_type, unit_cost, unit_cost_currency, occurred_at, notes)
                       VALUES ($1,$2,$3,$4,$5,'receipt','99999999999999.9999','manual','0.0001','USD','2026-01-10T08:30:00.123456Z','SECRET-NOTE')`, [w.tenantId, w.workspaceId, w.businessId, item.id, wh.id]);
    await move(w, { quantity: 1234.5, unitCost: 12.3456, unitCostCurrency: 'EUR', occurredAt: '2026-01-31T23:59:59.999999Z' });
    await move(w, { quantity: 0.1, movementType: 'issue', occurredAt: '2026-01-11T00:00:00.000001Z' });
    await move(w, { quantity: 99, occurredAt: '2026-02-01T00:00:00.000000Z' });
    await move(w, { quantity: 98, occurredAt: '2025-12-31T23:59:59.999999Z' });
  };
  const header = async (w: World, over: Record<string, unknown> = {}) => {
    const id = randomUUID();
    await admin.query(`INSERT INTO ${BO}.bo_publication_packages (id, tenant_id, workspace_id, business_id, package_code, target_layer, target_block, period_start, period_end, record_count, payload_reference, package_status)
                       VALUES ($1,$2,$3,$4,$5,$6,'BI-16',$7,$8,$9,'{}',$10)`,
      [id, w.tenantId, w.workspaceId, w.businessId, unique('pkg'), over.layer ?? 'business_intelligence', over.start ?? PERIOD.periodStart, over.end ?? PERIOD.periodEnd, over.count ?? 3, over.status ?? 'dispatched']);
    return id;
  };
  const publish = (w: World, headerId: string, over: Record<string, unknown> = {}, svc = service) =>
    svc.publish(w.ctx, { businessId: w.businessId, boPublicationPackageId: headerId, ...PERIOD, correlationId: randomUUID(), ...over } as any);
  const q = async (sql: string, args: unknown[] = []) => (await admin.query(sql, args)).rows;
  const ready = async () => { const w = await world(); await seed(w); const h = await header(w); return { w, h }; };

  describe('publication lifecycle', () => {
    it('stores one verified artifact per header: the stored evidence equals what the extractor built, with exact decimals', async () => {
      const { w, h } = await ready();
      const r = await publish(w, h); expect(r.ok).toBe(true); if (!r.ok) return;
      expect(r.replayed).toBe(false); expect(r.evidence.recordCount).toBe(3); expect(r.evidence.source.boPublicationPackageId).toBe(h);
      const built = await new InventoryMovementEvidenceExtractor().extract(w.ctx, { businessId: w.businessId, boPublicationPackageId: h, ...PERIOD, correlationId: randomUUID() }); if (!built.ok) throw new Error('x');
      expect(r.evidence.digest).toEqual(built.evidence.digest); expect(r.evidence.records).toEqual(built.evidence.records);
      const quantities = r.evidence.records.map((x) => x.quantity).sort();
      expect(quantities).toEqual(['0.1', '1234.5', '99999999999999.9999']); // exact: no float round trip anywhere (a double would give 100000000000000)
      expect(r.evidence.records.map((x) => x.unitCost).filter(Boolean).sort()).toEqual(['0.0001', '12.3456']);
      const row = (await q(`SELECT * FROM ${BO}.bo_publication_evidence WHERE publication_package_id = $1`, [h]))[0];
      expect(row).toMatchObject({ record_count: 3, declared_record_count: 3, digest: r.evidence.digest.value, evidence_id: r.evidence.evidenceId, domain: 'inventory_movements', contract_status: 'PROPOSED_NOT_ACTIVE' });
      expect(row.canonical_body).toBe(canonicalEvidenceBody(r.evidence));
      expect(verifyInventoryMovementEvidence(r.evidence).ok).toBe(true);
    });
    it('replays deterministically: publishing again stores nothing, returns the same evidence, whatever the correlation id', async () => {
      const { w, h } = await ready();
      const a = await publish(w, h); const b = await publish(w, h);
      expect(a.ok && b.ok).toBe(true); if (!a.ok || !b.ok) return;
      expect(b.replayed).toBe(true); expect(b.evidence.evidenceId).toBe(a.evidence.evidenceId); expect(b.evidence.digest).toEqual(a.evidence.digest);
      expect(Number((await q(`SELECT count(*) n FROM ${BO}.bo_publication_evidence WHERE publication_package_id = $1`, [h]))[0].n)).toBe(1);
      expect(Number((await q(`SELECT count(*) n FROM ${BO}.bo_publication_evidence_records e WHERE e.business_id = $1`, [w.businessId]))[0].n)).toBe(3);
    });
    it('is safe under concurrent publication: exactly one artifact is stored, every caller gets the same evidence', async () => {
      const { w, h } = await ready();
      const results = await Promise.all(Array.from({ length: 8 }, () => publish(w, h)));
      expect(results.every((r) => r.ok)).toBe(true);
      const ids = new Set(results.map((r) => (r.ok ? r.evidence.evidenceId : ''))); expect(ids.size).toBe(1);
      expect(results.filter((r) => r.ok && !r.replayed)).toHaveLength(1);
      expect(Number((await q(`SELECT count(*) n FROM ${BO}.bo_publication_evidence WHERE publication_package_id = $1`, [h]))[0].n)).toBe(1);
    });
    it('rejects a conflicting artifact for a header that already has evidence (a later movement changes the ledger, never the published evidence)', async () => {
      const { w, h } = await ready();
      expect((await publish(w, h)).ok).toBe(true);
      await move(w, { quantity: 1, occurredAt: '2026-01-20T00:00:00.000000Z' });
      // the ledger now holds 4 movements for the period, the header still declares 3: the extractor refuses before anything is stored
      expect(await publish(w, h)).toEqual({ ok: false, code: 'HEADER_COUNT_MISMATCH' });
      // and a store-level conflict (a different digest under the same header) is a CONFLICT outcome from the repository, not an overwrite
      const stored = await repo.getByHeader(w.ctx, w.businessId, h); if (!stored) throw new Error('x');
      const otherDigest = 'a'.repeat(64);
      const out = await repo.append(w.ctx, w.businessId, { ...(stored as any), publicationPackageId: h, digest: otherDigest, evidenceId: 'b'.repeat(64), canonicalBody: stored.canonicalBody, records: stored.records });
      expect(out).toEqual({ outcome: 'CONFLICT' });
      expect((await reader.read(w.ctx, w.businessId, h)).ok).toBe(true);
    });
  });

  describe('fail-closed authority', () => {
    it('the default authority denies: nothing is read from the ledger and nothing is stored', async () => {
      const { w, h } = await ready();
      const denied = new InventoryMovementEvidencePublicationService();
      const pool = getPool(); const statements: string[] = []; const originalConnect = pool.connect.bind(pool);
      vi.spyOn(pool, 'connect').mockImplementation((async () => {
        const client = await originalConnect(); const original = client.query.bind(client);
        (client as unknown as { query: unknown }).query = (...args: unknown[]) => { const a0 = args[0] as string | { text: string }; statements.push(typeof a0 === 'string' ? a0 : a0.text); return (original as (...x: unknown[]) => unknown)(...args); };
        return client;
      }) as never);
      try { expect(await publish(w, h, {}, denied)).toEqual({ ok: false, code: 'PUBLICATION_NOT_AUTHORIZED' }); } finally { vi.restoreAllMocks(); }
      expect(statements).toEqual([]);
      expect(await DisabledPublicationAuthority.mayPublish(w.ctx, w.businessId)).toBe(false);
      expect(await q(`SELECT 1 FROM ${BO}.bo_publication_evidence WHERE business_id = $1`, [w.businessId])).toEqual([]);
    });
    it('an authority that answers anything but an explicit true, or that throws, publishes nothing', async () => {
      const { w, h } = await ready();
      for (const answer of ['yes', 1, {}, undefined, null, 'true']) {
        const svc = new InventoryMovementEvidencePublicationService({ mayPublish: async () => answer as unknown as boolean });
        expect(await publish(w, h, {}, svc), String(answer)).toEqual({ ok: false, code: 'PUBLICATION_NOT_AUTHORIZED' });
      }
      const throwing = new InventoryMovementEvidencePublicationService({ mayPublish: async () => { throw new Error('authority down'); } });
      await expect(publish(w, h, {}, throwing)).rejects.toThrow('authority down');
      expect(await q(`SELECT 1 FROM ${BO}.bo_publication_evidence WHERE business_id = $1`, [w.businessId])).toEqual([]);
    });
  });

  describe('header agreement and rejection', () => {
    it.each([
      ['a header that does not exist', async () => randomUUID(), 'HEADER_NOT_FOUND'],
      ['a header addressed to another layer', (w: World) => header(w, { layer: 'simulation' }), 'HEADER_NOT_FOR_BI'],
      ['a header that is still a draft', (w: World) => header(w, { status: 'draft' }), 'HEADER_NOT_PUBLISHED'],
      ['a failed header', (w: World) => header(w, { status: 'failed' }), 'HEADER_NOT_PUBLISHED'],
      ['a header for another period', (w: World) => header(w, { end: '2026-03-01T00:00:00.000Z' }), 'HEADER_PERIOD_MISMATCH'],
      ['a header declaring another record count', (w: World) => header(w, { count: 4 }), 'HEADER_COUNT_MISMATCH'],
    ])('refuses %s, and stores nothing', async (_l, make, expected) => {
      const w = await world(); await seed(w); const id = await (make as (w: World) => Promise<string>)(w);
      expect(await publish(w, id)).toEqual({ ok: false, code: expected });
      expect(await q(`SELECT 1 FROM ${BO}.bo_publication_evidence WHERE business_id = $1`, [w.businessId])).toEqual([]);
    });
    it("refuses another business's header (same workspace) and another tenant's, as not found", async () => {
      const w = await world(); await seed(w); const s = await sibling(w); const other = await world();
      const foreignHeader = await header(s); const otherTenantHeader = await header(other);
      expect(await publish(w, foreignHeader)).toEqual({ ok: false, code: 'HEADER_NOT_FOUND' });
      expect(await publish(w, otherTenantHeader)).toEqual({ ok: false, code: 'HEADER_NOT_FOUND' });
    });
    it('refuses a period that disagrees with the header, a request without a header id, and an unknown business', async () => {
      const { w, h } = await ready();
      expect(await publish(w, h, { periodStart: '2026-01-02T00:00:00.000Z' })).toEqual({ ok: false, code: 'HEADER_PERIOD_MISMATCH' });
      expect(await publish(w, undefined as any)).toEqual({ ok: false, code: 'REQUEST_INVALID' });
      expect(await publish(w, h, { businessId: randomUUID() })).toEqual({ ok: false, code: 'BUSINESS_NOT_FOUND' });
    });
    it('rejects a period containing a historical movement whose currency cannot be proven: the whole publication, nothing stored, nothing invented', async () => {
      const w = await world(); await seed(w); const h = await header(w, { count: 4 });
      const c = await admin.connect();
      try {
        const presence = `SELECT pg_get_constraintdef(oid) AS def, convalidated FROM pg_constraint WHERE conrelid = 'business_operations.inventory_movements'::regclass AND conname = 'inventory_movements_unit_cost_currency_presence'`;
        const original = (await c.query(presence)).rows[0];
        await c.query('BEGIN'); await c.query("SET LOCAL session_replication_role = 'replica'");
        await c.query(`ALTER TABLE ${BO}.inventory_movements DROP CONSTRAINT inventory_movements_unit_cost_currency_presence`);
        const [item] = (await c.query(`SELECT id FROM platform.inventory_items WHERE business_id = $1`, [w.businessId])).rows; const [wh] = (await c.query(`SELECT id FROM platform.warehouses WHERE business_id = $1`, [w.businessId])).rows;
        await c.query(`INSERT INTO ${BO}.inventory_movements (tenant_id, workspace_id, business_id, inventory_item_id, warehouse_id, movement_type, quantity, unit_cost, occurred_at) VALUES ($1,$2,$3,$4,$5,'receipt',1,5,'2026-01-05T00:00:00Z')`, [w.tenantId, w.workspaceId, w.businessId, item.id, wh.id]);
        await c.query(`ALTER TABLE ${BO}.inventory_movements ADD CONSTRAINT inventory_movements_unit_cost_currency_presence CHECK ((unit_cost IS NULL) = (unit_cost_currency IS NULL)) NOT VALID`);
        await c.query('COMMIT'); expect((await c.query(presence)).rows[0]).toEqual(original);
      } finally { c.release(); }
      expect(await publish(w, h)).toEqual({ ok: false, code: 'EVIDENCE_REJECTED' });
      expect(await q(`SELECT 1 FROM ${BO}.bo_publication_evidence WHERE business_id = $1`, [w.businessId])).toEqual([]);
    });
  });

  describe('the database refuses what the service would never send (direct repository use, application role)', () => {
    const input = async () => { const { w, h } = await ready(); const r = await publish(w, h); if (!r.ok) throw new Error('x'); const stored = (await repo.getByHeader(w.ctx, w.businessId, h))!; return { w, h, stored }; };
    // a second header of the same business, to try storing the first one's artifact under it
    it('refuses an artifact stored under a header it does not belong to (identity disagrees with the body the digest covers)', async () => {
      const { w, stored } = await input(); const h2 = await header(w);
      const out = await repo.append(w.ctx, w.businessId, { ...(stored as any), publicationPackageId: h2, records: stored.records });
      expect(out).toEqual({ outcome: 'REFUSED' });
    });
    it('refuses a digest that is not the hash of the stored body, and an evidence id that is not derived from the digest', async () => {
      const { w } = await ready(); const h = await header(w); const r = await new InventoryMovementEvidenceExtractor().extract(w.ctx, { businessId: w.businessId, boPublicationPackageId: h, ...PERIOD, correlationId: randomUUID() });
      if (!r.ok) throw new Error('x'); const e = r.evidence;
      const base = { publicationPackageId: h, contractName: e.contract.name, contractVersion: e.contract.version, contractStatus: e.contract.status, recordSchemaVersion: e.recordSchemaVersion, domain: e.source.domain,
        periodStart: e.source.periodStart, periodEnd: e.source.periodEnd, ordering: e.ordering, canonicalization: e.digest.canonicalization, digestAlgorithm: e.digest.algorithm, recordCount: e.recordCount,
        digest: e.digest.value, evidenceId: e.evidenceId, canonicalBody: canonicalEvidenceBody(e), correlationId: e.provenance.correlationId,
        records: e.records.map((record, i) => ({ position: i + 1, movementId: record.movementId, record: record as any })) };
      expect(await repo.append(w.ctx, w.businessId, { ...base, digest: 'c'.repeat(64) })).toEqual({ outcome: 'REFUSED' });
      expect(await repo.append(w.ctx, w.businessId, { ...base, evidenceId: 'd'.repeat(64) })).toEqual({ outcome: 'REFUSED' });
      expect(await repo.append(w.ctx, w.businessId, { ...base, canonicalBody: base.canonicalBody.replace('"records"', '"records" ') })).toEqual({ outcome: 'REFUSED' });
      // the correct artifact still stores afterwards: the refusals left nothing behind (atomic rollback)
      expect(await q(`SELECT 1 FROM ${BO}.bo_publication_evidence WHERE business_id = $1`, [w.businessId])).toEqual([]);
      expect((await repo.append(w.ctx, w.businessId, base)).outcome).toBe('STORED');
    });
    it('refuses records that differ from the canonical body, a missing record and an extra record - and rolls back everything', async () => {
      const { w } = await ready(); const h = await header(w); const r = await new InventoryMovementEvidenceExtractor().extract(w.ctx, { businessId: w.businessId, boPublicationPackageId: h, ...PERIOD, correlationId: randomUUID() });
      if (!r.ok) throw new Error('x'); const e = r.evidence;
      const base = { publicationPackageId: h, contractName: e.contract.name, contractVersion: e.contract.version, contractStatus: e.contract.status, recordSchemaVersion: e.recordSchemaVersion, domain: e.source.domain,
        periodStart: e.source.periodStart, periodEnd: e.source.periodEnd, ordering: e.ordering, canonicalization: e.digest.canonicalization, digestAlgorithm: e.digest.algorithm, recordCount: e.recordCount,
        digest: e.digest.value, evidenceId: e.evidenceId, canonicalBody: canonicalEvidenceBody(e), correlationId: e.provenance.correlationId };
      const rows = e.records.map((record, i) => ({ position: i + 1, movementId: record.movementId, record: record as any }));
      const altered = rows.map((x, i) => (i === 1 ? { ...x, record: { ...x.record, quantity: '999' } } : x));
      expect(await repo.append(w.ctx, w.businessId, { ...base, records: altered })).toEqual({ outcome: 'REFUSED' });
      expect(await repo.append(w.ctx, w.businessId, { ...base, records: rows.slice(0, 2) })).toEqual({ outcome: 'REFUSED' });
      expect(await repo.append(w.ctx, w.businessId, { ...base, records: [...rows, { position: 4, movementId: randomUUID(), record: { ...rows[0]!.record } }] })).toEqual({ outcome: 'REFUSED' });
      expect(await repo.append(w.ctx, w.businessId, { ...base, records: rows.map((x, i) => ({ ...x, position: i === 2 ? 5 : x.position })) })).toEqual({ outcome: 'REFUSED' });
      expect(await q(`SELECT 1 FROM ${BO}.bo_publication_evidence_records WHERE business_id = $1`, [w.businessId])).toEqual([]);
      expect((await repo.append(w.ctx, w.businessId, { ...base, records: rows })).outcome).toBe('STORED');
    });
    it('refuses a header-agreement violation raised at the database even if the service were bypassed (state, layer, count, period)', async () => {
      const { w } = await ready(); const r = await new InventoryMovementEvidenceExtractor().extract(w.ctx, { businessId: w.businessId, boPublicationPackageId: await header(w), ...PERIOD, correlationId: randomUUID() });
      if (!r.ok) throw new Error('x'); const e = r.evidence;
      const mk = async (over: Record<string, unknown>) => {
        const hh = await header(w, over);
        const body = canonicalEvidenceBody({ ...e, source: { ...e.source, boPublicationPackageId: hh } });
        const ev = { ...e, source: { ...e.source, boPublicationPackageId: hh } };
        // recompute digest/id for the rebound artifact so ONLY the header disagreement can refuse it
        const { computeEvidenceDigest, deriveEvidenceId } = await import('../src/index.js');
        const digest = computeEvidenceDigest(ev); return repo.append(w.ctx, w.businessId, { publicationPackageId: hh, contractName: e.contract.name, contractVersion: e.contract.version, contractStatus: e.contract.status, recordSchemaVersion: e.recordSchemaVersion,
          domain: e.source.domain, periodStart: e.source.periodStart, periodEnd: e.source.periodEnd, ordering: e.ordering, canonicalization: e.digest.canonicalization, digestAlgorithm: e.digest.algorithm, recordCount: e.recordCount,
          digest, evidenceId: deriveEvidenceId(digest), canonicalBody: body, correlationId: e.provenance.correlationId, records: e.records.map((record, i) => ({ position: i + 1, movementId: record.movementId, record: record as any })) });
      };
      expect(await mk({ status: 'draft' })).toEqual({ outcome: 'REFUSED' }); expect(await mk({ layer: 'simulation' })).toEqual({ outcome: 'REFUSED' });
      expect(await mk({ count: 9 })).toEqual({ outcome: 'REFUSED' }); expect(await mk({ end: '2026-03-01T00:00:00.000Z' })).toEqual({ outcome: 'REFUSED' });
      expect((await mk({})).outcome).toBe('STORED');
    });
  });

  describe('database-level identity, uniqueness and forged-but-consistent artifacts', () => {
    const extracted = async (w: World, h: string) => { const r = await new InventoryMovementEvidenceExtractor().extract(w.ctx, { businessId: w.businessId, boPublicationPackageId: h, ...PERIOD, correlationId: randomUUID() }); if (!r.ok) throw new Error('x'); return r.evidence; };
    const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
    /** Re-seals an edited artifact (digest and id re-derived) so ONLY the property under test can be what the database objects to. */
    const reseal = async (a: any) => { const { computeEvidenceDigest, deriveEvidenceId } = await import('../src/index.js'); const d = computeEvidenceDigest(a); a.digest.value = d; a.evidenceId = deriveEvidenceId(d); return a; };
    const columns = (e: any, h: string) => ({ publicationPackageId: h, contractName: e.contract.name, contractVersion: e.contract.version, contractStatus: e.contract.status, recordSchemaVersion: e.recordSchemaVersion, domain: e.source.domain,
      periodStart: e.source.periodStart, periodEnd: e.source.periodEnd, ordering: e.ordering, canonicalization: e.digest.canonicalization, digestAlgorithm: e.digest.algorithm, recordCount: e.recordCount, correlationId: e.provenance.correlationId });
    const rows = (e: any) => e.records.map((record: any, i: number) => ({ position: i + 1, movementId: record.movementId, record }));

    it.each([
      ['another business in the body scope', (a: any) => { a.scope.businessId = randomUUID(); }],
      ['another tenant in the body scope', (a: any) => { a.scope.tenantId = randomUUID(); }],
      ['another period in the body', (a: any) => { a.source.periodStart = '2026-01-01T00:00:00.001Z'; }],
      ['another source domain in the body', (a: any) => { a.source.domain = 'sales'; }],
      ['another schema version in the body', (a: any) => { a.recordSchemaVersion = 'bo.inventory_movement.record.v9'; }],
      ['another contract version in the body', (a: any) => { a.contract.version = '9.9.9'; }],
      ['another ordering in the body', (a: any) => { a.ordering = 'id desc'; }],
      ['another record count in the body', (a: any) => { a.recordCount = 99; }],
    ])('refuses a body that disagrees with the stored identity (%s), even though its digest is valid', async (_l, edit) => {
      const { w } = await ready(); const h = await header(w); const e = await extracted(w, h);
      const forged = await reseal((() => { const a = clone(e); (edit as (x: any) => void)(a); return a; })());
      const { canonicalEvidenceBody: body } = await import('../src/index.js');
      expect(await repo.append(w.ctx, w.businessId, { ...columns(e, h), digest: forged.digest.value, evidenceId: forged.evidenceId, canonicalBody: body(forged), records: rows(e) })).toEqual({ outcome: 'REFUSED' });
      expect(await q(`SELECT 1 FROM ${BO}.bo_publication_evidence WHERE business_id = $1`, [w.businessId])).toEqual([]);
    });
    it('refuses a record whose movement id column differs from the movement id inside the record', async () => {
      const { w } = await ready(); const h = await header(w); const e = await extracted(w, h); const { canonicalEvidenceBody: body } = await import('../src/index.js');
      const bad = rows(e).map((x: any, i: number) => (i === 1 ? { ...x, movementId: randomUUID() } : x));
      expect(await repo.append(w.ctx, w.businessId, { ...columns(e, h), digest: e.digest.value, evidenceId: e.evidenceId, canonicalBody: body(e), records: bad })).toEqual({ outcome: 'REFUSED' });
    });
    it('the database itself allows ONE evidence per header: a second, internally consistent artifact for the same header is refused (unique key), not merely by the repository check', async () => {
      const { w, h } = await ready(); expect((await publish(w, h)).ok).toBe(true);
      const e = await extracted(w, h); const second = await reseal((() => { const a = clone(e); a.records[0].quantity = '7'; return a; })());
      const { canonicalEvidenceBody: body } = await import('../src/index.js'); const c = columns(e, h);
      const attempt = withTenantTransaction(w.ctx, (client) => client.query(
        `INSERT INTO ${BO}.bo_publication_evidence (tenant_id, workspace_id, business_id, publication_package_id, contract_name, contract_version, contract_status, record_schema_version, domain, period_start, period_end, ordering, canonicalization, digest_algorithm, declared_record_count, record_count, digest, evidence_id, canonical_body, correlation_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz,$11::timestamptz,$12,$13,$14,$15,$15,$16,$17,$18,$19)`,
        [w.tenantId, w.workspaceId, w.businessId, h, c.contractName, c.contractVersion, c.contractStatus, c.recordSchemaVersion, c.domain, c.periodStart, c.periodEnd, c.ordering, c.canonicalization, c.digestAlgorithm, c.recordCount, second.digest.value, second.evidenceId, body(second), c.correlationId]));
      await expect(attempt).rejects.toMatchObject({ code: '23505' });
      expect(Number((await q(`SELECT count(*) n FROM ${BO}.bo_publication_evidence WHERE publication_package_id = $1`, [h]))[0].n)).toBe(1);
    });
    it('detects a forged artifact that is INTERNALLY CONSISTENT (valid digest, valid id, records equal body) but breaks the record schema: the verifier, not the checksum, rejects it on read', async () => {
      const { w } = await ready(); const h = await header(w); const e = await extracted(w, h); const { canonicalEvidenceBody: body } = await import('../src/index.js');
      const forged = await reseal((() => { const a = clone(e); (a.records[0] as unknown as Record<string, unknown>).notes = 'SECRET-NOTE-LEAK'; return a; })());
      const c = columns(forged, h); const client = await admin.connect();
      try {
        await client.query('BEGIN'); await client.query("SET LOCAL session_replication_role = 'replica'");
        const ins = await client.query(`INSERT INTO ${BO}.bo_publication_evidence (tenant_id, workspace_id, business_id, publication_package_id, contract_name, contract_version, contract_status, record_schema_version, domain, period_start, period_end, ordering, canonicalization, digest_algorithm, declared_record_count, record_count, digest, evidence_id, canonical_body, correlation_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz,$11::timestamptz,$12,$13,$14,$15,$15,$16,$17,$18,$19) RETURNING id`,
          [w.tenantId, w.workspaceId, w.businessId, h, c.contractName, c.contractVersion, c.contractStatus, c.recordSchemaVersion, c.domain, c.periodStart, c.periodEnd, c.ordering, c.canonicalization, c.digestAlgorithm, c.recordCount, forged.digest.value, forged.evidenceId, body(forged), c.correlationId]);
        await client.query(`INSERT INTO ${BO}.bo_publication_evidence_records (tenant_id, workspace_id, business_id, evidence_row_id, position, movement_id, record)
          SELECT $1, $2, $3, $4, x.position, x.movement_id, x.record FROM jsonb_to_recordset($5::jsonb) AS x(position integer, movement_id uuid, record jsonb)`,
          [w.tenantId, w.workspaceId, w.businessId, ins.rows[0].id, JSON.stringify(rows(forged).map((r: any) => ({ position: r.position, movement_id: r.movementId, record: r.record })))]);
        await client.query('COMMIT');
      } finally { client.release(); }
      const stored = await repo.getByHeader(w.ctx, w.businessId, h); expect(stored).not.toBeNull();
      expect(await reader.read(w.ctx, w.businessId, h)).toEqual({ ok: false, code: 'STORED_EVIDENCE_INTEGRITY' });
    });
  });

  describe('reading and integrity on read', () => {
    it('returns the verified artifact; an unknown header, another business and another tenant are all EVIDENCE_NOT_FOUND', async () => {
      const { w, h } = await ready(); const p = await publish(w, h); if (!p.ok) throw new Error('x');
      const r = await reader.read(w.ctx, w.businessId, h); expect(r.ok).toBe(true); if (r.ok) { expect(r.evidence).toEqual(p.evidence); expect(r.storedAt).toBeInstanceOf(Date); }
      const s = await sibling(w); const other = await world();
      for (const call of [reader.read(w.ctx, w.businessId, randomUUID()), reader.read(w.ctx, s.businessId, h), reader.read(other.ctx, other.businessId, h), reader.read(other.ctx, w.businessId, h), reader.read(w.ctx, 'x', h), reader.read(w.ctx, w.businessId, 'x')]) {
        expect(await call).toEqual({ ok: false, code: 'EVIDENCE_NOT_FOUND' });
      }
    });
    it.each([
      ['a changed record value', `UPDATE ${BO}.bo_publication_evidence_records SET record = jsonb_set(record, '{quantity}', '"999"') WHERE evidence_row_id = $1 AND position = 2`],
      ['a swapped record order', `UPDATE ${BO}.bo_publication_evidence_records SET position = CASE position WHEN 1 THEN 2 WHEN 2 THEN 1 ELSE position END WHERE evidence_row_id = $1 AND position IN (1, 2)`],
      ['a removed record', `DELETE FROM ${BO}.bo_publication_evidence_records WHERE evidence_row_id = $1 AND position = 3`],
      ['a changed digest column', `UPDATE ${BO}.bo_publication_evidence SET digest = repeat('e', 64) WHERE id = $1`],
      ['a changed canonical body', `UPDATE ${BO}.bo_publication_evidence SET canonical_body = replace(canonical_body, '"recordCount"', '"recordCount" ') WHERE id = $1`],
      ['a changed record count', `UPDATE ${BO}.bo_publication_evidence SET record_count = 2, declared_record_count = 2 WHERE id = $1`],
      ['a changed period column', `UPDATE ${BO}.bo_publication_evidence SET period_start = period_start + interval '1 second' WHERE id = $1`],
      ['a changed evidence id', `UPDATE ${BO}.bo_publication_evidence SET evidence_id = repeat('f', 64) WHERE id = $1`],
      ['a record whose movement id column no longer matches its record', `UPDATE ${BO}.bo_publication_evidence_records SET movement_id = gen_random_uuid() WHERE evidence_row_id = $1 AND position = 2`],
    ])('detects %s made behind the application (constraints and triggers suspended by the administrator)', async (_l, sql) => {
      const { w, h } = await ready(); expect((await publish(w, h)).ok).toBe(true);
      const id = (await q(`SELECT id FROM ${BO}.bo_publication_evidence WHERE publication_package_id = $1`, [h]))[0].id;
      const c = await admin.connect();
      try { await c.query('BEGIN'); await c.query("SET LOCAL session_replication_role = 'replica'"); await c.query(sql, [id]); await c.query('COMMIT'); }
      catch (e) { await c.query('ROLLBACK').catch(() => undefined); /* a CHECK constraint refusing the tamper is also a defence */ expect((e as { code?: string }).code, String(e)).toMatch(/^23/); return; }
      finally { c.release(); }
      expect(await reader.read(w.ctx, w.businessId, h)).toEqual({ ok: false, code: 'STORED_EVIDENCE_INTEGRITY' });
      // a replay of the publication against a tampered store must not be reported as a success
      const again = await publish(w, h); expect(again.ok).toBe(false);
    });
  });

  describe('isolation, RLS and append-only', () => {
    it('forces row-level security with a tenant/workspace policy on both tables, composite scope-aware keys, and the append-only triggers', async () => {
      for (const t of ['bo_publication_evidence', 'bo_publication_evidence_records']) {
        const [r] = await q(`SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS forced FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'business_operations' AND c.relname = $1`, [t]);
        expect(r, t).toEqual({ rls: true, forced: true });
        const policies = await q(`SELECT policyname, qual FROM pg_policies WHERE schemaname = 'business_operations' AND tablename = $1`, [t]);
        expect(policies.map((p) => p.policyname), t).toEqual([`${t}_tenant_isolation`]); expect(policies[0].qual).toMatch(/tenant_id = .*app\.tenant_id.*workspace_id = .*app\.workspace_id/s);
        const triggers = (await q(`SELECT tgname FROM pg_trigger WHERE tgrelid = ('business_operations.' || $1)::regclass AND NOT tgisinternal`, [t])).map((x) => x.tgname);
        expect(triggers, t).toEqual(expect.arrayContaining([`forbid_mutation_${t}`, `forbid_truncate_${t}`]));
      }
      const fks = await q(`SELECT conname, array_length(conkey, 1) AS cols FROM pg_constraint WHERE contype = 'f' AND conrelid IN ('business_operations.bo_publication_evidence'::regclass, 'business_operations.bo_publication_evidence_records'::regclass) AND conname LIKE '%\\_fk' ORDER BY conname`);
      expect(fks.map((f) => f.conname)).toEqual(['bo_publication_evidence_header_fk', 'bo_publication_evidence_records_evidence_fk']); for (const f of fks) expect(Number(f.cols)).toBe(4);
      expect((await q(`SELECT filename FROM _migrations WHERE filename LIKE '0224%'`)).map((r) => r.filename)).toEqual(['0224_bo_publication_evidence.sql']);
    });
    it('another tenant or workspace sees no row through SQL, even with the exact ids (RLS), and the application role cannot update, delete or truncate', async () => {
      const { w, h } = await ready(); expect((await publish(w, h)).ok).toBe(true); const other = await world();
      const id = (await q(`SELECT id FROM ${BO}.bo_publication_evidence WHERE publication_package_id = $1`, [h]))[0].id;
      const visible = (ctx: TenantContext, sql: string) => withTenantTransaction(ctx, (c) => c.query(sql, [id]));
      expect((await visible(other.ctx, `SELECT 1 FROM ${BO}.bo_publication_evidence WHERE id = $1`)).rowCount).toBe(0);
      expect((await visible(other.ctx, `SELECT 1 FROM ${BO}.bo_publication_evidence_records WHERE evidence_row_id = $1`)).rowCount).toBe(0);
      expect((await visible({ ...w.ctx, workspaceId: randomUUID() }, `SELECT 1 FROM ${BO}.bo_publication_evidence WHERE id = $1`)).rowCount).toBe(0);
      expect((await visible(w.ctx, `SELECT 1 FROM ${BO}.bo_publication_evidence WHERE id = $1`)).rowCount).toBe(1);
      for (const sql of [`UPDATE ${BO}.bo_publication_evidence SET correlation_id = gen_random_uuid() WHERE id = $1`, `DELETE FROM ${BO}.bo_publication_evidence WHERE id = $1`,
        `UPDATE ${BO}.bo_publication_evidence_records SET movement_id = gen_random_uuid() WHERE evidence_row_id = $1`, `DELETE FROM ${BO}.bo_publication_evidence_records WHERE evidence_row_id = $1`]) {
        await expect(visible(w.ctx, sql), sql).rejects.toThrow(/append-only/);
      }
      for (const t of ['bo_publication_evidence', 'bo_publication_evidence_records']) {
        // the parent is refused by PostgreSQL itself (the records table references it) before the trigger can run; the child is refused by the append-only trigger
        await expect(truncateRefusal(admin, `TRUNCATE business_operations.${t}`), t).rejects.toThrow(/append-only|cannot truncate a table referenced/);
        const priv = await withTenantTransaction(w.ctx, (c) => c.query(`SELECT has_table_privilege(current_user, 'business_operations.${t}', 'TRUNCATE') AS t`));
        expect(priv.rows[0].t, `application role TRUNCATE on ${t}`).toBe(false);
      }
      await expect(withTenantTransaction(w.ctx, (c) => c.query(`INSERT INTO ${BO}.bo_publication_evidence_records (tenant_id, workspace_id, business_id, evidence_row_id, position, movement_id, record) VALUES ($1,$2,$3,$4,4,gen_random_uuid(),'{}')`, [w.tenantId, w.workspaceId, w.businessId, id]))).rejects.toThrow();
    });
    it('a record cannot be inserted into another business\'s evidence, even in the same workspace (composite key)', async () => {
      const { w, h } = await ready(); expect((await publish(w, h)).ok).toBe(true); const s = await sibling(w);
      const id = (await q(`SELECT id FROM ${BO}.bo_publication_evidence WHERE publication_package_id = $1`, [h]))[0].id;
      await expect(withTenantTransaction(s.ctx, (c) => c.query(`INSERT INTO ${BO}.bo_publication_evidence_records (tenant_id, workspace_id, business_id, evidence_row_id, position, movement_id, record) VALUES ($1,$2,$3,$4,1,gen_random_uuid(),'{}')`, [s.tenantId, s.workspaceId, s.businessId, id]))).rejects.toThrow();
    });
  });

  describe('BO / BI boundary and sanitization', () => {
    it('the reader uses only the evidence tables (never the mutable ledger) and only SELECT; the repository writes only the two evidence tables; BO operational records are unchanged', async () => {
      const { w, h } = await ready();
      const bo = async () => JSON.stringify([await q(`SELECT * FROM ${BO}.inventory_movements WHERE business_id = $1 ORDER BY id`, [w.businessId]), await q(`SELECT * FROM ${BO}.bo_publication_packages WHERE business_id = $1 ORDER BY id`, [w.businessId]), await q(`SELECT * FROM ${BO}.inventory_balances WHERE business_id = $1 ORDER BY id`, [w.businessId])]);
      const before = await bo();
      const pool = getPool(); const statements: string[] = []; const originalConnect = pool.connect.bind(pool);
      const spy = vi.spyOn(pool, 'connect').mockImplementation((async () => {
        const client = await originalConnect(); const original = client.query.bind(client);
        (client as unknown as { query: unknown }).query = (...args: unknown[]) => { const a0 = args[0] as string | { text: string }; statements.push(typeof a0 === 'string' ? a0 : a0.text); return (original as (...x: unknown[]) => unknown)(...args); };
        return client;
      }) as never);
      try {
        expect((await publish(w, h)).ok).toBe(true);
        const publishing = statements.splice(0);
        expect((await reader.read(w.ctx, w.businessId, h)).ok).toBe(true);
        const reading = statements.splice(0);
        expect(reading.every((s) => /^\s*(SELECT|BEGIN|COMMIT|ROLLBACK|SET|RESET)\b/i.test(s) || /set_config/i.test(s))).toBe(true);
        expect(reading.join('\n')).not.toMatch(/inventory_movements\b|inventory_balances|bo_publication_packages|business_intelligence/);
        const writes = publishing.filter((s) => /^\s*(INSERT|UPDATE|DELETE|TRUNCATE)\b/i.test(s));
        expect(writes.length).toBeGreaterThan(0);
        for (const s of writes) expect(s).toMatch(/INSERT INTO business_operations\.bo_publication_evidence(_records)?\b/);
        expect(publishing.join('\n')).not.toMatch(/business_intelligence|events\.|audit\./);
      } finally { spy.mockRestore(); }
      expect(await bo()).toBe(before);
    });
    it('every failure is a closed code with no SQL, schema, constraint, id or value text', async () => {
      const { w, h } = await ready(); const h2 = await header(w, { count: 7 });
      const results = [await publish(w, h2), await publish(w, randomUUID()), await publish(w, h, {}, new InventoryMovementEvidencePublicationService()), await reader.read(w.ctx, w.businessId, randomUUID())];
      for (const r of results) { expect(Object.keys(r).sort()).toEqual(['code', 'ok']); expect(JSON.stringify(r)).not.toMatch(/SELECT|INSERT|constraint|violat|business_|tenant|SECRET|[0-9a-f]{8}-[0-9a-f]{4}/i); }
    });
  });
});
