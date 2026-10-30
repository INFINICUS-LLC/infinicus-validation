/**
 * BO-ID-UUID-02 on real PostgreSQL, as the least-privilege application role: the uuid-typed identifiers of Business Operations commands are canonical UUIDs
 * before any SQL; a malformed one is refused with a deterministic message that names the field and not the value; valid identifiers (either case) behave as
 * before; identifiers stored in text columns are untouched; tenant and business isolation are unchanged; replay stays idempotent.
 *
 *   direct:      OperationalCommandExecutor, with the transaction client wrapped so every query the executor issues is counted
 *   end to end:  DAL submitManualIntake ('operations' = legacy, 'operations_prepared' = prepared) -> publish -> BusinessIntakeService.processHandoff
 *
 * Requires DATABASE_URL (application role) and ADMIN_DATABASE_URL (operator; fixtures and assertions only).
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- tests read arbitrary rows */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { closePool, createPool, withTenantTransaction, type TenantContext } from '@infinicus/database';
import { DataAcquisitionService } from '@infinicus/data-acquisition-runtime';
import type { DALToBOHandoff } from '@infinicus/handoff-contracts';
import { OperationalCommandExecutor } from '../src/OperationalCommandExecutor.js';
import { BusinessIntakeService } from '../src/intake/BusinessIntakeService.js';
import { OperationalMappingError } from '../src/errors.js';
import { uuidFieldProblem } from '../src/uuidReference.js';
import type { ConfigureInventoryReorderPolicyCommand, OperationalCommand } from '../src/types.js';
import { deleteMovementsForTenants } from './helpers/movementCleanup.js';

const run = Boolean(process.env.DATABASE_URL && process.env.ADMIN_DATABASE_URL);
const BO = 'business_operations';
const GOOD = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const MALFORMED = ['not-a-uuid', '', ` ${GOOD}`, `{${GOOD}}`, GOOD.replaceAll('-', ''), `${GOOD}'; DROP TABLE platform.suppliers; --`, 12345 as unknown];

describe.runIf(run)('BO-ID-UUID-02: command identifiers at the command boundary (real PostgreSQL)', () => {
  let admin: Pool;
  const tenantIds: string[] = [];
  const executor = new OperationalCommandExecutor();
  const da = new DataAcquisitionService();
  const bo = new BusinessIntakeService();
  let seq = 0;
  const unique = (p: string) => `${p}-${Date.now()}-${++seq}`;

  beforeAll(() => {
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
    createPool({ connectionString: process.env.DATABASE_URL as string });
  });
  afterAll(async () => { await deleteMovementsForTenants(admin, tenantIds).catch(() => undefined); await admin?.end(); await closePool(); });

  interface Biz { businessId: string; item: string; sku: string; warehouse: string; warehouseCode: string; supplier: string; asset: string }
  interface World extends Biz { ctx: TenantContext; tenantId: string; workspaceId: string; sibling: Biz }
  async function world(): Promise<World> {
    const tenantId = randomUUID(); const workspaceId = randomUUID(); const userId = randomUUID();
    tenantIds.push(tenantId);
    const slug = `ci${tenantId.slice(0, 8)}`;
    await admin.query(`INSERT INTO tenancy.tenants (id, name, slug, status, plan_code) VALUES ($1,$2,$3,'active','test')`, [tenantId, slug, slug]);
    await admin.query(`INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,$3,$4,'active')`, [workspaceId, tenantId, slug, slug]);
    await admin.query(`INSERT INTO identity.users (id, email, status) VALUES ($1,$2,'active')`, [userId, `${slug}@identifiers.example.test`]);
    const biz = async (): Promise<Biz> => {
      const businessId = (await admin.query(`INSERT INTO platform.businesses (tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,'Identifier biz',$3,'active') RETURNING id`, [tenantId, workspaceId, unique('id-biz')])).rows[0].id as string;
      const sku = unique('SKU'); const warehouseCode = unique('WH');
      const item = (await admin.query(`INSERT INTO platform.inventory_items (tenant_id, workspace_id, business_id, sku, name, status) VALUES ($1,$2,$3,$4,'Item','active') RETURNING id`, [tenantId, workspaceId, businessId, sku])).rows[0].id as string;
      const warehouse = (await admin.query(`INSERT INTO platform.warehouses (tenant_id, workspace_id, business_id, warehouse_code, name) VALUES ($1,$2,$3,$4,'WH') RETURNING id`, [tenantId, workspaceId, businessId, warehouseCode])).rows[0].id as string;
      const supplier = (await admin.query(`INSERT INTO platform.suppliers (tenant_id, workspace_id, business_id, name, supplier_code, risk_status, status) VALUES ($1,$2,$3,'Supplier',$4,'low','active') RETURNING id`, [tenantId, workspaceId, businessId, unique('sup')])).rows[0].id as string;
      const asset = (await admin.query(`INSERT INTO platform.assets (tenant_id, workspace_id, business_id, asset_code, name, asset_type, condition_status, status) VALUES ($1,$2,$3,$4,'Cold Room','equipment','good','active') RETURNING id`, [tenantId, workspaceId, businessId, unique('ASSET')])).rows[0].id as string;
      return { businessId, item, sku, warehouse, warehouseCode, supplier, asset };
    };
    const a = await biz(); const sibling = await biz();
    return { ...a, ctx: { tenantId, workspaceId, userId }, tenantId, workspaceId, sibling };
  }
  const context = (w: World, over: Record<string, unknown> = {}) => ({ tenantId: w.tenantId, workspaceId: w.workspaceId, businessId: w.businessId, correlationId: randomUUID(), sourceReference: 'submission-1#0', provenanceReference: randomUUID(), idempotencyKey: `dal-to-bo:${randomUUID()}:1:submission-1#0`, actorId: 'actor-1', occurredAt: new Date().toISOString(), ...over });
  const cmd = (w: World, type: string, payload: Record<string, unknown>, over: Record<string, unknown> = {}) => ({ type, context: context(w, over), payload }) as unknown as OperationalCommand;

  /** Runs `fn` in a tenant transaction with the client wrapped so that every query the executor issues is counted. */
  async function counted<T>(w: World, fn: (client: PoolClient) => Promise<T>): Promise<{ outcome: T | Error; queries: string[] }> {
    const queries: string[] = [];
    let outcome: T | Error;
    try {
      outcome = await withTenantTransaction(w.ctx, async (client) => {
        const spied = new Proxy(client, { get(target, prop) {
          if (prop === 'query') return (...args: any[]) => { queries.push(String(typeof args[0] === 'string' ? args[0] : args[0]?.text).replace(/\s+/g, ' ').slice(0, 70)); return (target.query as any)(...args); };
          const v = Reflect.get(target, prop, target); return typeof v === 'function' ? v.bind(target) : v;
        } });
        return fn(spied as PoolClient);
      });
    } catch (e) { outcome = e as Error; }
    return { outcome, queries };
  }
  const execute = (w: World, command: OperationalCommand) => counted(w, (client) => executor.executeOn(client, w.ctx, command));
  const q = async (sql: string, args: unknown[]) => (await admin.query(sql, args)).rows;
  const state = async (w: World) => {
    const n = async (sql: string) => (await q(sql, [w.tenantId]))[0].n as number;
    return {
      movements: await n(`SELECT count(*)::int n FROM ${BO}.inventory_movements WHERE tenant_id=$1`), balances: await n(`SELECT count(*)::int n FROM ${BO}.inventory_balances WHERE tenant_id=$1`),
      orders: await n(`SELECT count(*)::int n FROM ${BO}.purchase_orders WHERE tenant_id=$1`), scores: await n(`SELECT count(*)::int n FROM ${BO}.supplier_performance_scores WHERE tenant_id=$1`),
      inspections: await n(`SELECT count(*)::int n FROM ${BO}.asset_inspections WHERE tenant_id=$1`), events: await n(`SELECT count(*)::int n FROM events.outbox_events WHERE tenant_id=$1`),
      facts: await n(`SELECT count(*)::int n FROM ${BO}.business_events WHERE tenant_id=$1`),
    };
  };

  const builders: { name: string; fields: string[]; make: (w: World, p: Record<string, unknown>, c?: Record<string, unknown>) => OperationalCommand }[] = [
    { name: 'record_inventory_movement', fields: ['inventoryItemId', 'warehouseId'], make: (w, p, c) => cmd(w, 'record_inventory_movement', { inventoryItemId: w.item, warehouseId: w.warehouse, movementType: 'receipt', quantity: 2, ...p }, c) },
    { name: 'record_keyed_inventory_movement', fields: ['inventoryItemId', 'warehouseId'], make: (w, p, c) => { const payload: Record<string, unknown> = { inventoryItemSku: w.sku, warehouseCode: w.warehouseCode, movementType: 'receipt', quantity: 2, ...p }; if ('inventoryItemId' in p) delete payload.inventoryItemSku; if ('warehouseId' in p) delete payload.warehouseCode; return cmd(w, 'record_keyed_inventory_movement', payload, c); } },
    { name: 'create_purchase_order', fields: ['supplierId'], make: (w, p, c) => cmd(w, 'create_purchase_order', { supplierId: w.supplier, poNumber: unique('PO'), currencyCode: 'USD', ...p }, c) },
    { name: 'record_supplier_performance', fields: ['supplierId'], make: (w, p, c) => cmd(w, 'record_supplier_performance', { supplierId: w.supplier, periodStart: '2026-01-01', periodEnd: '2026-01-31', qualityScore: 1, deliveryScore: 1, priceScore: 1, serviceScore: 1, overallScore: 1, ...p }, c) },
    { name: 'record_asset_inspection', fields: ['assetId'], make: (w, p, c) => cmd(w, 'record_asset_inspection', { assetId: w.asset, conditionRating: 'good', pass: true, ...p }, c) },
  ];

  describe('direct commands', () => {
    it.each(builders.map((b) => [b.name, b] as const))('%s: every malformed identifier (payload and context) is refused with the field-naming message, with ZERO queries and nothing written', async (_n, b) => {
      const w = await world();
      const before = await state(w);
      for (const field of b.fields) {
        for (const bad of MALFORMED) {
          const { outcome, queries } = await execute(w, b.make(w, { [field]: bad }));
          expect(outcome).toBeInstanceOf(OperationalMappingError);
          expect((outcome as Error).message).toBe(uuidFieldProblem(field));
          expect((outcome as any).code, `SQLSTATE for ${field}=${JSON.stringify(bad)}`).toBeUndefined();
          if (typeof bad === 'string' && bad.trim().length > 0) expect((outcome as Error).message).not.toContain(bad.trim());
          expect(queries, `queries issued for ${field}=${JSON.stringify(bad)}`).toEqual([]);
        }
      }
      for (const field of ['businessId', 'correlationId', 'causationId']) {
        const { outcome, queries } = await execute(w, b.make(w, {}, { [field]: 'not-a-uuid' }));
        expect((outcome as Error).message).toBe(uuidFieldProblem(field));
        expect(queries).toEqual([]);
      }
      expect(await state(w)).toEqual(before);
    });

    it('valid identifiers in lower, upper and mixed case behave as before: every command is applied and the stored ids are the lower-case values', async () => {
      const w = await world();
      const upper = (s: string) => s.toUpperCase();
      const mixed = (s: string) => s.split('').map((ch, i) => (i % 2 ? ch.toUpperCase() : ch)).join('');
      for (const f of [(s: string) => s, upper, mixed]) {
        const results = [
          await execute(w, builders[0].make(w, { inventoryItemId: f(w.item), warehouseId: f(w.warehouse) })),
          await execute(w, builders[1].make(w, { inventoryItemId: f(w.item), warehouseId: f(w.warehouse) })),
          await execute(w, builders[2].make(w, { supplierId: f(w.supplier) })),
          await execute(w, builders[3].make(w, { supplierId: f(w.supplier) })),
          await execute(w, builders[4].make(w, { assetId: f(w.asset) })),
        ];
        for (const r of results) { expect(r.outcome, String((r.outcome as Error)?.message)).not.toBeInstanceOf(Error); expect(r.queries.length).toBeGreaterThan(0); }
      }
      expect(await state(w)).toMatchObject({ movements: 6, orders: 3, scores: 3, inspections: 3 });
      expect((await q(`SELECT DISTINCT supplier_id::text s FROM ${BO}.purchase_orders WHERE tenant_id=$1`, [w.tenantId])).map((r: any) => r.s)).toEqual([w.supplier]);
      expect((await q(`SELECT DISTINCT asset_id::text s FROM ${BO}.asset_inspections WHERE tenant_id=$1`, [w.tenantId])).map((r: any) => r.s)).toEqual([w.asset]);
      expect((await q(`SELECT quantity_on_hand::text qoh FROM ${BO}.inventory_balances WHERE tenant_id=$1`, [w.tenantId]))[0].qoh).toBe('12.0000');
    });

    it('configureInventoryReorderPolicy: malformed ids are refused with zero queries; valid upper-case ids are applied', async () => {
      const w = await world();
      await execute(w, builders[0].make(w, {})); // a balance for the policy to configure
      const configure = (p: Record<string, unknown>, c: Record<string, unknown> = {}) => ({ type: 'configure_inventory_reorder_policy', context: context(w, c), payload: { inventoryItemId: w.item, warehouseId: w.warehouse, reorderPoint: 5, reorderQuantity: 20, ...p } }) as unknown as ConfigureInventoryReorderPolicyCommand;
      for (const [field, bad] of [['inventoryItemId', 'nope'], ['warehouseId', `{${GOOD}}`], ['inventoryItemId', ''], ['warehouseId', 12345 as unknown]] as const) {
        const { outcome, queries } = await counted(w, (client) => executor.configureInventoryReorderPolicy(client, w.ctx, configure({ [field]: bad })));
        expect((outcome as Error).message).toBe(uuidFieldProblem(field));
        expect(queries).toEqual([]);
      }
      const bad = await counted(w, (client) => executor.configureInventoryReorderPolicy(client, w.ctx, configure({}, { correlationId: 'x' })));
      expect((bad.outcome as Error).message).toBe(uuidFieldProblem('correlationId'));
      const ok = await counted(w, (client) => executor.configureInventoryReorderPolicy(client, w.ctx, configure({ inventoryItemId: w.item.toUpperCase(), warehouseId: w.warehouse.toUpperCase() })));
      expect(ok.outcome).toMatchObject({ applied: true });
      expect((await q(`SELECT reorder_point::text rp, reorder_policy_state st FROM ${BO}.inventory_balances WHERE tenant_id=$1`, [w.tenantId]))[0]).toEqual({ rp: '5.0000', st: 'CONFIGURED' });
    });

    it('identifiers stored in text columns are accepted exactly as before (they are not UUIDs): workforce memberId, operational-fact customerId and memberId', async () => {
      const w = await world();
      const a = await execute(w, cmd(w, 'record_workforce_event', { memberId: 'EMP-42', action: 'hire', hours: 8 }));
      const b = await execute(w, cmd(w, 'record_operational_fact', { eventType: 'sale', amount: 10, customerId: 'CUST-7 (ünï)', memberId: 'not-a-uuid' }));
      expect(a.outcome).not.toBeInstanceOf(Error); expect(b.outcome).not.toBeInstanceOf(Error);
      expect(await q(`SELECT member_id, customer_id FROM ${BO}.business_events WHERE tenant_id=$1 ORDER BY created_at`, [w.tenantId])).toEqual([{ member_id: 'EMP-42', customer_id: null }, { member_id: 'not-a-uuid', customer_id: 'CUST-7 (ünï)' }]);
    });

    it('tenant and business isolation is unchanged: a well-formed id from ANOTHER business is refused by BO as not found in scope, and nothing is written', async () => {
      const w = await world();
      const before = await state(w);
      const foreign: [string, OperationalCommand, string][] = [
        ['inventory item', builders[0].make(w, { inventoryItemId: w.sibling.item }), 'inventory_items'],
        ['warehouse', builders[0].make(w, { warehouseId: w.sibling.warehouse }), 'warehouses'],
        ['supplier (order)', builders[2].make(w, { supplierId: w.sibling.supplier }), 'suppliers'],
        ['supplier (performance)', builders[3].make(w, { supplierId: w.sibling.supplier }), 'suppliers'],
        ['asset', builders[4].make(w, { assetId: w.sibling.asset }), 'assets'],
      ];
      for (const [, command, table] of foreign) {
        const { outcome } = await execute(w, command);
        expect(outcome).toBeInstanceOf(OperationalMappingError);
        expect((outcome as Error).message).toMatch(new RegExp(`^${table} entity not found in business scope: `));
      }
      expect(await state(w)).toEqual(before);
      // and a command whose context names another tenant is still refused by the unchanged scope check, before the identifier check
      const other = await execute(w, builders[2].make(w, { supplierId: 'bad' }, { tenantId: randomUUID() }));
      expect((other.outcome as Error).message).toBe('Command tenant/workspace scope does not match active context.');
    });
  });

  describe('end to end from the Data Acquisition Layer', () => {
    async function ingest(w: World, submissionType: 'operations' | 'operations_prepared', record: Record<string, unknown>) {
      const source = await da.registerSource(w.ctx, { businessId: w.businessId, name: 'identifier source', sourceCode: unique('src'), sourceType: 'manual', sensitivityLevel: 'internal', status: 'active' });
      const intake = await da.submitManualIntake(w.ctx, { businessId: w.businessId, dataSourceId: source.id, submissionType, records: [record], sourceReference: 'integration://identifiers', submittedBy: w.ctx.userId });
      if (intake.state !== 'validated') return { intake, handoff: null as DALToBOHandoff | null, packageId: null as string | null };
      const prepared = await da.preparePublicationPackage(w.ctx, w.businessId, intake.collectionRunId, { targetBlock: 'BO-RUNTIME' });
      const published = await da.publishPackage(w.ctx, w.businessId, prepared.id);
      const handoff: DALToBOHandoff = {
        handoffId: unique('handoff'), sourceLayer: 'DAL', sourceBlock: 'DA-24', targetLayer: 'BO', targetBlock: 'BO-RUNTIME', correlationId: published.correlationId, lineage: [], status: 'ready', createdAt: new Date().toISOString(),
        payload: { contractVersion: '1.0.0', tenantId: w.tenantId, workspaceId: w.workspaceId, businessId: w.businessId, publicationPackageId: published.id, packageType: published.packageType, packageVersion: published.packageVersion, targetLayer: 'business_operations', targetBlock: published.targetBlock, status: 'published', publishedAt: published.publishedAt!.toISOString(), recordCount: published.recordCount, source: { sourceSystem: 'INFINICUS_DA', dataReference: published.dataReference as any }, schemaReferenceId: published.schemaReferenceId, quality: { qualityScore: published.qualityScore, reliabilityScore: published.reliabilityScore }, provenanceReferenceIds: published.provenanceReferenceIds as string[], consentReferenceIds: [], limitations: (published.limitations as unknown[]).map(String), warnings: [], idempotencyKey: `dal-to-bo:${published.id}:${published.packageVersion}` },
      };
      return { intake, handoff, packageId: published.id };
    }
    const order = (supplierId: unknown) => ({ recordType: 'purchase_order', data: { supplierId, poNumber: unique('PO-E2E'), currencyCode: 'USD' } });
    const movement = (data: Record<string, unknown>) => ({ recordType: 'inventory_movement', data: { movementType: 'receipt', quantity: 3, ...data } });

    it.each(['operations', 'operations_prepared'] as const)('%s: a valid upper-case supplier is applied once; replaying the delivered package is a no-op', async (type) => {
      const w = await world();
      const { handoff } = await ingest(w, type, order(w.supplier.toUpperCase()));
      expect(await bo.processHandoff(w.ctx, handoff!)).toMatchObject({ idempotentReplay: false, commandCount: 1 });
      expect(await q(`SELECT supplier_id::text s FROM ${BO}.purchase_orders WHERE tenant_id=$1`, [w.tenantId])).toEqual([{ s: w.supplier }]);
      expect(await bo.processHandoff(w.ctx, handoff!)).toMatchObject({ idempotentReplay: true, commandCount: 0 });
      expect((await state(w)).orders).toBe(1);
    });

    it('operations (legacy): a malformed supplier reaches BO, is refused with the field-naming message and no raw driver text; nothing is written; the stored rejection does not repeat the value; a retry is refused identically', async () => {
      const w = await world();
      const bad = 'SUP-NOT-A-UUID';
      const { intake, handoff, packageId } = await ingest(w, 'operations', order(bad));
      expect(intake.state).toBe('validated'); // legacy preparation does not decide this; BO does
      const first = await bo.processHandoff(w.ctx, handoff!).then(() => null, (e: unknown) => e as Error);
      expect(first).toBeInstanceOf(OperationalMappingError);
      expect(first!.message).toBe(uuidFieldProblem('supplierId'));
      expect(first!.message).not.toMatch(/invalid input syntax|uuid:/i);
      expect(first!.message).not.toContain(bad);
      const second = await bo.processHandoff(w.ctx, handoff!).then(() => null, (e: unknown) => e as Error);
      expect(second!.message).toBe(first!.message);
      expect((await state(w)).orders).toBe(0);
      const delivery = await q(`SELECT failure_reason FROM data_acquisition.publication_deliveries WHERE publication_package_id=$1`, [packageId]);
      expect(delivery).toHaveLength(1);
      expect(delivery[0].failure_reason).toBe(`OperationalMappingError: ${uuidFieldProblem('supplierId')}`);
      expect(delivery[0].failure_reason).not.toContain(bad);
    });

    it('operations_prepared: the same malformed supplier is quarantined by the DAL before any handoff exists, so BO is never asked', async () => {
      const w = await world();
      const { intake, handoff } = await ingest(w, 'operations_prepared', order('SUP-NOT-A-UUID'));
      expect(intake.state).toBe('quarantined');
      expect(handoff).toBeNull();
      expect((await state(w)).orders).toBe(0);
    });

    it('operations (legacy) keyed movement: explicit upper-case item and warehouse ids are applied; a malformed item id is refused with the field-naming message and nothing is written', async () => {
      const w = await world();
      const good = await ingest(w, 'operations', movement({ inventoryItemId: w.item.toUpperCase(), warehouseId: w.warehouse.toUpperCase() }));
      expect(await bo.processHandoff(w.ctx, good.handoff!)).toMatchObject({ commandCount: 1 });
      expect((await state(w)).movements).toBe(1);
      const bad = await ingest(w, 'operations', movement({ inventoryItemId: 'ITEM-7', warehouseId: w.warehouse }));
      const error = await bo.processHandoff(w.ctx, bad.handoff!).then(() => null, (e: unknown) => e as Error);
      expect(error).toBeInstanceOf(OperationalMappingError);
      expect(error!.message).toBe(uuidFieldProblem('inventoryItemId'));
      expect(error!.message).not.toContain('ITEM-7');
      expect((await state(w)).movements).toBe(1);
    });

    it('operations_prepared movement with a malformed id: either the DAL stops it or BO refuses it with the same sanitized message - never a raw driver error, never a write', async () => {
      const w = await world();
      const { intake, handoff } = await ingest(w, 'operations_prepared', movement({ inventoryItemId: 'ITEM-7', warehouseId: w.warehouse }));
      if (intake.state === 'validated') {
        const error = await bo.processHandoff(w.ctx, handoff!).then(() => null, (e: unknown) => e as Error);
        expect(error!.message).toBe(uuidFieldProblem('inventoryItemId'));
      } else {
        expect(handoff).toBeNull();
      }
      expect((await state(w)).movements).toBe(0);
    });
  });
});
