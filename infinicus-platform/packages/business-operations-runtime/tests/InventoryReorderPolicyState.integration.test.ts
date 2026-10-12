/**
 * Data-capture Block E - reorder_policy_state against live PostgreSQL (migration 0189).
 * Requires DATABASE_URL (app role, RLS) and ADMIN_DATABASE_URL (superuser).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { closePool, createPool } from '@infinicus/database';
import { InventoryReorderPolicyService } from '../src/inventory/InventoryReorderPolicyService.js';
import type { ConfigureInventoryReorderPolicyCommand } from '../src/types.js';
import { deleteMovementsForTenants } from './helpers/movementCleanup.js';
import { makePolicyWorld, type W } from './helpers/policyWorld.js';

const RUN = !!process.env.DATABASE_URL && !!process.env.ADMIN_DATABASE_URL;

describe.runIf(RUN)('reorder policy state - live PostgreSQL', () => {
  let admin: Pool;
  const tenantIds: string[] = [];
  const service = new InventoryReorderPolicyService();
  const world = () => makePolicyWorld(admin, tenantIds, { baseline: [100, 200], issues: 0, receipt: null, declared: null });
  const cmd = (w: W, payload: Partial<ConfigureInventoryReorderPolicyCommand['payload']> = {}): ConfigureInventoryReorderPolicyCommand => ({
    type: 'configure_inventory_reorder_policy',
    context: { tenantId: w.ctx.tenantId, workspaceId: w.ctx.workspaceId, businessId: w.businessId, correlationId: randomUUID(), sourceReference: 'test', idempotencyKey: randomUUID(), actorId: w.ctx.userId, occurredAt: new Date().toISOString() },
    payload: { inventoryItemId: w.itemId, warehouseId: w.warehouseId, reorderPoint: 150, reorderQuantity: 250, ...payload },
  });
  const row = async (w: W) => (await admin.query('SELECT * FROM business_operations.inventory_balances WHERE tenant_id=$1', [w.ctx.tenantId])).rows[0];

  beforeAll(async () => {
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
    createPool({ connectionString: process.env.DATABASE_URL! });
  });
  afterAll(async () => {
    if (tenantIds.length > 0) {
      const c = await admin.connect();
      try {
        await c.query('BEGIN'); await c.query("SET LOCAL session_replication_role = 'replica'");
        for (const t of ['business_operations.inventory_balances', 'platform.inventory_items', 'platform.warehouses', 'platform.businesses', 'tenancy.workspaces', 'tenancy.tenants']) {
          await c.query(`DELETE FROM ${t} WHERE ${t === 'tenancy.tenants' ? 'id' : 'tenant_id'} = ANY($1)`, [tenantIds]);
        }
        await c.query('DELETE FROM audit.audit_events WHERE tenant_id = ANY($1)', [tenantIds]);
        await c.query('COMMIT');
      } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
      await deleteMovementsForTenants(admin, tenantIds);
    }
    await closePool(); await admin.end();
  });

  it('existing and newly created balances are UNSET with no configuration facts (no backfill, non-zero values stay UNSET)', async () => {
    const w = await world();
    const r = await row(w);
    expect(r.reorder_policy_state).toBe('UNSET');
    expect(r.reorder_policy_configured_at).toBeNull();
    expect(r.reorder_policy_configured_source).toBeNull();
    expect(Number(r.reorder_point)).toBe(100);
  });

  it('the BO command configures: values, CONFIGURED, database-clock time, source and a version bump', async () => {
    const w = await world();
    const before = await row(w);
    const result = await service.configure(w.ctx, cmd(w));
    expect(result.recordId).toBe(before.id);
    const after = await row(w);
    expect([Number(after.reorder_point), Number(after.reorder_quantity)]).toEqual([150, 250]);
    expect(after.reorder_policy_state).toBe('CONFIGURED');
    expect(after.reorder_policy_configured_source).toBe('BO_COMMAND');
    expect(after.reorder_policy_configured_at).toBeInstanceOf(Date);
    expect(Number(after.version)).toBe(Number(before.version) + 1);
  });

  it('a deliberate zero is CONFIGURED and distinguishable from the UNSET default', async () => {
    const w = await world();
    await service.configure(w.ctx, cmd(w, { reorderPoint: 0, reorderQuantity: 0 }));
    const r = await row(w);
    expect([Number(r.reorder_point), r.reorder_policy_state]).toEqual([0, 'CONFIGURED']);
  });

  it('records the authorized-package source when the caller states it', async () => {
    const w = await world();
    await service.configure(w.ctx, cmd(w, { configurationSource: 'AUTHORIZED_ACTION_PACKAGE' }));
    expect((await row(w)).reorder_policy_configured_source).toBe('AUTHORIZED_ACTION_PACKAGE');
  });

  it('re-sending the configured values is a no-op: no UPDATE, no version bump, same configured time', async () => {
    const w = await world();
    await service.configure(w.ctx, cmd(w));
    const first = await row(w);
    await service.configure(w.ctx, cmd(w));
    const second = await row(w);
    expect(Number(second.version)).toBe(Number(first.version));
    expect(second.reorder_policy_configured_at).toEqual(first.reorder_policy_configured_at);
  });

  it('reconfiguring with different values updates them and bumps the version', async () => {
    const w = await world();
    await service.configure(w.ctx, cmd(w));
    const first = await row(w);
    await service.configure(w.ctx, cmd(w, { reorderPoint: 160 }));
    const second = await row(w);
    expect(Number(second.reorder_point)).toBe(160);
    expect(Number(second.version)).toBe(Number(first.version) + 1);
  });

  it('changing only the reorder quantity is a real change (not mistaken for a no-op)', async () => {
    const w = await world();
    await service.configure(w.ctx, cmd(w));
    const first = await row(w);
    await service.configure(w.ctx, cmd(w, { reorderQuantity: 260 }));
    const second = await row(w);
    expect([Number(second.reorder_point), Number(second.reorder_quantity)]).toEqual([150, 260]);
    expect(Number(second.version)).toBe(Number(first.version) + 1);
  });

  it('refuses invalid values explicitly (negative, NaN, Infinity, over 4 decimals, out of range) and changes nothing', async () => {
    const w = await world();
    const before = await row(w);
    const cases: [number, RegExp][] = [[-1, /must not be negative/], [Number.NaN, /finite/], [Number.POSITIVE_INFINITY, /finite/], [1.00001, /at most 4 decimal/], [1e14, /storable range/]];
    for (const [bad, message] of cases) {
      await expect(service.configure(w.ctx, cmd(w, { reorderPoint: bad }))).rejects.toThrow(message);
      await expect(service.configure(w.ctx, cmd(w, { reorderQuantity: bad }))).rejects.toThrow(message);
    }
    await expect(service.configure(w.ctx, cmd(w, { configurationSource: 'ABA' as never }))).rejects.toThrow(/configurationSource/);
    expect(await row(w)).toEqual(before);
  });

  it('refuses when no balance exists and when the item or warehouse is outside the business', async () => {
    const w = await world();
    await expect(service.configure(w.ctx, cmd(w, { inventoryItemId: randomUUID() }))).rejects.toThrow(/not found in business scope/);
    await expect(service.configure(w.ctx, cmd(w, { warehouseId: randomUUID() }))).rejects.toThrow(/not found in business scope/);
    const none = await makePolicyWorld(admin, tenantIds, { baseline: null, issues: 0, receipt: null, declared: null });
    await expect(service.configure(none.ctx, cmd(none))).rejects.toThrow(/No inventory balance exists/);
  });

  it('rejects a command whose scope does not match the active context', async () => {
    const w = await world();
    const other = await world();
    await expect(service.configure(w.ctx, cmd(other))).rejects.toThrow();
    expect((await row(w)).reorder_policy_state).toBe('UNSET');
  });

  describe('database guard (every role, including superuser)', () => {
    it('refuses CONFIGURED, configured_* and configured-value changes made outside the BO command', async () => {
      const w = await world();
      const id = (await row(w)).id;
      await expect(admin.query(`UPDATE business_operations.inventory_balances SET reorder_policy_state='CONFIGURED', reorder_policy_configured_at=now(), reorder_policy_configured_source='BO_COMMAND' WHERE id=$1`, [id])).rejects.toThrow(/configure_inventory_reorder_policy/);
      await expect(admin.query(`UPDATE business_operations.inventory_balances SET reorder_policy_configured_source='BO_COMMAND' WHERE id=$1`, [id])).rejects.toThrow();
      await service.configure(w.ctx, cmd(w));
      await expect(admin.query(`UPDATE business_operations.inventory_balances SET reorder_point=1 WHERE id=$1`, [id])).rejects.toThrow(/configure_inventory_reorder_policy/);
      await expect(admin.query(`UPDATE business_operations.inventory_balances SET reorder_quantity=1 WHERE id=$1`, [id])).rejects.toThrow(/configure_inventory_reorder_policy/);
    });

    it('refuses a direct INSERT as CONFIGURED', async () => {
      const w = await world();
      const item = randomUUID();
      await admin.query(`INSERT INTO platform.inventory_items (id, tenant_id, workspace_id, business_id, sku, name, status) VALUES ($1,$2,$3,$4,$5,'I2','active')`, [item, w.ctx.tenantId, w.ctx.workspaceId, w.businessId, `sku-${item}`]);
      await expect(admin.query(
        `INSERT INTO business_operations.inventory_balances (tenant_id, workspace_id, business_id, inventory_item_id, warehouse_id, reorder_policy_state, reorder_policy_configured_at, reorder_policy_configured_source)
         VALUES ($1,$2,$3,$4,$5,'CONFIGURED',now(),'BO_COMMAND')`, [w.ctx.tenantId, w.ctx.workspaceId, w.businessId, item, w.warehouseId])).rejects.toThrow(/configure_inventory_reorder_policy/);
    });

    it('never returns CONFIGURED to UNSET, even inside the writer context', async () => {
      const w = await world();
      await service.configure(w.ctx, cmd(w));
      const id = (await row(w)).id;
      const c = await admin.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.bo_reorder_policy_writer','configure_inventory_reorder_policy', true)`);
        await expect(c.query(`UPDATE business_operations.inventory_balances SET reorder_policy_state='UNSET', reorder_policy_configured_at=NULL, reorder_policy_configured_source=NULL WHERE id=$1`, [id])).rejects.toThrow(/cannot return to UNSET/);
      } finally { await c.query('ROLLBACK'); c.release(); }
    });

    it('the CHECK constraints refuse inconsistent or unknown states', async () => {
      const w = await world();
      const id = (await row(w)).id;
      const c = await admin.connect();
      try {
        for (const set of [
          `reorder_policy_state='BOGUS'`,
          `reorder_policy_configured_at=now()`,
          `reorder_policy_configured_source='NOPE'`,
        ]) {
          await c.query('BEGIN');
          await c.query(`SELECT set_config('app.bo_reorder_policy_writer','configure_inventory_reorder_policy', true)`);
          await expect(c.query(`UPDATE business_operations.inventory_balances SET ${set} WHERE id=$1`, [id])).rejects.toThrow();
          await c.query('ROLLBACK');
        }
      } finally { c.release(); }
    });

    it('the source CHECK refuses an unknown source on a CONFIGURED row', async () => {
      const w = await world();
      const id = (await row(w)).id;
      const c = await admin.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.bo_reorder_policy_writer','configure_inventory_reorder_policy', true)`);
        await expect(c.query(`UPDATE business_operations.inventory_balances SET reorder_policy_state='CONFIGURED', reorder_policy_configured_at=now(), reorder_policy_configured_source='NOPE' WHERE id=$1`, [id])).rejects.toThrow(/reorder_policy_source_check/);
      } finally { await c.query('ROLLBACK'); c.release(); }
    });

    it('quantity movements on a configured balance are unaffected (guard only covers policy fields)', async () => {
      const w = await world();
      await service.configure(w.ctx, cmd(w));
      const id = (await row(w)).id;
      await admin.query(`UPDATE business_operations.inventory_balances SET quantity_on_hand = 5, last_movement_at = now() WHERE id=$1`, [id]);
      expect(Number((await row(w)).quantity_on_hand)).toBe(5);
    });
  });
});
