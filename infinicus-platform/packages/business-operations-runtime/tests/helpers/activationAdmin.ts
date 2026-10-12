import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

/**
 * Test fixture (migration 0196): the governed activation function re-checks, in the database, that the actor has an ACTIVE membership in the
 * tenant/workspace holding a role that grants `bo:admin`. A random user id is no longer an admin, so tests that enable execution seed a real one.
 * Written by the operator connection (the application role cannot, and must not be able to, grant itself the permission).
 */
export async function seedAdminUser(admin: Pool, tenantId: string, workspaceId: string, roleCode = 'admin'): Promise<string> {
  const userId = randomUUID();
  const c = await admin.connect();
  try {
    await c.query('BEGIN');
    await c.query(`INSERT INTO identity.users (id, email, status) VALUES ($1,$2,'active')`, [userId, `activation-admin-${userId}@fixture.example`]);
    const m = await c.query<{ id: string }>(
      `INSERT INTO tenancy.memberships (tenant_id, workspace_id, user_id, status, joined_at) VALUES ($1,$2,$3,'active', now()) RETURNING id`, [tenantId, workspaceId, userId]);
    await c.query(
      `INSERT INTO tenancy.membership_roles (membership_id, role_id) SELECT $1, id FROM tenancy.roles WHERE tenant_id IS NULL AND code = $2`, [m.rows[0].id, roleCode]);
    await c.query('COMMIT');
  } catch (error) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    c.release();
  }
  return userId;
}
