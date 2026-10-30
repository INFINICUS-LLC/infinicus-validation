/**
 * BO-REF-UUID-01 (F9) on real PostgreSQL, as the least-privilege application role: a malformed inventory-movement `referenceId` is refused at the Business
 * Operations command boundary with a deterministic, value-free message; nothing is written; a valid UUID behaves as before.
 *
 *   direct:      OperationalCommandExecutor.executeOn (record_inventory_movement and record_keyed_inventory_movement)
 *   end to end:  DAL submitManualIntake ('operations' = legacy, 'operations_prepared' = prepared) -> publish -> BusinessIntakeService.processHandoff
 *
 * Requires DATABASE_URL (application role) and ADMIN_DATABASE_URL (operator; fixtures and assertions only).
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- tests read arbitrary rows */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { closePool, createPool, withTenantTransaction, type TenantContext } from '@infinicus/database';
import { DataAcquisitionService } from '@infinicus/data-acquisition-runtime';
import type { DALToBOHandoff } from '@infinicus/handoff-contracts';
import { OperationalCommandExecutor } from '../src/OperationalCommandExecutor.js';
import { BusinessIntakeService } from '../src/intake/BusinessIntakeService.js';
import { OperationalMappingError } from '../src/errors.js';
import { referenceIdProblem } from '../src/uuidReference.js';
import type { OperationalCommand } from '../src/types.js';
import { deleteMovementsForTenants } from './helpers/movementCleanup.js';

const run = Boolean(process.env.DATABASE_URL && process.env.ADMIN_DATABASE_URL);
const BO = 'business_operations';
const GOOD = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

describe.runIf(run)('BO-REF-UUID-01: movement referenceId at the command boundary (real PostgreSQL)', () => {
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

  interface World { ctx: TenantContext; tenantId: string; workspaceId: string; businessId: string; item: string; sku: string; warehouse: string; warehouseCode: string }
  async function world(): Promise<World> {
    const tenantId = randomUUID(); const workspaceId = randomUUID(); const userId = randomUUID();
    tenantIds.push(tenantId);
    const slug = `rf${tenantId.slice(0, 8)}`;
    await admin.query(`INSERT INTO tenancy.tenants (id, name, slug, status, plan_code) VALUES ($1,$2,$3,'active','test')`, [tenantId, slug, slug]);
    await admin.query(`INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,$3,$4,'active')`, [workspaceId, tenantId, slug, slug]);
    await admin.query(`INSERT INTO identity.users (id, email, status) VALUES ($1,$2,'active')`, [userId, `${slug}@reference.example.test`]);
    const businessId = (await admin.query(`INSERT INTO platform.businesses (tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,'Reference biz',$3,'active') RETURNING id`, [tenantId, workspaceId, unique('ref-biz')])).rows[0].id as string;
    const sku = unique('SKU'); const warehouseCode = unique('WH');
    const item = (await admin.query(`INSERT INTO platform.inventory_items (tenant_id, workspace_id, business_id, sku, name, status) VALUES ($1,$2,$3,$4,'Item','active') RETURNING id`, [tenantId, workspaceId, businessId, sku])).rows[0].id as string;
    const warehouse = (await admin.query(`INSERT INTO platform.warehouses (tenant_id, workspace_id, business_id, warehouse_code, name) VALUES ($1,$2,$3,$4,'WH') RETURNING id`, [tenantId, workspaceId, businessId, warehouseCode])).rows[0].id as string;
    return { ctx: { tenantId, workspaceId, userId }, tenantId, workspaceId, businessId, item, sku, warehouse, warehouseCode };
  }
  const context = (w: World) => ({ tenantId: w.tenantId, workspaceId: w.workspaceId, businessId: w.businessId, correlationId: randomUUID(), sourceReference: 'submission-1#0', provenanceReference: randomUUID(), idempotencyKey: `dal-to-bo:${randomUUID()}:1:submission-1#0`, actorId: 'actor-1', occurredAt: new Date().toISOString() });
  const plain = (w: World, referenceId: unknown): OperationalCommand => ({ type: 'record_inventory_movement', context: context(w), payload: { inventoryItemId: w.item, warehouseId: w.warehouse, movementType: 'receipt', quantity: 5, referenceType: 'manual', referenceId } } as unknown as OperationalCommand);
  const keyed = (w: World, referenceId: unknown): OperationalCommand => ({ type: 'record_keyed_inventory_movement', context: context(w), payload: { inventoryItemSku: w.sku, warehouseCode: w.warehouseCode, movementType: 'receipt', quantity: 5, referenceType: 'manual', referenceId } } as unknown as OperationalCommand);
  const exec = (w: World, command: OperationalCommand) => withTenantTransaction(w.ctx, (client) => executor.executeOn(client, w.ctx, command));
  const q = async (sql: string, args: unknown[]) => (await admin.query(sql, args)).rows;
  const state = async (w: World) => ({
    movements: (await q(`SELECT count(*)::int n FROM ${BO}.inventory_movements WHERE tenant_id=$1`, [w.tenantId]))[0].n as number,
    balances: (await q(`SELECT count(*)::int n FROM ${BO}.inventory_balances WHERE tenant_id=$1`, [w.tenantId]))[0].n as number,
    events: (await q(`SELECT count(*)::int n FROM events.outbox_events WHERE tenant_id=$1`, [w.tenantId]))[0].n as number,
  });

  describe('direct commands', () => {
    it.each([['lower case', GOOD, GOOD], ['upper case', GOOD.toUpperCase(), GOOD], ['mixed case', '3F2504e0-4f89-41D3-9a0c-0305E82c3301', GOOD]])(
      'a %s UUID is stored (lower-case) on the ledger row, plain and keyed',
      async (_n, sent, stored) => {
        const w = await world();
        const a = await exec(w, plain(w, sent));
        const b = await exec(w, keyed(w, sent));
        const rows = await q(`SELECT id, reference_type, reference_id::text AS reference_id FROM ${BO}.inventory_movements WHERE tenant_id=$1 ORDER BY created_at`, [w.tenantId]);
        expect(rows.map((r: any) => r.id).sort()).toEqual([a.recordId, b.recordId].sort());
        for (const r of rows) expect(r).toMatchObject({ reference_type: 'manual', reference_id: stored });
        expect((await q(`SELECT quantity_on_hand::text q FROM ${BO}.inventory_balances WHERE tenant_id=$1`, [w.tenantId]))[0].q).toBe('10.0000');
      }
    );

    it('an absent or null referenceId is stored as NULL, as before', async () => {
      const w = await world();
      await exec(w, plain(w, undefined));
      await exec(w, keyed(w, null));
      const rows = await q(`SELECT reference_id FROM ${BO}.inventory_movements WHERE tenant_id=$1`, [w.tenantId]);
      expect(rows).toEqual([{ reference_id: null }, { reference_id: null }]);
    });

    const MALFORMED = ['not-a-uuid', 'PO-2026-0042', '', '   ', ` ${GOOD}`, `${GOOD}\n`, `{${GOOD}}`, GOOD.replaceAll('-', ''), '3f25-04e0-4f89-41d3-9a0c-0305-e82c-3301', `urn:uuid:${GOOD}`, GOOD.slice(0, 35), GOOD.replace('3f25', '3g25'), `${GOOD}'; DROP TABLE x; --`];
    it('every malformed value is refused with the one deterministic message, plain and keyed, and nothing is written, locked into a balance or announced', async () => {
      const w = await world();
      const before = await state(w);
      for (const bad of MALFORMED) {
        for (const command of [plain(w, bad), keyed(w, bad)]) {
          const error = (await exec(w, command).catch((e: unknown) => e)) as Error & { code?: string };
          expect(error).toBeInstanceOf(OperationalMappingError);
          expect(error.message).toBe(referenceIdProblem());
          expect(error.code, `database SQLSTATE for ${JSON.stringify(bad)}`).toBeUndefined(); // it never reached PostgreSQL
          if (bad.trim().length > 0) expect(error.message).not.toContain(bad.trim());
        }
      }
      expect(await state(w)).toEqual(before);
      expect(before).toEqual({ movements: 0, balances: 0, events: 0 });
    });

    it('a refusal inside a transaction that already recorded a valid movement is rolled back with it (no partial ledger)', async () => {
      const w = await world();
      await expect(withTenantTransaction(w.ctx, async (client) => {
        await executor.executeOn(client, w.ctx, plain(w, GOOD));
        await executor.executeOn(client, w.ctx, plain(w, 'broken'));
      })).rejects.toThrow(referenceIdProblem());
      expect((await state(w)).movements).toBe(0);
    });
  });

  describe('end to end from the Data Acquisition Layer', () => {
    async function ingest(w: World, submissionType: 'operations' | 'operations_prepared', data: Record<string, unknown>) {
      const source = await da.registerSource(w.ctx, { businessId: w.businessId, name: 'reference source', sourceCode: unique('src'), sourceType: 'manual', sensitivityLevel: 'internal', status: 'active' });
      const intake = await da.submitManualIntake(w.ctx, { businessId: w.businessId, dataSourceId: source.id, submissionType, records: [{ recordType: 'inventory_movement', data }], sourceReference: 'integration://reference', submittedBy: w.ctx.userId });
      expect(intake.state).toBe('validated'); // the DAL carries referenceId as text and does not decide this; Business Operations does
      const prepared = await da.preparePublicationPackage(w.ctx, w.businessId, intake.collectionRunId, { targetBlock: 'BO-RUNTIME' });
      const published = await da.publishPackage(w.ctx, w.businessId, prepared.id);
      const handoff: DALToBOHandoff = {
        handoffId: unique('handoff'), sourceLayer: 'DAL', sourceBlock: 'DA-24', targetLayer: 'BO', targetBlock: 'BO-RUNTIME', correlationId: published.correlationId, lineage: [], status: 'ready', createdAt: new Date().toISOString(),
        payload: { contractVersion: '1.0.0', tenantId: w.tenantId, workspaceId: w.workspaceId, businessId: w.businessId, publicationPackageId: published.id, packageType: published.packageType, packageVersion: published.packageVersion, targetLayer: 'business_operations', targetBlock: published.targetBlock, status: 'published', publishedAt: published.publishedAt!.toISOString(), recordCount: published.recordCount, source: { sourceSystem: 'INFINICUS_DA', dataReference: published.dataReference as any }, schemaReferenceId: published.schemaReferenceId, quality: { qualityScore: published.qualityScore, reliabilityScore: published.reliabilityScore }, provenanceReferenceIds: published.provenanceReferenceIds as string[], consentReferenceIds: [], limitations: (published.limitations as unknown[]).map(String), warnings: [], idempotencyKey: `dal-to-bo:${published.id}:${published.packageVersion}` },
      };
      return { handoff, packageId: published.id };
    }
    const movement = (w: World, referenceId: unknown) => ({ sku: w.sku, warehouseCode: w.warehouseCode, movementType: 'receipt', quantity: 5, referenceType: 'manual', ...(referenceId === undefined ? {} : { referenceId }) });

    it.each(['operations', 'operations_prepared'] as const)('%s: a valid UUID (upper case) is applied once and stored lower-case; replaying the package is a no-op', async (submissionType) => {
      const w = await world();
      const { handoff } = await ingest(w, submissionType, movement(w, GOOD.toUpperCase()));
      const first = await bo.processHandoff(w.ctx, handoff);
      expect(first).toMatchObject({ idempotentReplay: false, commandCount: 1 });
      expect(await q(`SELECT reference_id::text AS reference_id FROM ${BO}.inventory_movements WHERE tenant_id=$1`, [w.tenantId])).toEqual([{ reference_id: GOOD }]);
      expect(await bo.processHandoff(w.ctx, handoff)).toMatchObject({ idempotentReplay: true, commandCount: 0 });
      expect((await state(w)).movements).toBe(1);
    });

    it.each(['operations', 'operations_prepared'] as const)('%s: a record without referenceId is applied as before', async (submissionType) => {
      const w = await world();
      const { handoff } = await ingest(w, submissionType, movement(w, undefined));
      expect(await bo.processHandoff(w.ctx, handoff)).toMatchObject({ commandCount: 1 });
      expect(await q(`SELECT reference_id FROM ${BO}.inventory_movements WHERE tenant_id=$1`, [w.tenantId])).toEqual([{ reference_id: null }]);
    });

    it.each(['operations', 'operations_prepared'] as const)('%s: a malformed referenceId rejects the whole handoff with a deterministic reason; nothing is written and the stored rejection does not repeat the value', async (submissionType) => {
      const w = await world();
      const bad = 'PO-2026-0042';
      const { handoff, packageId } = await ingest(w, submissionType, movement(w, bad));
      await expect(bo.processHandoff(w.ctx, handoff)).rejects.toThrow('Invalid inventory_movement record: referenceId_invalid');
      expect(await state(w)).toEqual({ movements: 0, balances: 0, events: expect.any(Number) });
      expect((await state(w)).balances).toBe(0);
      const delivery = await q(`SELECT delivery_status, failure_reason FROM data_acquisition.publication_deliveries WHERE publication_package_id=$1`, [packageId]);
      expect(delivery).toHaveLength(1);
      expect(delivery[0].failure_reason).toBe('OperationalMappingError: Invalid inventory_movement record: referenceId_invalid');
      expect(delivery[0].failure_reason).not.toContain(bad);
      expect(delivery[0].failure_reason).not.toMatch(/invalid input syntax|uuid:/i);
    });

    it('prepared and legacy differ only where the DAL itself differs: the prepared path trims surrounding whitespace, the legacy path hands the raw text to Business Operations, which refuses it', async () => {
      const w = await world();
      const padded = ` ${GOOD} `;
      const prepared = await ingest(w, 'operations_prepared', movement(w, padded));
      expect(await bo.processHandoff(w.ctx, prepared.handoff)).toMatchObject({ commandCount: 1 });
      expect(await q(`SELECT reference_id::text AS reference_id FROM ${BO}.inventory_movements WHERE tenant_id=$1`, [w.tenantId])).toEqual([{ reference_id: GOOD }]);
      const legacy = await ingest(w, 'operations', movement(w, padded));
      await expect(bo.processHandoff(w.ctx, legacy.handoff)).rejects.toThrow('Invalid inventory_movement record: referenceId_invalid');
      expect((await state(w)).movements).toBe(1);
    });
  });
});
