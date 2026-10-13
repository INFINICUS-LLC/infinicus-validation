/**
 * AC-2 Block 3 - DAL ingestion proof (real PostgreSQL, production buildApp, production DAL service and BO intake route).
 *
 * The first-action source facts (warehouse, item, receipt with unit cost and currency, issue history with business instants) enter ONLY as published DAL
 * records: manual intake -> validation / quality / provenance -> publication package -> BO intake route -> mappers -> the BO command executor. No BO or
 * platform row is written by this test except the tenant/business shell and the actor. Data Acquisition writes no operational truth (asserted); the
 * baseline reorder policy and the declared currency are deliberately NOT part of DAL (owner rulings D2, D3) and stay unset here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { loadConfig } from '@infinicus/configuration';
import { closePool, createPool } from '@infinicus/database';
import { buildApp } from '../src/app.js';
import { deleteMovementsForTenants } from './helpers/movementCleanup.js';
import { DAY, dalKit, firstActionRecords, type World } from './helpers/dalIngestion.js';

const run = !!process.env.DATABASE_URL && !!process.env.ADMIN_DATABASE_URL;

let app: FastifyInstance;
let admin: Pool;
const tenantIds: string[] = [];
let kit: ReturnType<typeof dalKit>;
const world = () => kit.world();
const publishThroughDal = (w: World, records: unknown[]) => kit.publishThroughDal(w, records);
const boIntake = (w: World, packageId: string) => kit.boIntake(w, packageId);
const count = (sql: string, params: unknown[]) => kit.count(sql, params);
const boRows = (w: World) => kit.boRows(w);

describe.runIf(run)('AC-2 Block 3: first-action source facts enter Business Operations only through Data Acquisition', () => {
  beforeAll(async () => {
    createPool({ connectionString: process.env.DATABASE_URL! });
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
    app = await buildApp(loadConfig({ DATABASE_URL: process.env.DATABASE_URL!, NODE_ENV: 'test', LOG_LEVEL: 'silent', RATE_LIMIT_MAX: '5000' }));
    await app.ready();
    kit = dalKit({ app, admin, tenantIds });
  });
  afterAll(async () => {
    await app?.close();
    if (tenantIds.length > 0) await deleteMovementsForTenants(admin, tenantIds);
    await admin?.end(); await closePool();
  });

  it('DAL validates, scores and records provenance for every record, and writes NO operational truth before BO intake', async () => {
    const w = await world();
    const { intake, packageId } = await publishThroughDal(w, firstActionRecords('SKU-A', 'WH-A'));
    expect(intake).toMatchObject({ recordsReceived: 15, recordsAccepted: 15, recordsRejected: 0, state: 'validated' });
    expect(intake.provenanceIds).toHaveLength(15);
    const rows = boRows(w);
    expect([await rows.items(), await rows.warehouses(), await rows.movements(), await rows.balances()]).toEqual([0, 0, 0, 0]); // DAL is not an operational source of truth
    expect(packageId).toBeTruthy();
  });

  it('BO canonicalizes the published records: item, warehouse, receipt cost and currency, dated issue history and the balance - with DAL provenance', async () => {
    const w = await world();
    const { intake, packageId } = await publishThroughDal(w, firstActionRecords('SKU-B', 'WH-B'));
    const res = await boIntake(w, packageId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ publicationPackageId: packageId, idempotentReplay: false, acceptedRecordCount: 15, commandCount: 15 });

    const item = (await admin.query(`SELECT id, sku::text sku, name, unit_of_measure, status, source_system, source_record_id, created_by, tenant_id, workspace_id FROM platform.inventory_items WHERE business_id=$1`, [w.businessId])).rows;
    expect(item).toHaveLength(1);
    expect(item[0]).toMatchObject({ sku: 'SKU-B', name: 'Widget', unit_of_measure: 'unit', status: 'active', source_system: 'INFINICUS_DA', created_by: w.ctx.userId, tenant_id: w.ctx.tenantId, workspace_id: w.ctx.workspaceId });
    expect(item[0].source_record_id).toMatch(/#1$/); // submission#recordIndex: traceable to the DAL record
    const wh = (await admin.query(`SELECT warehouse_code::text c, name, source_system FROM platform.warehouses WHERE business_id=$1`, [w.businessId])).rows;
    expect(wh).toEqual([{ c: 'WH-B', name: 'Main warehouse', source_system: 'INFINICUS_DA' }]);

    const receipt = (await admin.query(`SELECT quantity::text q, unit_cost::text c, unit_cost_currency cur, occurred_at, inventory_item_id FROM business_operations.inventory_movements WHERE business_id=$1 AND movement_type='receipt'`, [w.businessId])).rows;
    expect(receipt).toHaveLength(1);
    expect(receipt[0]).toMatchObject({ q: '1000.0000', cur: 'USD', inventory_item_id: item[0].id });
    expect(Number(receipt[0].c)).toBe(10);
    expect(Math.round((Date.now() - new Date(receipt[0].occurred_at).getTime()) / DAY)).toBe(5); // the SOURCE's business instant, not the intake time
    const issues = (await admin.query(`SELECT occurred_at FROM business_operations.inventory_movements WHERE business_id=$1 AND movement_type='issue' ORDER BY occurred_at`, [w.businessId])).rows;
    expect(issues).toHaveLength(12);
    expect(new Set(issues.map((r: any) => new Date(r.occurred_at).toISOString().slice(0, 10))).size).toBe(12); // twelve distinct days of demand history

    const bal = (await admin.query(`SELECT quantity_on_hand::text q, reorder_point::text rp, reorder_quantity::text rq, reorder_policy_state st FROM business_operations.inventory_balances WHERE business_id=$1`, [w.businessId])).rows;
    expect(bal).toHaveLength(1);
    expect(bal[0]).toMatchObject({ q: '100.0000', st: 'UNSET' }); // 1000 received - 12 x 75 issued
    expect(Number(bal[0].rp)).toBe(0); expect(Number(bal[0].rq)).toBe(0); // DAL never sets the baseline policy (ruling D2)

    // every canonical write is traceable to a DAL provenance record of this run
    const prov = await admin.query(`SELECT count(*)::int n FROM data_acquisition.provenance_records WHERE collection_run_id=$1`, [intake.collectionRunId]);
    expect(prov.rows[0].n).toBe(15);
    // the declared currency is a business-admin act, not a DAL fact (ruling D3): nothing was declared
    expect(await count(`SELECT count(*) n FROM platform.business_currency_declarations WHERE business_id=$1`, [w.businessId])).toBe(0);
  });

  it('a replay of the same published package is idempotent: nothing is written twice', async () => {
    const w = await world();
    const { packageId } = await publishThroughDal(w, firstActionRecords('SKU-C', 'WH-C'));
    expect((await boIntake(w, packageId)).statusCode).toBe(200);
    const rows = boRows(w);
    const before = [await rows.items(), await rows.warehouses(), await rows.movements(), await rows.balances()];
    const again = await boIntake(w, packageId);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ idempotentReplay: true, commandCount: 0 });
    expect([await rows.items(), await rows.warehouses(), await rows.movements(), await rows.balances()]).toEqual(before);
  });

  it('a package that names an unknown SKU, a future instant or a conflicting master record is refused whole: no partial BO truth', async () => {
    const w = await world();
    const cases: [string, Record<string, unknown>[], RegExp][] = [
      ['unknown SKU', [{ recordType: 'warehouse', data: { warehouseCode: 'WH-D', name: 'W' } }, { recordType: 'inventory_movement', data: { sku: 'NOPE', warehouseCode: 'WH-D', movementType: 'receipt', quantity: 1, unitCost: 1, unitCostCurrency: 'USD' } }], /not found in business scope/],
      ['future instant', [{ recordType: 'warehouse', data: { warehouseCode: 'WH-E', name: 'W' } }, { recordType: 'inventory_item', data: { sku: 'SKU-E', name: 'E' } }, { recordType: 'inventory_movement', data: { sku: 'SKU-E', warehouseCode: 'WH-E', movementType: 'receipt', quantity: 1, unitCost: 1, unitCostCurrency: 'USD', occurredAt: new Date(Date.now() + 3 * DAY).toISOString() } }], /must not be in the future/],
      ['cost without currency', [{ recordType: 'warehouse', data: { warehouseCode: 'WH-F', name: 'W' } }, { recordType: 'inventory_item', data: { sku: 'SKU-F', name: 'F' } }, { recordType: 'inventory_movement', data: { sku: 'SKU-F', warehouseCode: 'WH-F', movementType: 'receipt', quantity: 1, unitCost: 1 } }], /unitCostCurrency_required_with_unitCost/],
    ];
    for (const [name, records, message] of cases) {
      const { packageId } = await publishThroughDal(w, records);
      const res = await boIntake(w, packageId);
      expect(res.statusCode, name).toBeGreaterThanOrEqual(400);
      expect(res.body, name).toMatch(message);
    }
    const rows = boRows(w);
    expect([await rows.items(), await rows.warehouses(), await rows.movements(), await rows.balances()], 'one transaction per package: nothing from a refused package persists').toEqual([0, 0, 0, 0]);
  });

  it('changing master data is not an ingestion action: the same SKU with a different name is refused and the original stands', async () => {
    const w = await world();
    const first = await publishThroughDal(w, [{ recordType: 'inventory_item', data: { sku: 'SKU-G', name: 'Original' } }]);
    expect((await boIntake(w, first.packageId)).statusCode).toBe(200);
    const second = await publishThroughDal(w, [{ recordType: 'inventory_item', data: { sku: 'SKU-G', name: 'Renamed' } }]);
    const res = await boIntake(w, second.packageId);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.body).toMatch(/different attributes/);
    expect((await admin.query(`SELECT name FROM platform.inventory_items WHERE business_id=$1`, [w.businessId])).rows).toEqual([{ name: 'Original' }]);
  });

  it('scope comes from the authenticated context, never from the record: a record cannot place data in another business or tenant', async () => {
    const a = await world(); const b = await world();
    const records = [{ recordType: 'inventory_item', data: { sku: 'SKU-H', name: 'H', businessId: b.businessId, tenantId: b.ctx.tenantId, workspaceId: b.ctx.workspaceId } }];
    const { packageId } = await publishThroughDal(a, records);
    expect((await boIntake(a, packageId)).statusCode).toBe(200);
    expect(await count(`SELECT count(*) n FROM platform.inventory_items WHERE business_id=$1`, [b.businessId])).toBe(0);
    expect(await count(`SELECT count(*) n FROM platform.inventory_items WHERE business_id=$1 AND tenant_id=$2`, [a.businessId, a.ctx.tenantId])).toBe(1);
    // and the other tenant cannot consume this tenant's package
    const foreign = await boIntake({ ...b, businessId: a.businessId }, packageId);
    expect(foreign.statusCode).toBeGreaterThanOrEqual(400);
  });
});
