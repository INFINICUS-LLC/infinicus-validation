/**
 * BO-PUB-DEV-02 (R4/D3 association model) against live PostgreSQL under the APPLICATION role (RLS enforced; the administrator connection builds fixtures, holds locks and
 * tampers only). Ledger rows come from Business Operations' own command executor; headers are real bo_publication_packages rows. The contract is the development candidate
 * of BO-PUB-DEV-01 (PROPOSED, not active); publication here is driven by a TEST authority because the shipped default denies.
 * The describe blocks follow the D3 acceptance matrix (docs/production-readiness/BO_PUB_DEV_02A_R4_D3_INACTIVE_PERSISTENCE.md).
 * Requires DATABASE_URL (application role) and ADMIN_DATABASE_URL; the header table must have FORCE ROW LEVEL SECURITY (CI sets it; see scripts/setup-r4-ci-force-rls.sh).
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- tests read arbitrary rows */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { BoPublicationEvidenceRepository, closePool, createPool, getPool, withTenantTransaction, type AppendPublicationEvidenceInput, type TenantContext } from '@infinicus/database';
import { OperationalCommandExecutor } from '../src/OperationalCommandExecutor.js';
import {
  InventoryMovementEvidencePublicationService, InventoryMovementEvidenceReader, DisabledPublicationAuthority, InventoryMovementEvidenceExtractor,
  canonicalEvidenceBody, computeEvidenceDigest, deriveEvidenceId, verifyInventoryMovementEvidence, type InventoryMovementEvidence, type PublicationAuthority,
} from '../src/index.js';
import type { OperationalCommand } from '../src/types.js';
import { deleteMovementsForTenants } from './helpers/movementCleanup.js';
import { truncateRefusal } from './helpers/truncateRefusal.js';

const run = Boolean(process.env.DATABASE_URL && process.env.ADMIN_DATABASE_URL);
const BO = 'business_operations';
const PERIOD = { periodStart: '2026-01-01T00:00:00.000Z', periodEnd: '2026-02-01T00:00:00.000Z' };
const ALLOW: PublicationAuthority = { mayPublish: async () => true };
const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');
const INSERT_COLUMNS = `tenant_id, workspace_id, business_id, publication_package_id, period_start, period_end, contract_name, contract_version, contract_status, record_schema_version, domain, ordering, canonicalization, digest_algorithm, record_count, digest, evidence_id, canonical_body, correlation_id`;
const INSERT_VALUES = `$1,$2,$3,$4,$5::timestamptz,$6::timestamptz,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19`;

describe.runIf(run)('BO-PUB-DEV-02 durable publication evidence, D3 association model (live PostgreSQL, application role)', () => {
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

  /** Test teardown of append-only evidence by the same privileged pattern as the movement cleanup helper (replica role for ONE transaction; never in production code). */
  async function cleanup() {
    const c = await admin.connect();
    try { await c.query('BEGIN'); await c.query("SET LOCAL session_replication_role = 'replica'"); await c.query(`DELETE FROM ${BO}.bo_publication_evidence WHERE tenant_id = ANY($1)`, [tenantIds]); await c.query('COMMIT'); }
    catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
  }
  /** Runs SQL as the administrator with row triggers suspended (replica role), for tampering only. */
  const tamper = async (sql: string, args: unknown[] = []) => {
    const c = await admin.connect();
    try { await c.query('BEGIN'); await c.query("SET LOCAL session_replication_role = 'replica'"); await c.query(sql, args); await c.query('COMMIT'); } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
  };

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
  const q = async (sql: string, args: unknown[] = []) => (await admin.query(sql, args)).rows;
  /** Three movements in the period with exact-decimal edge values, two outside it. */
  const seed = async (w: World) => {
    // The widest numeric(18,4) value cannot be written through the command API (a JS number rounds it), so this row is inserted as exact TEXT, like the ledger stores it.
    const [item] = await q(`SELECT id FROM platform.inventory_items WHERE business_id = $1`, [w.businessId]); const [wh] = await q(`SELECT id FROM platform.warehouses WHERE business_id = $1`, [w.businessId]);
    await admin.query(`INSERT INTO ${BO}.inventory_movements (tenant_id, workspace_id, business_id, inventory_item_id, warehouse_id, movement_type, quantity, reference_type, unit_cost, unit_cost_currency, occurred_at, notes)
                       VALUES ($1,$2,$3,$4,$5,'receipt','99999999999999.9999','manual','0.0001','USD','2026-01-10T08:30:00.123456Z','SECRET-NOTE')`, [w.tenantId, w.workspaceId, w.businessId, item.id, wh.id]);
    await move(w, { quantity: 1234.5, unitCost: 12.3456, unitCostCurrency: 'EUR', occurredAt: '2026-01-31T23:59:59.999999Z' });
    await move(w, { quantity: 0.1, movementType: 'issue', occurredAt: '2026-01-11T00:00:00.000001Z' });
    await move(w, { quantity: 99, occurredAt: '2026-02-01T00:00:00.000000Z' }); // exactly the (exclusive) end
    await move(w, { quantity: 98, occurredAt: '2025-12-31T23:59:59.999999Z' }); // before the period
  };
  const header = async (w: World, over: Record<string, unknown> = {}) => {
    const id = randomUUID();
    await admin.query(`INSERT INTO ${BO}.bo_publication_packages (id, tenant_id, workspace_id, business_id, package_code, target_layer, target_block, period_start, period_end, record_count, payload_reference, package_status)
                       VALUES ($1,$2,$3,$4,$5,$6,'BI-16',$7,$8,$9,'{}',$10)`,
      [id, w.tenantId, w.workspaceId, w.businessId, unique('pkg'), over.layer ?? 'business_intelligence', over.start ?? PERIOD.periodStart, over.end ?? PERIOD.periodEnd, over.count ?? 3, over.status ?? 'ready']);
    return id;
  };
  const publish = (w: World, headerId: string, over: Record<string, unknown> = {}, svc = service) =>
    svc.publish(w.ctx, { businessId: w.businessId, boPublicationPackageId: headerId, ...PERIOD, correlationId: randomUUID(), ...over } as any);
  const ready = async () => { const w = await world(); await seed(w); const h = await header(w); return { w, h }; };
  const extracted = async (w: World, h: string): Promise<InventoryMovementEvidence> => { const r = await new InventoryMovementEvidenceExtractor().extract(w.ctx, { businessId: w.businessId, boPublicationPackageId: h, ...PERIOD, correlationId: randomUUID() }); if (!r.ok) throw new Error('extract ' + r.code); return r.evidence; };
  const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
  /** An edited artifact re-sealed (digest and id re-derived) so ONLY the property under test can be what is objected to. */
  const reseal = (a: any) => { const d = computeEvidenceDigest(a); a.digest.value = d; a.evidenceId = deriveEvidenceId(d); return a; };
  const inputOf = (a: InventoryMovementEvidence, h: string, over: Partial<AppendPublicationEvidenceInput> = {}): AppendPublicationEvidenceInput => ({
    publicationPackageId: h, contractName: a.contract.name, contractVersion: a.contract.version, contractStatus: a.contract.status, recordSchemaVersion: a.recordSchemaVersion, domain: a.source.domain,
    periodStart: a.source.periodStart, periodEnd: a.source.periodEnd, ordering: a.ordering, canonicalization: a.digest.canonicalization, digestAlgorithm: a.digest.algorithm, recordCount: a.recordCount,
    digest: a.digest.value, evidenceId: a.evidenceId, canonicalBody: canonicalEvidenceBody(a), correlationId: a.provenance.correlationId, ...over });
  const insertArgs = (w: World, i: AppendPublicationEvidenceInput) => [w.tenantId, w.workspaceId, w.businessId, i.publicationPackageId, i.periodStart, i.periodEnd, i.contractName, i.contractVersion, i.contractStatus, i.recordSchemaVersion, i.domain, i.ordering, i.canonicalization, i.digestAlgorithm, i.recordCount, i.digest, i.evidenceId, i.canonicalBody, i.correlationId];
  const rowOf = async (h: string) => (await q(`SELECT * FROM ${BO}.bo_publication_evidence WHERE publication_package_id = $1`, [h]))[0];
  const count = async (businessId: string) => Number((await q(`SELECT count(*) n FROM ${BO}.bo_publication_evidence WHERE business_id = $1`, [businessId]))[0].n);
  const sideEffects = async (w: World) => JSON.stringify([
    await q(`SELECT * FROM ${BO}.bo_publication_packages WHERE business_id = $1 ORDER BY id`, [w.businessId]), await q(`SELECT * FROM ${BO}.bo_handoff_records WHERE business_id = $1 ORDER BY id`, [w.businessId]),
    await q(`SELECT count(*) n FROM events.outbox_events WHERE tenant_id = $1`, [w.tenantId]), await q(`SELECT count(*) n FROM audit.audit_events WHERE tenant_id = $1`, [w.tenantId])]);
  /** Records every statement run through the application pool into ONE sink (a pooled client is patched once, never re-wrapped, so nothing is recorded twice). */
  let sink: string[] | null = null;
  const patched = new WeakSet<object>();
  function spyOnPool() {
    const pool = getPool(); const originalConnect = pool.connect.bind(pool);
    return vi.spyOn(pool, 'connect').mockImplementation((async () => {
      const client = await originalConnect();
      if (!patched.has(client)) {
        patched.add(client); const original = client.query.bind(client);
        (client as unknown as { query: unknown }).query = (...args: unknown[]) => { const a0 = args[0] as string | { text: string }; sink?.push(typeof a0 === 'string' ? a0 : a0.text); return (original as (...x: unknown[]) => unknown)(...args); };
      }
      return client;
    }) as never);
  }
  /** Waits (bounded) until some backend is blocked on a lock while running a statement that mentions `fragment`: observed overlap, not a hoped-for race. */
  async function waitForLockWait(fragment: string, ms = 8000) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const r = await q(`SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE $1 AND pid <> pg_backend_pid()`, [`%${fragment}%`]);
      if (r.length > 0) return true;
      await new Promise((res) => setTimeout(res, 25));
    }
    return false;
  }

  describe('first association', () => {
    it('stores one row after commit: exact header tuple, canonical bytes, digest and id; the header and every dispatch, audit and outbox effect are unchanged; decimals are exact text', async () => {
      const { w, h } = await ready(); const before = await sideEffects(w);
      const r = await publish(w, h); expect(r.ok).toBe(true); if (!r.ok) return;
      expect(r.replayed).toBe(false); expect(r.evidence.recordCount).toBe(3); expect(r.evidence.source.boPublicationPackageId).toBe(h);
      const built = await extracted(w, h);
      expect(r.evidence.digest).toEqual(built.digest); expect(r.evidence.records).toEqual(built.records);
      expect(r.evidence.records.map((x) => x.quantity).sort()).toEqual(['0.1', '1234.5', '99999999999999.9999']); // a double would give 100000000000000
      expect(r.evidence.records.map((x) => x.unitCost).filter(Boolean).sort()).toEqual(['0.0001', '12.3456']);
      const row = await rowOf(h);
      expect(row).toMatchObject({ tenant_id: w.tenantId, workspace_id: w.workspaceId, business_id: w.businessId, publication_package_id: h, record_count: 3, digest: r.evidence.digest.value, evidence_id: r.evidence.evidenceId, domain: 'inventory_movements', contract_status: 'PROPOSED_NOT_ACTIVE' });
      expect(row.canonical_body).toBe(canonicalEvidenceBody(r.evidence)); // the stored bytes ARE the hashed text
      expect(row.id).not.toBe(row.evidence_id); expect(row.created_at.getFullYear()).toBeGreaterThanOrEqual(2026);
      expect(await count(w.businessId)).toBe(1); expect(await sideEffects(w)).toBe(before);
      expect(verifyInventoryMovementEvidence(r.evidence).ok).toBe(true);
    });
  });

  describe('identical replay', () => {
    it('returns the same row and ids with a new correlation, leaves the stored bytes, creation time and FIRST correlation unchanged, and still replays after the header advances', async () => {
      const { w, h } = await ready();
      const a = await publish(w, h); if (!a.ok) throw new Error(a.code); const first = await rowOf(h);
      const b = await publish(w, h, { correlationId: randomUUID() });
      expect(b.ok && b.replayed).toBe(true); if (!b.ok) return;
      expect(b.evidence.evidenceId).toBe(a.evidence.evidenceId); expect(await count(w.businessId)).toBe(1);
      expect(await rowOf(h)).toEqual(first); expect(first.correlation_id).toBe(a.evidence.provenance.correlationId);
      // an unrelated header change (status) is allowed with an association, and the replay is still answered from the association
      await admin.query(`UPDATE ${BO}.bo_publication_packages SET package_status = 'dispatched', version = version + 1 WHERE id = $1`, [h]);
      const c = await publish(w, h); expect(c.ok && c.replayed).toBe(true); expect(await rowOf(h)).toEqual(first);
    });
  });

  describe('concurrency (observed lock wait, then overlap)', () => {
    it('a second publisher WAITS on the header lock held by a first session, then proceeds: one row, stored once', async () => {
      const { w, h } = await ready();
      const holder = await admin.connect();
      try {
        await holder.query('BEGIN'); await holder.query(`SELECT id FROM ${BO}.bo_publication_packages WHERE id = $1 FOR UPDATE`, [h]);
        const pending = publish(w, h);
        expect(await waitForLockWait('bo_publication_packages')).toBe(true); // the publisher is observably blocked on the header lock
        expect(await count(w.businessId)).toBe(0);
        await holder.query('COMMIT');
        const r = await pending; expect(r.ok && !r.replayed).toBe(true);
      } finally { holder.release(); }
      expect(await count(w.businessId)).toBe(1);
    });
    it('eight concurrent identical publications store ONE artifact; every caller gets the same evidence', async () => {
      const { w, h } = await ready();
      const results = await Promise.all(Array.from({ length: 8 }, () => publish(w, h)));
      expect(results.every((r) => r.ok)).toBe(true);
      expect(new Set(results.map((r) => (r.ok ? r.evidence.evidenceId : ''))).size).toBe(1);
      expect(results.filter((r) => r.ok && !r.replayed)).toHaveLength(1); expect(await count(w.businessId)).toBe(1);
    });
    it('two concurrent DIFFERENT verified artifacts for one header: exactly one wins, the other is a sanitized CONFLICT, and the stored body is the winner\'s exactly', async () => {
      const { w, h } = await ready(); const e = await extracted(w, h);
      const other = reseal((() => { const a = clone(e); a.records[0].quantity = '7'; return a; })());
      const [x, y] = await Promise.all([repo.append(w.ctx, w.businessId, inputOf(e, h)), repo.append(w.ctx, w.businessId, inputOf(other, h))]);
      expect([x.outcome, y.outcome].sort()).toEqual(['CONFLICT', 'STORED']);
      const winner = x.outcome === 'STORED' ? e : other; expect((await rowOf(h)).canonical_body).toBe(canonicalEvidenceBody(winner)); expect(await count(w.businessId)).toBe(1);
    });
    it('a direct duplicate under the constrained application role is refused by the one-slot key itself (23505), not only by the writer', async () => {
      const { w, h } = await ready(); expect((await publish(w, h)).ok).toBe(true); const e = await extracted(w, h);
      const second = reseal((() => { const a = clone(e); a.records[0].quantity = '7'; return a; })());
      const attempt = withTenantTransaction(w.ctx, (c) => c.query(`INSERT INTO ${BO}.bo_publication_evidence (${INSERT_COLUMNS}) VALUES (${INSERT_VALUES})`, insertArgs(w, inputOf(second, h))));
      await expect(attempt).rejects.toMatchObject({ code: '23505' }); expect(await count(w.businessId)).toBe(1);
    });
  });

  describe('invalid metadata and header eligibility', () => {
    it.each([
      ['another business in the body scope', (a: any) => { a.scope.businessId = randomUUID(); }],
      ['another tenant in the body scope', (a: any) => { a.scope.tenantId = randomUUID(); }],
      ['another period in the body', (a: any) => { a.source.periodStart = '2026-01-01T00:00:00.001Z'; }],
      ['another source domain in the body', (a: any) => { a.source.domain = 'sales'; }],
      ['another schema version in the body', (a: any) => { a.recordSchemaVersion = 'bo.inventory_movement.record.v9'; }],
      ['another contract version in the body', (a: any) => { a.contract.version = '9.9.9'; }],
      ['another ordering in the body', (a: any) => { a.ordering = 'id desc'; }],
      ['another record count in the body', (a: any) => { a.recordCount = 99; }],
      ['another package binding in the body', (a: any) => { a.source.boPublicationPackageId = randomUUID(); }],
    ])('refuses a body that disagrees with the stored identity (%s) even though its digest is valid; nothing is written', async (_l, edit) => {
      const { w } = await ready(); const h = await header(w); const e = await extracted(w, h);
      const forged = reseal((() => { const a = clone(e); (edit as (x: any) => void)(a); return a; })());
      expect(await repo.append(w.ctx, w.businessId, inputOf(e, h, { digest: forged.digest.value, evidenceId: forged.evidenceId, canonicalBody: canonicalEvidenceBody(forged) }))).toEqual({ outcome: 'REFUSED' });
      expect(await count(w.businessId)).toBe(0);
    });
    it('refuses a digest that is not the hash of the stored bytes, an evidence id that is not derived from the digest, and bytes that are not JSON - then the correct artifact stores (atomic rollback)', async () => {
      const { w } = await ready(); const h = await header(w); const e = await extracted(w, h); const good = inputOf(e, h);
      expect(await repo.append(w.ctx, w.businessId, { ...good, digest: 'c'.repeat(64) })).toEqual({ outcome: 'REFUSED' });
      expect(await repo.append(w.ctx, w.businessId, { ...good, evidenceId: 'd'.repeat(64) })).toEqual({ outcome: 'REFUSED' });
      expect(await repo.append(w.ctx, w.businessId, { ...good, canonicalBody: good.canonicalBody + ' ' })).toEqual({ outcome: 'REFUSED' });
      expect(await repo.append(w.ctx, w.businessId, { ...good, canonicalBody: 'not json', digest: sha('bo-evidence-body:not json'), evidenceId: sha(`bo-evidence-id:${good.contractName}:${sha('bo-evidence-body:not json')}`) })).toEqual({ outcome: 'REFUSED' });
      expect(await count(w.businessId)).toBe(0); expect((await repo.append(w.ctx, w.businessId, good)).outcome).toBe('STORED');
    });
    it('refuses a period or count that disagrees with the header at the writer, and a direct insert whose period tuple differs from the header at the composite key (23503)', async () => {
      const { w } = await ready(); const h = await header(w); const e = await extracted(w, h); const i = inputOf(e, h);
      expect(await repo.append(w.ctx, w.businessId, { ...i, periodStart: '2026-01-02T00:00:00.000Z' })).toEqual({ outcome: 'REFUSED' });
      expect(await repo.append(w.ctx, w.businessId, { ...i, recordCount: 2 })).toEqual({ outcome: 'REFUSED' });
      // a body that AGREES with its own (wrong) period, so only the composite header key can object: the header's period is different
      const shifted = reseal((() => { const a = clone(e); a.source.periodStart = '2026-01-02T00:00:00.000Z'; return a; })());
      const wrongPeriod = withTenantTransaction(w.ctx, (c) => c.query(`INSERT INTO ${BO}.bo_publication_evidence (${INSERT_COLUMNS}) VALUES (${INSERT_VALUES})`, insertArgs(w, inputOf(shifted, h))));
      await expect(wrongPeriod).rejects.toMatchObject({ code: '23503' }); expect(await count(w.businessId)).toBe(0);
    });
    it.each([
      ['a header addressed to another layer', { layer: 'simulation' }, 'HEADER_NOT_ELIGIBLE'],
      ['a draft header', { status: 'draft' }, 'HEADER_NOT_ELIGIBLE'],
      ['a dispatched header', { status: 'dispatched' }, 'HEADER_NOT_ELIGIBLE'],
      ['a received header', { status: 'received' }, 'HEADER_NOT_ELIGIBLE'],
      ['a failed header', { status: 'failed' }, 'HEADER_NOT_ELIGIBLE'],
      ['a header declaring another record count', { count: 4 }, 'REFUSED'],
    ])('the REPOSITORY itself (not only the service) refuses a new association on %s', async (_l, over, expected) => {
      const { w } = await ready(); const h0 = await header(w); const e = await extracted(w, h0); const hdr = await header(w, over);
      const rebound = reseal((() => { const a = clone(e); a.source.boPublicationPackageId = hdr; return a; })());
      expect(await repo.append(w.ctx, w.businessId, inputOf(rebound, hdr))).toEqual({ outcome: expected });
      expect(await rowOf(hdr)).toBeUndefined();
    });
    it.each([
      ['a header that does not exist', async () => randomUUID(), 'HEADER_NOT_FOUND'],
      ['a header addressed to another layer', (w: World) => header(w, { layer: 'simulation' }), 'HEADER_NOT_FOR_BI'],
      ['a draft header', (w: World) => header(w, { status: 'draft' }), 'HEADER_NOT_PUBLISHED'],
      ['a failed header', (w: World) => header(w, { status: 'failed' }), 'HEADER_NOT_PUBLISHED'],
      ['a header for another period', (w: World) => header(w, { end: '2026-03-01T00:00:00.000Z' }), 'HEADER_PERIOD_MISMATCH'],
      ['a header declaring another record count', (w: World) => header(w, { count: 4 }), 'HEADER_COUNT_MISMATCH'],
      ['an already DISPATCHED header with no association (creation needs the creation state)', (w: World) => header(w, { status: 'dispatched' }), 'HEADER_NOT_READY'],
      ['an already RECEIVED header with no association', (w: World) => header(w, { status: 'received' }), 'HEADER_NOT_READY'],
    ])('refuses a new association on %s, with zero writes', async (_l, make, expected) => {
      const w = await world(); await seed(w); const id = await (make as (w: World) => Promise<string>)(w); const before = await sideEffects(w);
      expect(await publish(w, id)).toEqual({ ok: false, code: expected }); expect(await count(w.businessId)).toBe(0); expect(await sideEffects(w)).toBe(before);
    });
    it('rejects a period containing a historical movement whose currency cannot be proven (D2): nothing stored, nothing invented', async () => {
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
      expect(await publish(w, h)).toEqual({ ok: false, code: 'EVIDENCE_REJECTED' }); expect(await count(w.businessId)).toBe(0);
    });
  });

  describe('rollback and recovery', () => {
    it('a session that inserts and then ROLLS BACK leaves no row, and a waiting valid publisher then commits exactly one complete row with no event', async () => {
      const { w, h } = await ready(); const e = await extracted(w, h); const i = inputOf(e, h); const before = await sideEffects(w);
      const a = await admin.connect();
      try {
        await a.query('BEGIN'); await a.query(`SELECT id FROM ${BO}.bo_publication_packages WHERE id = $1 FOR UPDATE`, [h]);
        await a.query(`INSERT INTO ${BO}.bo_publication_evidence (${INSERT_COLUMNS}) VALUES (${INSERT_VALUES})`, insertArgs(w, i));
        const waiter = publish(w, h); expect(await waitForLockWait('bo_publication_packages')).toBe(true);
        await a.query('ROLLBACK'); // injected failure before commit
        const r = await waiter; expect(r.ok && !r.replayed).toBe(true);
      } finally { a.release(); }
      expect(await count(w.businessId)).toBe(1); expect(JSON.parse(await sideEffects(w))[0]).toEqual(JSON.parse(before)[0]);
    });
    it('recovers from the stored association alone: a ledger that changed afterwards neither creates a row nor changes what is read; a dispatched header without an association fails closed', async () => {
      const { w, h } = await ready(); const a = await publish(w, h); if (!a.ok) throw new Error(a.code); const stored = await rowOf(h);
      await move(w, { quantity: 1, occurredAt: '2026-01-20T00:00:00.000000Z' }); // the ledger now holds 4 movements for the period
      expect(await publish(w, h)).toEqual({ ok: false, code: 'HEADER_COUNT_MISMATCH' }); // never regenerated from changed ledger data
      expect(await rowOf(h)).toEqual(stored); expect(await count(w.businessId)).toBe(1);
      const recovered = await reader.read(w.ctx, w.businessId, h); expect(recovered.ok && recovered.evidence.evidenceId === a.evidence.evidenceId && recovered.evidence.digest.value === a.evidence.digest.value).toBe(true);
      const dispatched = await header(w, { status: 'dispatched', count: 3 });
      expect(await reader.read(w.ctx, w.businessId, dispatched)).toEqual({ ok: false, code: 'EVIDENCE_NOT_FOUND' });
    });
  });

  describe('fail-closed authority', () => {
    it('the default authority denies: nothing is read from the ledger and nothing is stored', async () => {
      const { w, h } = await ready(); const denied = new InventoryMovementEvidencePublicationService();
      const statements: string[] = []; sink = statements; const spy = spyOnPool();
      try { expect(await publish(w, h, {}, denied)).toEqual({ ok: false, code: 'PUBLICATION_NOT_AUTHORIZED' }); } finally { spy.mockRestore(); sink = null; }
      expect(statements).toEqual([]); expect(await DisabledPublicationAuthority.mayPublish(w.ctx, w.businessId)).toBe(false); expect(await count(w.businessId)).toBe(0);
    });
    it('an authority that answers anything but an explicit true, or that throws, publishes nothing', async () => {
      const { w, h } = await ready();
      for (const answer of ['yes', 1, {}, undefined, null, 'true']) {
        const svc = new InventoryMovementEvidencePublicationService({ mayPublish: async () => answer as unknown as boolean });
        expect(await publish(w, h, {}, svc), String(answer)).toEqual({ ok: false, code: 'PUBLICATION_NOT_AUTHORIZED' });
      }
      const throwing = new InventoryMovementEvidencePublicationService({ mayPublish: async () => { throw new Error('authority down'); } });
      await expect(publish(w, h, {}, throwing)).rejects.toThrow('authority down'); expect(await count(w.businessId)).toBe(0);
    });
  });

  describe('tenant isolation', () => {
    it('a foreign tenant, another workspace, a sibling business and an absent header are non-disclosing and write nothing', async () => {
      const a = await ready(); const b = await world(); const sib = await sibling(a.w); const sibHeader = await header(sib);
      const foreign = await service.publish(b.ctx, { businessId: a.w.businessId, boPublicationPackageId: a.h, ...PERIOD, correlationId: randomUUID() });
      const otherWorkspace = await service.publish({ ...a.w.ctx, workspaceId: randomUUID() }, { businessId: a.w.businessId, boPublicationPackageId: a.h, ...PERIOD, correlationId: randomUUID() });
      const siblingHeader = await publish(a.w, sibHeader); const absent = await publish(a.w, randomUUID());
      expect(foreign).toEqual({ ok: false, code: 'BUSINESS_NOT_FOUND' }); expect(otherWorkspace).toEqual({ ok: false, code: 'BUSINESS_NOT_FOUND' });
      expect(siblingHeader).toEqual({ ok: false, code: 'HEADER_NOT_FOUND' }); expect(absent).toEqual(siblingHeader);
      expect(await count(a.w.businessId)).toBe(0); expect(await count(sib.businessId)).toBe(0);
    });
    it("the repository answers a sibling business's or another tenant's request for this header with HEADER_NOT_FOUND (the explicit business predicate), and a read of another party's artifact is EVIDENCE_NOT_FOUND", async () => {
      const { w, h } = await ready(); expect((await publish(w, h)).ok).toBe(true); const s = await sibling(w); const other = await world(); const e = await extracted(w, h);
      expect(await repo.append(s.ctx, s.businessId, inputOf(e, h))).toEqual({ outcome: 'HEADER_NOT_FOUND' });
      expect(await repo.append(other.ctx, other.businessId, inputOf(e, h))).toEqual({ outcome: 'HEADER_NOT_FOUND' });
      for (const call of [reader.read(w.ctx, s.businessId, h), reader.read(other.ctx, other.businessId, h), reader.read(other.ctx, w.businessId, h), reader.read(w.ctx, w.businessId, randomUUID()), reader.read(w.ctx, 'x', h), reader.read(w.ctx, w.businessId, 'x')]) {
        expect(await call).toEqual({ ok: false, code: 'EVIDENCE_NOT_FOUND' });
      }
    });
    it('without a trusted tenant context the application role neither reads nor inserts (RLS)', async () => {
      const { w, h } = await ready(); expect((await publish(w, h)).ok).toBe(true); const e = await extracted(w, h); const i = inputOf(e, randomUUID(), { periodStart: e.source.periodStart });
      const pool = getPool();
      // without a trusted tenant setting the policy either hides every row or refuses outright (a uuid cast of the empty setting): both fail closed
      expect([0, 'refused']).toContain(await pool.query(`SELECT 1 FROM ${BO}.bo_publication_evidence`).then((r) => r.rowCount, () => 'refused'));
      await expect(pool.query(`INSERT INTO ${BO}.bo_publication_evidence (${INSERT_COLUMNS}) VALUES (${INSERT_VALUES})`, insertArgs(w, i))).rejects.toBeDefined();
    });
  });

  describe('FORCE RLS, immutability and parent-tuple pinning', () => {
    it('both RLS flags, a tenant+workspace policy, the one-slot key, the composite key (6 columns, restrict, immediate), the append-only triggers, and a constrained non-owner, non-bypass application role', async () => {
      const [r] = await q(`SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS forced FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'business_operations' AND c.relname = 'bo_publication_evidence'`);
      expect(r).toEqual({ rls: true, forced: true });
      const policies = await q(`SELECT policyname, qual FROM pg_policies WHERE schemaname = 'business_operations' AND tablename = 'bo_publication_evidence'`);
      expect(policies.map((p) => p.policyname)).toEqual(['bo_publication_evidence_tenant_isolation']); expect(policies[0].qual).toMatch(/tenant_id = .*app\.tenant_id.*workspace_id = .*app\.workspace_id/s);
      const triggers = (await q(`SELECT tgname FROM pg_trigger WHERE tgrelid = 'business_operations.bo_publication_evidence'::regclass AND NOT tgisinternal`)).map((x) => x.tgname);
      expect(triggers).toEqual(expect.arrayContaining(['forbid_mutation_bo_publication_evidence', 'forbid_truncate_bo_publication_evidence', 'check_bo_publication_evidence']));
      const fk = (await q(`SELECT array_length(conkey, 1) AS cols, confupdtype, confdeltype, condeferrable FROM pg_constraint WHERE conname = 'bo_publication_evidence_header_fk'`))[0];
      expect(fk).toMatchObject({ cols: 6, confupdtype: 'r', confdeltype: 'r', condeferrable: false });
      const unique = (await q(`SELECT condeferrable, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'bo_publication_evidence_one_per_header'`))[0];
      expect(unique.def).toBe('UNIQUE (publication_package_id)'); expect(unique.condeferrable).toBe(false);
      expect((await q(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'bo_publication_packages_d3_key'`))[0].def).toBe('UNIQUE (id, tenant_id, workspace_id, business_id, period_start, period_end)');
      const role = await withTenantTransaction({ tenantId: randomUUID(), workspaceId: randomUUID(), userId: randomUUID() }, (c) => c.query(`SELECT r.rolsuper, r.rolbypassrls, pg_has_role(current_user, c.relowner, 'MEMBER') AS owner_member, has_table_privilege(current_user, 'business_operations.bo_publication_evidence', 'TRUNCATE') AS can_truncate
        FROM pg_roles r, pg_class c WHERE r.rolname = current_user AND c.oid = 'business_operations.bo_publication_evidence'::regclass`));
      expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false, owner_member: false, can_truncate: false });
      expect((await q(`SELECT relforcerowsecurity AS f FROM pg_class WHERE oid = 'business_operations.bo_publication_packages'::regclass`))[0].f).toBe(true);
    });
    it('the application role cannot update, delete or truncate evidence; cross-scope reads see nothing; a copied association fails closed', async () => {
      const { w, h } = await ready(); expect((await publish(w, h)).ok).toBe(true); const other = await world(); const id = (await rowOf(h)).id;
      const visible = (ctx: TenantContext, sql: string) => withTenantTransaction(ctx, (c) => c.query(sql, [id]));
      expect((await visible(other.ctx, `SELECT 1 FROM ${BO}.bo_publication_evidence WHERE id = $1`)).rowCount).toBe(0);
      expect((await visible({ ...w.ctx, workspaceId: randomUUID() }, `SELECT 1 FROM ${BO}.bo_publication_evidence WHERE id = $1`)).rowCount).toBe(0);
      expect((await visible(w.ctx, `SELECT 1 FROM ${BO}.bo_publication_evidence WHERE id = $1`)).rowCount).toBe(1);
      for (const sql of [`UPDATE ${BO}.bo_publication_evidence SET correlation_id = gen_random_uuid() WHERE id = $1`, `DELETE FROM ${BO}.bo_publication_evidence WHERE id = $1`]) await expect(visible(w.ctx, sql), sql).rejects.toThrow(/append-only/);
      await expect(truncateRefusal(admin, `TRUNCATE business_operations.bo_publication_evidence`)).rejects.toThrow(/append-only/);
      // the evidence of one header cannot be attached to ANOTHER header (a copied association), even in the same business and with a valid digest
      const e = await extracted(w, h); const h2 = await header(w); expect(await repo.append(w.ctx, w.businessId, inputOf(e, h2))).toEqual({ outcome: 'REFUSED' });
    });
    it("an associated header's scope and period are pinned (UPDATE and DELETE are refused by the composite key, 23503) while unrelated header changes stay allowed", async () => {
      const { w, h } = await ready(); expect((await publish(w, h)).ok).toBe(true);
      const hdr = (sql: string, args: unknown[] = [h]) => withTenantTransaction(w.ctx, (c) => c.query(sql, args));
      await expect(hdr(`UPDATE ${BO}.bo_publication_packages SET period_end = period_end + interval '1 day' WHERE id = $1`)).rejects.toMatchObject({ code: '23503' });
      await expect(hdr(`UPDATE ${BO}.bo_publication_packages SET period_start = period_start - interval '1 day' WHERE id = $1`)).rejects.toMatchObject({ code: '23503' });
      await expect(hdr(`DELETE FROM ${BO}.bo_publication_packages WHERE id = $1`)).rejects.toMatchObject({ code: '23503' });
      await expect(hdr(`UPDATE ${BO}.bo_publication_packages SET business_id = $2 WHERE id = $1`, [h, randomUUID()])).rejects.toBeDefined();
      expect((await hdr(`UPDATE ${BO}.bo_publication_packages SET package_status = 'dispatched', dispatched_at = now(), version = version + 1 WHERE id = $1`)).rowCount).toBe(1);
      // a header WITHOUT an association is unaffected by the new key
      const free = await header(w); expect((await hdr(`UPDATE ${BO}.bo_publication_packages SET period_end = period_end + interval '1 day' WHERE id = $1`, [free])).rowCount).toBe(1);
    });
  });

  describe('integrity on read (behind-the-application tampering by the administrator, triggers suspended)', () => {
    it.each([
      ['a changed period column', (id: string) => [`UPDATE ${BO}.bo_publication_evidence SET period_start = period_start + interval '1 second' WHERE id = $1`, [id]]],
      ['a changed record count column', (id: string) => [`UPDATE ${BO}.bo_publication_evidence SET record_count = 2 WHERE id = $1`, [id]]],
      ['a changed business column', (id: string) => [`UPDATE ${BO}.bo_publication_evidence SET business_id = gen_random_uuid() WHERE id = $1`, [id]]],
    ])('detects %s', async (_l, make) => {
      const { w, h } = await ready(); expect((await publish(w, h)).ok).toBe(true); const id = (await rowOf(h)).id;
      const [sql, args] = (make as (id: string) => [string, unknown[]])(id);
      try { await tamper(sql, args); } catch (e) { expect((e as { code?: string }).code, String(e)).toMatch(/^23/); return; } // a constraint refusing the tamper is also a defence
      const r = await reader.read(w.ctx, w.businessId, h);
      expect(r.ok).toBe(false); if (!r.ok) expect(['STORED_EVIDENCE_INTEGRITY', 'EVIDENCE_NOT_FOUND']).toContain(r.code);
    });
    it('detects a body that is valid but NOT canonical (re-spaced, with a consistent digest and id) and a forged artifact that is internally consistent but breaks the record schema', async () => {
      const { w, h } = await ready(); expect((await publish(w, h)).ok).toBe(true); const row = await rowOf(h);
      const body = (row.canonical_body as string).replace('"records":', '"records": '); const d = sha('bo-evidence-body:' + body); // same JSON, different bytes
      await tamper(`UPDATE ${BO}.bo_publication_evidence SET canonical_body = $2, digest = $3, evidence_id = $4 WHERE id = $1`, [row.id, body, d, sha(`bo-evidence-id:${row.contract_name}:${d}`)]);
      expect(await reader.read(w.ctx, w.businessId, h)).toEqual({ ok: false, code: 'STORED_EVIDENCE_INTEGRITY' });
      const h2 = await header(w); const e = await extracted(w, h2);
      const forged = reseal((() => { const a = clone(e); (a.records[0] as unknown as Record<string, unknown>).notes = 'SECRET-NOTE-LEAK'; return a; })());
      await tamper(`INSERT INTO ${BO}.bo_publication_evidence (${INSERT_COLUMNS}) VALUES (${INSERT_VALUES})`, insertArgs(w, inputOf(forged, h2)));
      expect(await reader.read(w.ctx, w.businessId, h2)).toEqual({ ok: false, code: 'STORED_EVIDENCE_INTEGRITY' });
    });
    it('returns the verified artifact on an untouched store', async () => {
      const { w, h } = await ready(); const p = await publish(w, h); if (!p.ok) throw new Error('x');
      const r = await reader.read(w.ctx, w.businessId, h); expect(r.ok).toBe(true); if (r.ok) { expect(r.evidence).toEqual(p.evidence); expect(r.storedAt).toBeInstanceOf(Date); }
    });
  });

  describe('BO / BI boundary', () => {
    it('publishing locks the header but never updates it, writes only the one evidence row, emits no event and touches no BI table; reading is a single SELECT of the evidence table', async () => {
      const { w, h } = await ready(); const before = await sideEffects(w);
      const statements: string[] = []; sink = statements; const spy = spyOnPool();
      try {
        expect((await publish(w, h)).ok).toBe(true); const publishing = statements.splice(0);
        expect((await reader.read(w.ctx, w.businessId, h)).ok).toBe(true); const reading = statements.splice(0);
        expect(reading.filter((s) => /FROM business_operations/.test(s))).toHaveLength(1); expect(reading.join('\n')).not.toMatch(/inventory_movements|inventory_balances|bo_publication_packages|business_intelligence/);
        expect(reading.every((s) => /^\s*(SELECT|BEGIN|COMMIT|ROLLBACK|SET|RESET)\b/i.test(s) || /set_config/i.test(s))).toBe(true);
        const writes = publishing.filter((s) => /^\s*(INSERT|UPDATE|DELETE|TRUNCATE)\b/i.test(s));
        expect(writes).toHaveLength(1); expect(writes[0]).toMatch(/^\s*INSERT INTO business_operations\.bo_publication_evidence\b/);
        expect(publishing.some((s) => /FROM business_operations\.bo_publication_packages[\s\S]*FOR UPDATE/.test(s))).toBe(true);
        expect(publishing.join('\n')).not.toMatch(/UPDATE business_operations\.bo_publication_packages|business_intelligence|events\.|audit\./);
      } finally { spy.mockRestore(); sink = null; }
      expect(await sideEffects(w)).toBe(before);
    });
  });
});
