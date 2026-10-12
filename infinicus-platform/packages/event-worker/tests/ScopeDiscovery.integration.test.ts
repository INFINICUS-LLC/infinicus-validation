/** P0-6b: cross-tenant scope discovery (the narrow read the worker uses). Requires ADMIN_DATABASE_URL (RLS-bypassing, as the discovery role is). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { SqlScopeDiscovery } from '../src/index.js';
import { makeWorld } from '../../workflow/tests/helpers/issuanceFixture.js';

const run = Boolean(process.env.ADMIN_DATABASE_URL);
const TYPE = 'control_loop.action.authorized';
const NOW = new Date('2026-10-12T10:00:00.000Z');

describe.runIf(run)('SqlScopeDiscovery', () => {
  let admin: Pool;
  let discovery: SqlScopeDiscovery;
  beforeAll(() => { admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL }); discovery = new SqlScopeDiscovery(admin); });
  afterAll(async () => { await admin?.end(); });

  async function row(w: { tenantId: string; workspaceId: string }, o: { type?: string; status?: string; availableAt?: Date; claimedAt?: Date | null; workspace?: boolean } = {}): Promise<void> {
    await admin.query(
      `INSERT INTO events.outbox_events (event_type, event_version, tenant_id, workspace_id, correlation_id, aggregate_type, aggregate_id, payload, status, available_at, claimed_at)
       VALUES ($1,'1',$2,$3,$4,'authorized_action_package',$5,'{}',$6,$7,$8)`,
      [o.type ?? TYPE, w.tenantId, o.workspace === false ? null : w.workspaceId, randomUUID(), randomUUID(), o.status ?? 'pending', o.availableAt ?? NOW, o.claimedAt ?? null]);
  }
  const find = async (limit = 500) => discovery.discover({ now: NOW, eventTypes: [TYPE], staleBefore: new Date(NOW.getTime() - 60_000), limit });
  const has = (list: { tenantId: string }[], w: { tenantId: string }) => list.some((s) => s.tenantId === w.tenantId);

  it('finds scopes with due pending or failed rows of the configured types, once per scope, across tenants', async () => {
    const a = await makeWorld(admin); const b = await makeWorld(admin);
    await row(a); await row(a, { status: 'failed' }); await row(b);
    const found = await find();
    expect(found.filter((s) => s.tenantId === a.tenantId)).toEqual([{ tenantId: a.tenantId, workspaceId: a.workspaceId }]);
    expect(has(found, b)).toBe(true);
  });

  it('ignores other event types (legacy rows), future rows, published/dead-lettered rows and workspace-less rows', async () => {
    const w = await makeWorld(admin);
    await row(w, { type: 'bo.inventory.movement_recorded' });
    await row(w, { availableAt: new Date(NOW.getTime() + 1000) });
    await row(w, { status: 'published' }); await row(w, { status: 'dead_lettered' });
    await row(w, { workspace: false });
    expect(has(await find(), w)).toBe(false);
  });

  it('treats a row abandoned in processing as dispatchable only after the claim timeout, and never one without a claim time', async () => {
    const fresh = await makeWorld(admin); const stale = await makeWorld(admin); const historic = await makeWorld(admin);
    await row(fresh, { status: 'processing', claimedAt: new Date(NOW.getTime() - 30_000) });
    await row(stale, { status: 'processing', claimedAt: new Date(NOW.getTime() - 61_000) });
    await row(historic, { status: 'processing', claimedAt: null });
    const found = await find();
    expect([has(found, fresh), has(found, stale), has(found, historic)]).toEqual([false, true, false]);
  });

  it('is bounded by the limit', async () => {
    for (let i = 0; i < 3; i += 1) await row(await makeWorld(admin));
    expect((await find(2)).length).toBe(2);
    expect((await find(0)).length).toBe(1);
  });
});
