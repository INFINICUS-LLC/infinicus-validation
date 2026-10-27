/** AUTH-LOCKOUT-1.DB-02: live PostgreSQL proof for empty tenant context. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { closePool, createPool, getPool, withTransaction } from '../src/client.js';
import { AccessEventRepository } from '../src/repositories/auth/AccessEventRepository.js';

const run = !!process.env.DATABASE_URL && !!process.env.ADMIN_DATABASE_URL;
const tenantOne = randomUUID();
const tenantTwo = randomUUID();
const userId = randomUUID();
const since = new Date(Date.now() - 15 * 60_000);
const repo = new AccessEventRepository();
let admin: Pool;

const visible = () => withTransaction(async (client) => {
  const result = await client.query<{ tenant_id: string | null }>(
    "SELECT tenant_id FROM audit.access_events WHERE user_id = $1 AND metadata->>'reason' = 'bad_password' ORDER BY tenant_id NULLS FIRST", [userId],
  );
  return result.rows.map((row) => row.tenant_id);
});

describe.runIf(run)('AUTH-LOCKOUT-1.DB-02 access-event RLS', () => {
  beforeAll(async () => {
    createPool({ connectionString: process.env.DATABASE_URL!, poolMin: 0, poolMax: 4 });
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL! });
    await admin.query(`INSERT INTO tenancy.tenants (id,name,slug,status) VALUES
      ($1,'DB-02 synthetic one',$3,'active'),($2,'DB-02 synthetic two',$4,'active')`,
    [tenantOne, tenantTwo, `db02-${tenantOne}`, `db02-${tenantTwo}`]);
    await admin.query(`INSERT INTO identity.users (id,email,status)
      VALUES ($1,$2,'active')`, [userId, `db02-${userId}@example.invalid`]);
    await admin.query(`INSERT INTO audit.access_events (tenant_id,user_id,event_type,metadata)
      VALUES (NULL,$1,'failed_auth','{"reason":"bad_password"}'),
             ($2,$1,'failed_auth','{"reason":"bad_password"}'),
             ($3,$1,'failed_auth','{"reason":"bad_password"}')`, [userId, tenantOne, tenantTwo]);
  });
  afterAll(async () => { await admin?.end(); await closePool(); });

  it('preserves tenantless visibility on a fresh connection and the lockout count', async () => {
    expect(await visible()).toEqual([null]);
    expect(await repo.countRecentFailedPasswordAttempts(userId, since)).toBe(1);
  });

  it('treats an explicit empty setting as absent, never as foreign-tenant authority', async () => {
    const rows = await withTransaction(async (client) => {
      await client.query("SELECT set_config('app.tenant_id', '', true)");
      const result = await client.query<{ tenant_id: string | null }>(
        "SELECT tenant_id FROM audit.access_events WHERE user_id = $1 AND metadata->>'reason' = 'bad_password'", [userId]);
      return result.rows.map((row) => row.tenant_id);
    });
    expect(rows).toEqual([null]);
  });

  it('keeps valid tenant contexts isolated, including negative cross-tenant reads and writes', async () => {
    for (const [own, foreign] of [[tenantOne, tenantTwo], [tenantTwo, tenantOne]]) {
      await withTransaction(async (client) => {
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [own]);
        const result = await client.query<{ tenant_id: string | null }>(
          "SELECT tenant_id FROM audit.access_events WHERE user_id = $1 AND metadata->>'reason' = 'bad_password' ORDER BY tenant_id NULLS FIRST", [userId]);
        expect(result.rows.map((row) => row.tenant_id)).toEqual([null, own]);
        expect(result.rows.some((row) => row.tenant_id === foreign)).toBe(false);
      });
      await expect(withTransaction(async (client) => {
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [own]);
        await client.query(`INSERT INTO audit.access_events (tenant_id,user_id,event_type)
          VALUES ($1,$2,'failed_auth')`, [foreign, userId]);
      })).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('preserves tenantless and correctly scoped audit writes without broadening empty-context writes', async () => {
    const tenantless = await repo.record(null, userId, 'failed_auth', null, null, { reason: 'probe' });
    const scoped = await repo.record(tenantOne, userId, 'failed_auth', null, null, { reason: 'probe' });
    expect(tenantless.tenantId).toBeNull();
    expect(scoped.tenantId).toBe(tenantOne);
    await expect(withTransaction(async (client) => {
      await client.query("SELECT set_config('app.tenant_id', '', true)");
      await client.query(`INSERT INTO audit.access_events (tenant_id,user_id,event_type)
        VALUES ($1,$2,'login')`, [tenantOne, userId]);
    })).rejects.toMatchObject({ code: '42501' });
  });

  it('handles transaction-local reset and repeated repository reads on one reused connection', async () => {
    await closePool();
    createPool({ connectionString: process.env.DATABASE_URL!, poolMin: 0, poolMax: 1 });
    await withTransaction(async (client) => {
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantOne]);
    });
    expect(await visible()).toEqual([null]);
    expect(await repo.countRecentFailedPasswordAttempts(userId, since)).toBe(1);
    expect(await repo.countRecentFailedPasswordAttempts(userId, since)).toBe(1);
    await closePool();
    createPool({ connectionString: process.env.DATABASE_URL!, poolMin: 0, poolMax: 4 });
  });

  it('handles concurrent lockout reads on both fresh and reset pooled connections', async () => {
    const counts = await Promise.all(Array.from({ length: 12 }, () => repo.countRecentFailedPasswordAttempts(userId, since)));
    expect(counts).toEqual(Array(12).fill(1));
    const clients = await Promise.all(Array.from({ length: 4 }, () => getPool().connect()));
    try {
      await Promise.all(clients.map(async (client) => {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantOne]);
        await client.query('COMMIT');
      }));
    } finally {
      clients.forEach((client) => client.release());
    }
    expect(getPool().totalCount).toBe(4);
    const afterReset = await Promise.all(Array.from({ length: 12 }, () => repo.countRecentFailedPasswordAttempts(userId, since)));
    expect(afterReset).toEqual(Array(12).fill(1));
  });
});
