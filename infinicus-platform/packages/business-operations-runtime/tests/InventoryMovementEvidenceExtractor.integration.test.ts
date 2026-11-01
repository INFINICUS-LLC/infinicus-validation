/**
 * BO-PUB-DEV-01: the evidence extractor against live PostgreSQL under the APPLICATION role (RLS enforced; the administrator connection builds fixtures and tampers only).
 * Ledger rows are written by Business Operations' own command executor (the one movement writer), so the evidence is extracted from real BO persistence. The contract being
 * exercised is a PROPOSED one and is not active. Requires DATABASE_URL (application role) and ADMIN_DATABASE_URL.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- tests read arbitrary rows */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { closePool, createPool, getPool, withTenantTransaction, type TenantContext } from '@infinicus/database';
import { OperationalCommandExecutor } from '../src/OperationalCommandExecutor.js';
import { InventoryMovementEvidenceExtractor, verifyInventoryMovementEvidence, INVENTORY_MOVEMENT_EVIDENCE } from '../src/index.js';
import type { OperationalCommand } from '../src/types.js';
import { deleteMovementsForTenants } from './helpers/movementCleanup.js';

const run = Boolean(process.env.DATABASE_URL && process.env.ADMIN_DATABASE_URL);
const BO = 'business_operations';
const PERIOD = { periodStart: '2026-01-01T00:00:00.000Z', periodEnd: '2026-02-01T00:00:00.000Z' };

describe.runIf(run)('BO-PUB-DEV-01 inventory movement evidence extraction (live PostgreSQL, application role)', () => {
  let admin: Pool;
  const tenantIds: string[] = [];
  const executor = new OperationalCommandExecutor();
  const extractor = new InventoryMovementEvidenceExtractor();
  let seq = 0;
  const unique = (p: string) => `${p}-${Date.now()}-${++seq}`;
  beforeAll(() => { admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL }); createPool({ connectionString: process.env.DATABASE_URL as string }); });
  afterAll(async () => { await deleteMovementsForTenants(admin, tenantIds).catch(() => undefined); await admin?.end(); await closePool(); });

  interface World { ctx: TenantContext; tenantId: string; workspaceId: string; businessId: string; sku: string; warehouseCode: string }
  async function world(): Promise<World> {
    const tenantId = randomUUID(); const workspaceId = randomUUID(); const userId = randomUUID(); tenantIds.push(tenantId);
    const slug = `ev${tenantId.slice(0, 8)}`;
    await admin.query(`INSERT INTO tenancy.tenants (id, name, slug, status, plan_code) VALUES ($1,$2,$3,'active','test')`, [tenantId, slug, slug]);
    await admin.query(`INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,$3,$4,'active')`, [workspaceId, tenantId, slug, slug]);
    await admin.query(`INSERT INTO identity.users (id, email, status) VALUES ($1,$2,'active')`, [userId, `${slug}@evidence.example.test`]);
    const businessId = (await admin.query(`INSERT INTO platform.businesses (tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,'Evidence biz',$3,'active') RETURNING id`, [tenantId, workspaceId, unique('ev-biz')])).rows[0].id as string;
    return { ctx: { tenantId, workspaceId, userId }, tenantId, workspaceId, businessId, ...(await masterData(tenantId, workspaceId, businessId)) };
  }
  async function masterData(tenantId: string, workspaceId: string, businessId: string) {
    const sku = unique('SKU'); const warehouseCode = unique('WH');
    await admin.query(`INSERT INTO platform.inventory_items (tenant_id, workspace_id, business_id, sku, name, status) VALUES ($1,$2,$3,$4,'Item','active')`, [tenantId, workspaceId, businessId, sku]);
    await admin.query(`INSERT INTO platform.warehouses (tenant_id, workspace_id, business_id, warehouse_code, name) VALUES ($1,$2,$3,$4,'WH')`, [tenantId, workspaceId, businessId, warehouseCode]);
    return { sku, warehouseCode };
  }
  /** A second business in the SAME workspace, with its own ledger. */
  async function sibling(w: World): Promise<World> {
    const businessId = (await admin.query(`INSERT INTO platform.businesses (tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,'Sibling biz',$3,'active') RETURNING id`, [w.tenantId, w.workspaceId, unique('ev-sib')])).rows[0].id as string;
    return { ...w, businessId, ...(await masterData(w.tenantId, w.workspaceId, businessId)) };
  }
  const context = (w: World) => ({ tenantId: w.tenantId, workspaceId: w.workspaceId, businessId: w.businessId, correlationId: randomUUID(), sourceReference: 'evidence-1#0', provenanceReference: randomUUID(), idempotencyKey: `dal-to-bo:${randomUUID()}:1:evidence-1#0`, actorId: 'actor-1', occurredAt: new Date().toISOString() });
  /** Records a movement through BO's own writer. */
  async function move(w: World, p: Record<string, unknown>) {
    const command = { type: 'record_keyed_inventory_movement', context: context(w), payload: { inventoryItemSku: w.sku, warehouseCode: w.warehouseCode, movementType: 'receipt', quantity: 5, ...p } } as unknown as OperationalCommand;
    await withTenantTransaction(w.ctx, (client) => executor.executeOn(client, w.ctx, command));
  }
  const seed = async (w: World) => {
    await move(w, { quantity: 10.5, unitCost: 2.25, unitCostCurrency: 'USD', referenceType: 'manual', occurredAt: '2026-01-10T08:30:00.123456Z', notes: 'SECRET-NOTE customer name' });
    await move(w, { quantity: 3, movementType: 'issue', occurredAt: '2026-01-10T08:30:00.123456Z' });
    await move(w, { quantity: 4, occurredAt: '2026-01-31T23:59:59.999999Z' });
    await move(w, { quantity: 99, occurredAt: '2026-02-01T00:00:00.000000Z' }); // exactly the (exclusive) end
    await move(w, { quantity: 98, occurredAt: '2025-12-31T23:59:59.999999Z' }); // before the period
  };
  const req = (w: World, over: Record<string, unknown> = {}) => ({ businessId: w.businessId, ...PERIOD, correlationId: randomUUID(), ...over });
  const extract = (w: World, over: Record<string, unknown> = {}, ctx: TenantContext = w.ctx) => extractor.extract(ctx, req(w, over) as any);
  const q = async (sql: string, args: unknown[] = []) => (await admin.query(sql, args)).rows;
  const header = async (w: World, over: Record<string, unknown> = {}) => {
    const id = randomUUID();
    await admin.query(`INSERT INTO ${BO}.bo_publication_packages (id, tenant_id, workspace_id, business_id, package_code, target_layer, target_block, period_start, period_end, record_count, payload_reference, package_status)
                       VALUES ($1,$2,$3,$4,$5,$6,'BI-16',$7,$8,$9,'{}',$10)`,
      [id, w.tenantId, w.workspaceId, w.businessId, unique('pkg'), over.layer ?? 'business_intelligence', over.start ?? PERIOD.periodStart, over.end ?? PERIOD.periodEnd, over.count ?? 3, over.status ?? 'dispatched']);
    return id;
  };

  describe('extraction from real BO persistence', () => {
    it('extracts exactly the period [start, end): deterministic order, canonical decimals, verified', async () => {
      const w = await world(); await seed(w);
      const r = await extract(w); expect(r.ok).toBe(true); if (!r.ok) return;
      const e = r.evidence;
      expect(e.recordCount).toBe(3);
      const sameTime = e.records.slice(0, 2); // two movements share a timestamp: they are ordered by movement id, so the order is the same whatever the ids turn out to be
      expect(e.records.map((x) => x.quantity).slice(2)).toEqual(['4']); expect(sameTime.map((x) => x.quantity).sort()).toEqual(['10.5', '3']); expect(sameTime[0]!.occurredAt).toBe(sameTime[1]!.occurredAt); expect(sameTime[0]!.movementId < sameTime[1]!.movementId).toBe(true);
      const receipt = sameTime.find((x) => x.movementType === 'receipt')!; const issue = sameTime.find((x) => x.movementType === 'issue')!;
      expect(receipt).toMatchObject({ tenantId: w.tenantId, workspaceId: w.workspaceId, businessId: w.businessId, movementType: 'receipt', unitCost: '2.25', unitCostCurrency: 'USD', referenceType: 'manual', referenceId: null, occurredAt: '2026-01-10T08:30:00.123456Z' });
      expect(issue).toMatchObject({ movementType: 'issue', unitCost: null, unitCostCurrency: null, referenceType: null });
      expect(e.records[2]!.occurredAt).toBe('2026-01-31T23:59:59.999999Z');
      expect(e.contract.status).toBe('PROPOSED_NOT_ACTIVE'); expect(e.provenance.owner).toBe('business_operations');
      expect(verifyInventoryMovementEvidence(e, { scope: { tenantId: w.tenantId, workspaceId: w.workspaceId, businessId: w.businessId }, ...PERIOD, recordCount: 3 }).ok).toBe(true);
      // identities are the ledger's own
      const ledger = await q(`SELECT id FROM ${BO}.inventory_movements WHERE business_id = $1 AND occurred_at >= $2 AND occurred_at < $3 ORDER BY occurred_at, id`, [w.businessId, PERIOD.periodStart, PERIOD.periodEnd]);
      expect(e.records.map((x) => x.movementId)).toEqual(ledger.map((x) => x.id));
    });
    it('replays identically: the same ledger gives the same digest and evidence id, whatever the correlation id', async () => {
      const w = await world(); await seed(w);
      const a = await extract(w); const b = await extract(w);
      expect(a.ok && b.ok).toBe(true); if (!a.ok || !b.ok) return;
      expect(b.evidence.digest).toEqual(a.evidence.digest); expect(b.evidence.evidenceId).toBe(a.evidence.evidenceId);
      expect(b.evidence.provenance.correlationId).not.toBe(a.evidence.provenance.correlationId);
    });
    it('an appended movement changes the digest; a period with no movements is a valid, empty artifact', async () => {
      const w = await world(); await seed(w);
      const before = await extract(w); await move(w, { quantity: 1, occurredAt: '2026-01-20T00:00:00.000000Z' }); const after = await extract(w);
      expect(before.ok && after.ok).toBe(true); if (!before.ok || !after.ok) return;
      expect(after.evidence.recordCount).toBe(4); expect(after.evidence.digest.value).not.toBe(before.evidence.digest.value);
      const empty = await extract(w, { periodStart: '2030-01-01T00:00:00.000Z', periodEnd: '2030-02-01T00:00:00.000Z' });
      expect(empty.ok && empty.evidence.recordCount === 0 && empty.evidence.records.length === 0).toBe(true);
    });
  });

  describe('publication header agreement (the existing BO header, read only)', () => {
    it('accepts a header that agrees with the ledger on target, state, period and count, and records its id as provenance', async () => {
      const w = await world(); await seed(w); const id = await header(w);
      const r = await extract(w, { boPublicationPackageId: id.toUpperCase() }); expect(r.ok).toBe(true); if (!r.ok) return;
      expect(r.evidence.source.boPublicationPackageId).toBe(id);
      const without = await extract(w); if (!without.ok) throw new Error('x');
      expect(r.evidence.digest.value).not.toBe(without.evidence.digest.value); // the header is part of what the digest covers
    });
    it.each([
      ['a header that does not exist', async () => randomUUID(), 'HEADER_NOT_FOUND'],
      ['a header addressed to another layer', (w: World) => header(w, { layer: 'simulation' }), 'HEADER_NOT_FOR_BI'],
      ['a header that is still a draft', (w: World) => header(w, { status: 'draft' }), 'HEADER_NOT_PUBLISHED'],
      ['a header for another period', (w: World) => header(w, { end: '2026-03-01T00:00:00.000Z' }), 'HEADER_PERIOD_MISMATCH'],
      ['a header declaring another count', (w: World) => header(w, { count: 4 }), 'HEADER_COUNT_MISMATCH'],
    ])('refuses %s', async (_l, make, expected) => {
      const w = await world(); await seed(w); const id = await (make as (w: World) => Promise<string>)(w);
      expect(await extract(w, { boPublicationPackageId: id })).toMatchObject({ ok: false, code: expected });
    });
    it("never uses another business's header, even in the same workspace", async () => {
      const w = await world(); await seed(w); const s = await sibling(w); const id = await header(s);
      expect(await extract(w, { boPublicationPackageId: id })).toMatchObject({ ok: false, code: 'HEADER_NOT_FOUND' });
    });
  });

  describe('isolation', () => {
    it("a sibling business in the same workspace contributes no record to this business's evidence, and vice versa", async () => {
      const w = await world(); await seed(w); const s = await sibling(w);
      await move(s, { quantity: 7, occurredAt: '2026-01-15T00:00:00.000000Z', notes: 'SIBLING-SECRET' });
      const mine = await extract(w); const theirs = await extract(s);
      expect(mine.ok && theirs.ok).toBe(true); if (!mine.ok || !theirs.ok) return;
      expect(mine.evidence.recordCount).toBe(3); expect(theirs.evidence.recordCount).toBe(1);
      expect(mine.evidence.records.every((r) => r.businessId === w.businessId)).toBe(true); expect(theirs.evidence.records.every((r) => r.businessId === s.businessId)).toBe(true);
      expect(JSON.stringify(mine)).not.toContain('SIBLING-SECRET');
    });
    it('another business of another tenant or workspace, an unknown id and a malformed id are all BUSINESS_NOT_FOUND / REQUEST_INVALID, with no information about the other party', async () => {
      const a = await world(); await seed(a); const b = await world(); await seed(b);
      const foreign = await extractor.extract(b.ctx, req(a) as any);
      const missing = await extractor.extract(b.ctx, req(b, { businessId: randomUUID() }) as any);
      expect(foreign).toEqual({ ok: false, code: 'BUSINESS_NOT_FOUND', issueCount: 0, issues: [] }); expect(missing).toEqual(foreign);
      const otherWorkspace = await extractor.extract({ ...a.ctx, workspaceId: randomUUID() }, req(a) as any);
      expect(otherWorkspace).toMatchObject({ ok: false });
      for (const bad of ['', 'x', null, 5]) expect(await extractor.extract(a.ctx, req(a, { businessId: bad }) as any), String(bad)).toEqual({ ok: false, code: 'REQUEST_INVALID', issueCount: 0, issues: [] });
    });
    it('refuses a malformed period or correlation id before any query', async () => {
      const w = await world();
      for (const over of [{ periodStart: '2026-01-01' }, { periodEnd: '2026-01-01T00:00:00Z' }, { periodStart: PERIOD.periodEnd, periodEnd: PERIOD.periodStart }, { correlationId: 'c' }, { boPublicationPackageId: 'p' }]) {
        expect(await extract(w, over), JSON.stringify(over)).toMatchObject({ ok: false, code: 'REQUEST_INVALID' });
      }
    });
  });

  describe('sensitive data and BO immutability', () => {
    it('never reads or returns notes, the performing person or the storage time: the artifact carries none of them', async () => {
      const w = await world(); await seed(w);
      const r = await extract(w); if (!r.ok) throw new Error('x');
      const text = JSON.stringify(r.evidence);
      expect(text).not.toContain('SECRET-NOTE'); expect(text).not.toMatch(/notes|performedBy|performed_by|createdAt|created_at/);
    });
    it('is read-only and leaves every BO record byte-identical: only SELECTs, a fixed column list, the BO tables it reads are the ledger and the header', async () => {
      const w = await world(); await seed(w); const h = await header(w);
      const bo = async () => JSON.stringify([await q(`SELECT * FROM ${BO}.inventory_movements WHERE business_id = $1 ORDER BY id`, [w.businessId]), await q(`SELECT * FROM ${BO}.inventory_balances WHERE business_id = $1 ORDER BY id`, [w.businessId]),
        await q(`SELECT * FROM ${BO}.bo_publication_packages WHERE business_id = $1 ORDER BY id`, [w.businessId]), await q(`SELECT * FROM ${BO}.bo_handoff_records WHERE business_id = $1 ORDER BY id`, [w.businessId])]);
      const before = await bo();
      const pool = getPool(); const statements: Array<{ text: string; values?: unknown[] }> = []; const originalConnect = pool.connect.bind(pool);
      vi.spyOn(pool, 'connect').mockImplementation((async () => {
        const client = await originalConnect(); const original = client.query.bind(client);
        (client as unknown as { query: unknown }).query = (...args: unknown[]) => { const a0 = args[0] as string | { text: string }; statements.push({ text: typeof a0 === 'string' ? a0 : a0.text, values: args[1] as unknown[] }); return (original as (...x: unknown[]) => unknown)(...args); };
        return client;
      }) as never);
      try { expect((await extract(w, { boPublicationPackageId: h })).ok).toBe(true); } finally { vi.restoreAllMocks(); }
      const sql = statements.map((s) => s.text);
      expect(sql.filter((s) => /^\s*(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE)\b/i.test(s))).toEqual([]);
      const touched = new Set(sql.flatMap((s) => s.match(/business_operations\.[a-z_]+/g) ?? [])); expect([...touched].sort()).toEqual(['business_operations.bo_publication_packages', 'business_operations.inventory_movements']);
      const ledger = sql.find((s) => /FROM business_operations\.inventory_movements/.test(s))!;
      expect(ledger).not.toMatch(/\bnotes\b|performed_by|created_at|\*\s+FROM|SELECT\s+\*|m\.\*/i);
      const ledgerCall = statements.find((s) => s.text === ledger)!; expect(ledgerCall.values![5]).toBe(INVENTORY_MOVEMENT_EVIDENCE.maxRecords + 1); // one past the bound: oversize is detected, never truncated
      expect(await bo()).toBe(before);
    });
    it('the ledger is append-only in the database (migration 0184), so a published movement cannot be altered behind the evidence', async () => {
      const w = await world(); await seed(w);
      const [m] = await q(`SELECT id FROM ${BO}.inventory_movements WHERE business_id = $1 LIMIT 1`, [w.businessId]);
      const refused = await withTenantTransaction(w.ctx, (c) => c.query(`UPDATE ${BO}.inventory_movements SET quantity = 1 WHERE id = $1`, [m.id])).then(() => null, (e: Error) => e);
      expect(refused).not.toBeNull();
    });
    it('a historical row with a cost and no currency refuses the whole extraction (the currency is never invented); the rest of the ledger is unaffected', async () => {
      const w = await world(); await seed(w);
      const c = await admin.connect();
      try {
        // Rows from before migration 0183 can hold a cost with no currency; the presence check (NOT VALID) now refuses new ones, so the historical state is recreated inside ONE
        // transaction that drops and re-adds exactly that constraint around the insert, and the constraint definition is asserted unchanged afterwards.
        const presence = `SELECT pg_get_constraintdef(oid) AS def, convalidated FROM pg_constraint WHERE conrelid = 'business_operations.inventory_movements'::regclass AND conname = 'inventory_movements_unit_cost_currency_presence'`;
        const original = (await c.query(presence)).rows[0];
        await c.query('BEGIN'); await c.query("SET LOCAL session_replication_role = 'replica'");
        await c.query(`ALTER TABLE ${BO}.inventory_movements DROP CONSTRAINT inventory_movements_unit_cost_currency_presence`);
        const [item] = (await c.query(`SELECT id FROM platform.inventory_items WHERE business_id = $1`, [w.businessId])).rows; const [wh] = (await c.query(`SELECT id FROM platform.warehouses WHERE business_id = $1`, [w.businessId])).rows;
        await c.query(`INSERT INTO ${BO}.inventory_movements (tenant_id, workspace_id, business_id, inventory_item_id, warehouse_id, movement_type, quantity, unit_cost, occurred_at) VALUES ($1,$2,$3,$4,$5,'receipt',1,5,'2026-01-05T00:00:00Z')`, [w.tenantId, w.workspaceId, w.businessId, item.id, wh.id]);
        await c.query(`ALTER TABLE ${BO}.inventory_movements ADD CONSTRAINT inventory_movements_unit_cost_currency_presence CHECK ((unit_cost IS NULL) = (unit_cost_currency IS NULL)) NOT VALID`);
        await c.query('COMMIT');
        expect((await c.query(presence)).rows[0]).toEqual(original);
      } finally { c.release(); }
      const r = await extract(w); expect(r).toMatchObject({ ok: false, code: 'EVIDENCE_REJECTED' }); if (r.ok) return;
      expect(r.issues.map((i) => i.code)).toEqual(['RECORD_COST_CURRENCY_UNPROVEN']); expect(JSON.stringify(r)).not.toMatch(/SECRET|tenant|business_/i);
      expect((await extract(w, { periodStart: '2026-01-10T00:00:00.000Z' })).ok).toBe(true);
    });
  });
});
