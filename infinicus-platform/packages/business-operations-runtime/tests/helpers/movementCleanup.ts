import type { Pool } from 'pg';

/**
 * TEST-ONLY cleanup of append-only inventory movements (migration 0184).
 *
 * The production guard rejects UPDATE/DELETE/TRUNCATE for every role. Test teardown needs to remove the rows it created, so it
 * follows the repository's accepted pattern for privileged fixtures (see aapFixtures / intakeFixture): a superuser connection
 * sets session_replication_role = 'replica' for ONE transaction, which suspends user triggers. The setting is superuser-only, so
 * the application role cannot use it, and this helper lives under tests/ and is never imported by production code
 * (guarded by inventoryMovementAppendOnly.architecture.test.ts).
 */
export async function deleteMovementsForTenants(admin: Pool, tenantIds: string[]): Promise<void> {
  const c = await admin.connect();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL session_replication_role = 'replica'");
    // Data-capture Block A (0197): purchase receipts and their lines are append-only too and reference the movements, so they go first.
    await c.query('DELETE FROM business_operations.purchase_receipt_lines WHERE tenant_id = ANY($1)', [tenantIds]);
    await c.query('DELETE FROM business_operations.purchase_receipts WHERE tenant_id = ANY($1)', [tenantIds]);
    await c.query('DELETE FROM business_operations.inventory_movements WHERE tenant_id = ANY($1)', [tenantIds]);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
