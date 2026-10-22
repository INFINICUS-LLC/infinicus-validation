/**
 * Block A - live PostgreSQL proof that migration 0181 makes audit.audit_events append-only, for the least-privilege
 * application role AND the admin role, without changing INSERT, RLS or the existing governance audit writer.
 *
 * Requires DATABASE_URL (app_test_user, RLS enforced) and ADMIN_DATABASE_URL (BYPASSRLS), migrated through 0181.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { truncateRefusal } from './helpers/truncateRefusal.js';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { createPool, closePool } from '../src/client.js';
import { GovernanceAuditRepository } from '../src/index.js';

const run = !!process.env.DATABASE_URL;
const MIGRATION = readFileSync(resolve(__dirname, '../../../infrastructure/database/migrations/0181_audit_events_append_only.sql'), 'utf8');
const APPEND_ONLY = /audit\.audit_events: append-only table - (UPDATE|DELETE|TRUNCATE) is not permitted/;

/**
 * The triggers this migration installs: those bound to audit.forbid_mutation. They are counted by function, not by table, because every package's tests share
 * one database and apps/api/tests/abaAuthoring.integration.test.ts temporarily installs its own failing trigger on audit.audit_events to inject an audit failure;
 * counting every trigger on the table failed whenever the two ran at the same time (a third `abau_fail_*` trigger). A second forbid_mutation trigger, or a
 * missing one, still fails these assertions.
 */
const GUARD_TRIGGERS = `WITH guard AS (
  SELECT t.oid FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE t.tgrelid = 'audit.audit_events'::regclass AND NOT t.tgisinternal AND n.nspname = 'audit' AND p.proname = 'forbid_mutation')`;

describe.runIf(run)('audit.audit_events append-only (0181) - live PostgreSQL', () => {
  let admin: Pool; let app: Pool;
  let tenantId = ''; let workspaceId = ''; let otherTenantId = ''; let rowId = '';

  /** Runs `fn` inside a transaction for the least-privilege role with the tenant context set (as withTenantTransaction does). */
  async function asTenant<T>(tenant: string, fn: (q: (sql: string, p?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>) => Promise<T>): Promise<T> {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.workspace_id', $2, true)`, [tenant, workspaceId]);
      const out = await fn((s, p) => client.query(s, p));
      await client.query('COMMIT');
      return out;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL! });
    app = new Pool({ connectionString: process.env.DATABASE_URL! });
    createPool({ connectionString: process.env.DATABASE_URL! });
    tenantId = randomUUID(); workspaceId = randomUUID(); otherTenantId = randomUUID();
    for (const [t, w] of [[tenantId, workspaceId], [otherTenantId, randomUUID()]]) {
      await admin.query(`INSERT INTO tenancy.tenants (id, name, slug, status, plan_code) VALUES ($1,'Audit Immutability',$2,'active','test')`, [t, `audit-imm-${t}`]);
      await admin.query(`INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,'WS',$3,'active')`, [w, t, `ws-${w}`]);
    }
    rowId = await asTenant(tenantId, async (q) => (await q(
      `INSERT INTO audit.audit_events (tenant_id, workspace_id, actor_type, action, entity_type, correlation_id, metadata)
       VALUES ($1,$2,'system','test.audit.written','test_entity',gen_random_uuid(),'{"k":"v"}') RETURNING id`, [tenantId, workspaceId])).rows[0].id);
  });
  afterAll(async () => { await closePool(); await admin.end(); await app.end(); });

  const unchanged = async () => {
    const r = await admin.query(`SELECT action, metadata FROM audit.audit_events WHERE id = $1`, [rowId]);
    expect(r.rows).toEqual([{ action: 'test.audit.written', metadata: { k: 'v' } }]);
  };

  it('INSERT still works for the application role, and RLS still confines reads to the tenant', async () => {
    expect(rowId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await asTenant(tenantId, (q) => q(`SELECT id FROM audit.audit_events WHERE id = $1`, [rowId]))).rows).toHaveLength(1);
    expect((await asTenant(otherTenantId, (q) => q(`SELECT id FROM audit.audit_events WHERE id = $1`, [rowId]))).rows).toHaveLength(0);
    const flags = (await admin.query(`SELECT relrowsecurity FROM pg_class WHERE oid = 'audit.audit_events'::regclass`)).rows[0];
    expect(flags.relrowsecurity).toBe(true);
    expect((await admin.query(`SELECT 1 FROM pg_policies WHERE schemaname='audit' AND tablename='audit_events' AND policyname='audit_events_isolation'`)).rowCount).toBe(1);
  });

  it('UPDATE is rejected for the application role and for the admin role; the row is unchanged', async () => {
    await expect(asTenant(tenantId, (q) => q(`UPDATE audit.audit_events SET action = 'tampered' WHERE id = $1`, [rowId]))).rejects.toThrow(APPEND_ONLY);
    await expect(admin.query(`UPDATE audit.audit_events SET metadata = '{}' WHERE id = $1`, [rowId])).rejects.toThrow(APPEND_ONLY);
    await expect(admin.query(`UPDATE audit.audit_events SET action = 'tampered'`)).rejects.toThrow(APPEND_ONLY);
    await unchanged();
  });

  it('DELETE is rejected for the application role and for the admin role; the row survives', async () => {
    await expect(asTenant(tenantId, (q) => q(`DELETE FROM audit.audit_events WHERE id = $1`, [rowId]))).rejects.toThrow(APPEND_ONLY);
    await expect(admin.query(`DELETE FROM audit.audit_events WHERE id = $1`, [rowId])).rejects.toThrow(APPEND_ONLY);
    await expect(admin.query(`DELETE FROM audit.audit_events`)).rejects.toThrow(APPEND_ONLY);
    await unchanged();
  });

  it('TRUNCATE (plain and CASCADE) is rejected for the admin and application roles; the row survives', async () => {
    await expect(truncateRefusal(admin, `TRUNCATE audit.audit_events`)).rejects.toThrow(APPEND_ONLY);
    await expect(truncateRefusal(admin, `TRUNCATE audit.audit_events CASCADE`)).rejects.toThrow(APPEND_ONLY);
    await expect(truncateRefusal(app, `TRUNCATE audit.audit_events`)).rejects.toThrow();
    await unchanged();
  });

  it('exactly two triggers guard the table, bound to audit.forbid_mutation (row UPDATE|DELETE, statement TRUNCATE)', async () => {
    const t = (await admin.query(
      `SELECT t.tgname, p.proname, n.nspname AS fn_schema, (t.tgtype & 1) = 1 AS per_row, (t.tgtype & 8) = 8 AS on_delete,
              (t.tgtype & 16) = 16 AS on_update, (t.tgtype & 32) = 32 AS on_truncate, (t.tgtype & 2) = 2 AS before, t.tgenabled
         FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE t.tgrelid = 'audit.audit_events'::regclass AND NOT t.tgisinternal
          AND n.nspname = 'audit' AND p.proname = 'forbid_mutation'   -- the guard under test; see GUARD_TRIGGERS
        ORDER BY t.tgname`)).rows;
    expect(t).toEqual([
      { tgname: 'forbid_mutation_audit_events', proname: 'forbid_mutation', fn_schema: 'audit', per_row: true, on_delete: true, on_update: true, on_truncate: false, before: true, tgenabled: 'O' },
      { tgname: 'forbid_truncate_audit_events', proname: 'forbid_mutation', fn_schema: 'audit', per_row: false, on_delete: false, on_update: false, on_truncate: true, before: true, tgenabled: 'O' },
    ]);
  });

  it('re-running the migration is safe: it succeeds, leaves the same two triggers, and registers once', async () => {
    await admin.query(MIGRATION);
    await admin.query(MIGRATION);
    expect((await admin.query(`${GUARD_TRIGGERS} SELECT count(*)::int n FROM guard`)).rows[0].n).toBe(2);
    expect((await admin.query(`SELECT count(*)::int n FROM _migrations WHERE filename = '0181_audit_events_append_only.sql'`)).rows[0].n).toBe(1);
    await expect(admin.query(`DELETE FROM audit.audit_events WHERE id = $1`, [rowId])).rejects.toThrow(APPEND_ONLY);
  });

  it('the existing governance audit writer is unchanged and still appends (regression)', async () => {
    const repo = new GovernanceAuditRepository();
    const ctx = { tenantId, workspaceId, userId: randomUUID() };
    const id = await repo.record(ctx, {
      action: 'aba.test.recorded', entityType: 'test_entity', entityId: randomUUID(), businessId: null, correlationId: randomUUID(),
      metadata: { permissionUsed: 'aba:admin', reason: 'regression' },
    });
    const row = (await admin.query(`SELECT action, actor_type, tenant_id FROM audit.audit_events WHERE id = $1`, [id])).rows[0];
    expect(row).toMatchObject({ action: 'aba.test.recorded', actor_type: 'user', tenant_id: tenantId });
    await expect(admin.query(`UPDATE audit.audit_events SET action = 'x' WHERE id = $1`, [id])).rejects.toThrow(APPEND_ONLY);
  });

  it('a mutation that fails its audit-adjacent rollback leaves no partial history: rolled-back inserts vanish, committed ones stay', async () => {
    const before = (await admin.query(`SELECT count(*)::int n FROM audit.audit_events WHERE tenant_id = $1`, [tenantId])).rows[0].n;
    await expect(asTenant(tenantId, async (q) => {
      await q(`INSERT INTO audit.audit_events (tenant_id, workspace_id, actor_type, action, entity_type, correlation_id) VALUES ($1,$2,'system','test.rolled.back','e',gen_random_uuid())`, [tenantId, workspaceId]);
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect((await admin.query(`SELECT count(*)::int n FROM audit.audit_events WHERE tenant_id = $1`, [tenantId])).rows[0].n).toBe(before);
  });
});
