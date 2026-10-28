/**
 * AUDIT-LP-1 (live PostgreSQL): the application role can still INSERT into and SELECT from audit.access_events (login audit, permission denials and the
 * failed-login count that drives the lockout), but cannot UPDATE, DELETE or TRUNCATE it. The privileges come from grant-app-role.sh, which the CI job
 * runs before the tests; a database provisioned with an older copy of the script fails here by design.
 * Requires DATABASE_URL (the application role) and ADMIN_DATABASE_URL (cleanup of the marker rows).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { closePool, createPool, withTransaction } from '../src/client.js';
import { AccessEventRepository } from '../src/repositories/auth/AccessEventRepository.js';

const run = !!process.env.DATABASE_URL && !!process.env.ADMIN_DATABASE_URL;
const marker = `audit-lp-1-${randomUUID()}`;
let admin: Pool;

describe.runIf(run)('AUDIT-LP-1 audit.access_events application-role privileges', () => {
  beforeAll(() => {
    createPool({ connectionString: process.env.DATABASE_URL!, poolMin: 0, poolMax: 2 });
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL! });
  });
  afterAll(async () => {
    await admin?.query(`DELETE FROM audit.access_events WHERE metadata->>'marker' = $1`, [marker]);
    await admin?.end();
    await closePool();
  });

  it('reports INSERT and SELECT granted, UPDATE, DELETE and TRUNCATE not granted', async () => {
    const rows = await withTransaction(async (client) => (await client.query<{ priv: string; granted: boolean }>(
      `SELECT priv, has_table_privilege(current_user, 'audit.access_events', priv) AS granted
         FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) AS priv`)).rows);
    expect(Object.fromEntries(rows.map((r) => [r.priv, r.granted]))).toEqual({ SELECT: true, INSERT: true, UPDATE: false, DELETE: false, TRUNCATE: false });
  });

  it('the repository still records and reads access events (login audit and the lockout count)', async () => {
    const repo = new AccessEventRepository();
    const saved = await repo.record(null, null, 'failed_auth', null, null, { reason: 'probe', marker });
    expect(saved.tenantId).toBeNull();
    const seen = await withTransaction(async (client) => (await client.query(`SELECT count(*)::int AS n FROM audit.access_events WHERE metadata->>'marker' = $1`, [marker])).rows[0].n);
    expect(seen).toBe(1);
    expect(await repo.countRecentFailedPasswordAttempts(randomUUID(), new Date(Date.now() - 60_000))).toBe(0);
  });

  it.each([
    ['UPDATE', `UPDATE audit.access_events SET event_type = 'login' WHERE metadata->>'marker' = $1`, true],
    ['DELETE', `DELETE FROM audit.access_events WHERE metadata->>'marker' = $1`, true],
    ['TRUNCATE', `TRUNCATE audit.access_events`, false],
  ])('%s is refused with SQLSTATE 42501 and changes nothing', async (_name, sql, takesMarker) => {
    await expect(withTransaction(async (client) => { await client.query(sql, takesMarker ? [marker] : []); })).rejects.toMatchObject({ code: '42501' });
    const still = (await admin.query(`SELECT count(*)::int AS n FROM audit.access_events WHERE metadata->>'marker' = $1`, [marker])).rows[0].n;
    expect(still).toBe(1);
  });
});
