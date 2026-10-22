/**
 * V-07 / SOT-09 (reconciliation item P1-F): Data Acquisition OWNS data_acquisition.publication_deliveries. This suite pins the delivery state machine that
 * now lives in the DAL-owned PublicationDeliveryRepository, which Business Operations calls to acknowledge or reject a handoff instead of writing the table.
 * Requires DATABASE_URL (app role, RLS enforced) and ADMIN_DATABASE_URL (fixtures).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { PublicationDeliveryRepository } from '../src/repositories/da/PublicationDeliveryRepository.js';
import { withTenantTransaction } from '../src/client.js';
import { setupIntegration, endIntegration, ctx1, ctx2, T1, WS1 } from './helpers/integration.js';

const RUN = !!process.env.DATABASE_URL;
const BO = 'business_operations';
const BI = 'business_intelligence';

describe.runIf(RUN)('PublicationDeliveryRepository: Data Acquisition owns its delivery state (V-07)', () => {
  const repo = new PublicationDeliveryRepository();
  let admin: Pool;
  const packageIds: string[] = [];

  async function newPackage(): Promise<string> {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO data_acquisition.publication_packages
         (id, tenant_id, workspace_id, package_type, target_layer, target_block, status, published_at)
       VALUES ($1,$2,$3,'operations_data',$4,'BO-1','published', now())`,
      [id, T1, WS1, BO]
    );
    packageIds.push(id);
    return id;
  }
  const rows = async (pkg: string) => (await admin.query(
    `SELECT destination_reference, delivery_status, attempt_count, failure_reason, delivered_at, last_attempt_at
     FROM data_acquisition.publication_deliveries WHERE publication_package_id = $1 ORDER BY created_at`, [pkg])).rows;
  const begin = (pkg: string, layer = BO) => withTenantTransaction(ctx1, (c) => repo.beginLayerAttemptOn(c, pkg, layer));
  const begin2 = (pkg: string, layer = BO) => withTenantTransaction(ctx2, (c) => repo.beginLayerAttemptOn(c, pkg, layer));
  const deliver = (id: string) => withTenantTransaction(ctx1, (c) => repo.markLayerDeliveredOn(c, id));

  beforeAll(async () => {
    await setupIntegration();
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });
  });
  afterAll(async () => {
    if (packageIds.length > 0) {
      await admin.query('DELETE FROM data_acquisition.publication_deliveries WHERE publication_package_id = ANY($1)', [packageIds]);
      await admin.query('DELETE FROM data_acquisition.publication_packages WHERE id = ANY($1)', [packageIds]);
    }
    await admin.end();
    await endIntegration();
  });

  it('the first attempt creates an in_progress delivery with attempt 1; a restart increments the attempt and clears the previous failure', async () => {
    const pkg = await newPackage();
    const a = await begin(pkg);
    expect(a.alreadyDelivered).toBe(false);
    expect((await rows(pkg))).toMatchObject([{ destination_reference: BO, delivery_status: 'in_progress', attempt_count: 1, failure_reason: null }]);
    await repo.recordLayerFailure(ctx1, pkg, BO, 'BusinessIntakeRejectedError: nope');
    expect((await rows(pkg))[0]).toMatchObject({ delivery_status: 'failed', attempt_count: 2, failure_reason: 'BusinessIntakeRejectedError: nope' });
    const b = await begin(pkg);
    expect(b.deliveryId).toBe(a.deliveryId);                                   // the same record, never a second row
    expect(await rows(pkg)).toHaveLength(1);
    expect((await rows(pkg))[0]).toMatchObject({ delivery_status: 'in_progress', attempt_count: 3, failure_reason: null });
  });

  it('delivered is TERMINAL: a later attempt is reported as already delivered and writes nothing; a later failure never turns it into a failure', async () => {
    const pkg = await newPackage();
    const { deliveryId } = await begin(pkg);
    await deliver(deliveryId);
    const done = (await rows(pkg))[0];
    expect(done).toMatchObject({ delivery_status: 'delivered', attempt_count: 1, failure_reason: null });
    expect(done.delivered_at).not.toBeNull();

    const replay = await begin(pkg);
    expect(replay).toEqual({ deliveryId, alreadyDelivered: true });
    await repo.recordLayerFailure(ctx1, pkg, BO, 'late failure');
    const after = await rows(pkg);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ delivery_status: 'delivered', attempt_count: 1, failure_reason: null });
  });

  it('a failure for a package with no delivery yet creates a failed delivery (attempt 1); the reason is bounded to 500 characters', async () => {
    const pkg = await newPackage();
    await repo.recordLayerFailure(ctx1, pkg, BO, 'x'.repeat(900));
    const r = await rows(pkg);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ delivery_status: 'failed', attempt_count: 1 });
    expect((r[0].failure_reason as string).length).toBe(500);
  });

  it('a failure for an unknown package is ignored (nothing to attach it to)', async () => {
    await expect(repo.recordLayerFailure(ctx1, randomUUID(), BO, 'orphan')).resolves.toBeUndefined();
  });

  it('deliveries toward different layers are independent records', async () => {
    const pkg = await newPackage();
    const bo = await begin(pkg, BO);
    await deliver(bo.deliveryId);
    const bi = await begin(pkg, BI);                                            // not "already delivered": a different destination
    expect(bi.alreadyDelivered).toBe(false);
    expect(bi.deliveryId).not.toBe(bo.deliveryId);
    const r = await rows(pkg);
    expect(r.map((x) => [x.destination_reference, x.delivery_status])).toEqual([[BO, 'delivered'], [BI, 'in_progress']]);
  });

  it('findLayerDeliveryOn reports the record, and null when none exists', async () => {
    const pkg = await newPackage();
    expect(await withTenantTransaction(ctx1, (c) => repo.findLayerDeliveryOn(c, pkg, BO))).toBeNull();
    const { deliveryId } = await begin(pkg);
    const found = await withTenantTransaction(ctx1, (c) => repo.findLayerDeliveryOn(c, pkg, BO));
    expect(found).toMatchObject({ id: deliveryId, publicationPackageId: pkg, destinationReference: BO, status: 'in_progress', attemptCount: 1 });
  });

  it('tenant isolation: another tenant can neither see nor change a delivery (RLS), and its failure report is a no-op', async () => {
    const pkg = await newPackage();
    const { deliveryId } = await begin(pkg);
    expect(await withTenantTransaction(ctx2, (c) => repo.findLayerDeliveryOn(c, pkg, BO))).toBeNull();
    await repo.recordLayerFailure(ctx2, pkg, BO, 'cross-tenant');
    await withTenantTransaction(ctx2, (c) => repo.markLayerDeliveredOn(c, deliveryId));
    await expect(begin2(pkg)).rejects.toMatchObject({ name: 'NotFoundError' });          // cannot restart it ...
    const other = await newPackage();
    await expect(begin2(other)).rejects.toMatchObject({ name: 'NotFoundError' });        // ... nor create one for a package it cannot see
    const r = await rows(pkg);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ delivery_status: 'in_progress', attempt_count: 1, failure_reason: null });
    expect(await rows(other)).toHaveLength(0);
  });
});
