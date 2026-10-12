import type { Pool } from 'pg';

/**
 * Test fixture (migration 0196): changes a balance's reorder values the way ANOTHER, already-committed actor would have, to set up "the balance
 * changed after authorization" scenarios. The governed write path (apply_inventory_reorder_policy) is the only runtime writer, and it is exactly
 * what these tests exercise, so the fixture bypasses the guard trigger the only way a superuser operator connection can: session_replication_role.
 * Never used by product code and never available to the application role.
 */
export async function fixtureSetReorder(admin: Pool, balanceId: string, setClause: string, args: unknown[] = []): Promise<void> {
  const c = await admin.connect();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL session_replication_role = 'replica'");
    await c.query(`UPDATE business_operations.inventory_balances SET ${setClause} WHERE id = $1`, [balanceId, ...args]);
    await c.query('COMMIT');
  } catch (error) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    c.release();
  }
}
