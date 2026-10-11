/**
 * P0-5 Block 3d - live proof of the opt-in shared tenant transaction the ABA issuer uses (no schema change).
 * Requires DATABASE_URL (RLS-enforced app role) and ADMIN_DATABASE_URL (fixtures / inspection).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { closePool, createPool, withSharedTenantTransaction, withTenantTransaction, SharedTransactionScopeError, type TenantContext } from '../src/client.js';
import { AuthorizedActionIssuanceRepository } from '../src/repositories/approved_action/AuthorizedActionIssuanceRepository.js';
import { makeWorld, makeUser, type World } from './helpers/aapFixtures.js';

const run = Boolean(process.env.DATABASE_URL && process.env.ADMIN_DATABASE_URL);
let admin: Pool;
let world: World;
let other: World;
let ctx: TenantContext;
const repo = new AuthorizedActionIssuanceRepository();
const audit = (tag: string) => repo.recordAudit(ctx, { businessId: world.businessId, decisionId: null, eventType: 'package.issued', detail: { tag } });
const rows = async (tag: string): Promise<number> =>
  Number((await admin.query(`SELECT count(*) n FROM approved_business_action.approval_audit_events WHERE business_id=$1 AND detail->>'tag'=$2`, [world.businessId, tag])).rows[0].n);

describe.runIf(run)('P0-5 Block 3d: shared tenant transaction', () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
    createPool({ connectionString: process.env.DATABASE_URL as string });
    world = await makeWorld(admin);
    other = await makeWorld(admin);
    ctx = { tenantId: world.tenantId, workspaceId: world.workspaceId, userId: await makeUser(admin) };
  });
  afterAll(async () => {
    await admin?.end();
    await closePool();
  });

  it('every repository call inside the scope joins ONE transaction: an error rolls all of them back', async () => {
    const tag = randomUUID();
    await expect(withSharedTenantTransaction(ctx, async () => {
      await audit(tag);
      await audit(tag);
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(await rows(tag)).toBe(0);
  });

  it('commits them together when the scope succeeds', async () => {
    const tag = randomUUID();
    await withSharedTenantTransaction(ctx, async () => { await audit(tag); await audit(tag); });
    expect(await rows(tag)).toBe(2);
  });

  it('is invisible until commit (the joined writes are not separately committed)', async () => {
    const tag = randomUUID();
    await withSharedTenantTransaction(ctx, async () => {
      await audit(tag);
      expect(await rows(tag)).toBe(0);
    });
    expect(await rows(tag)).toBe(1);
  });

  it('outside the scope nothing changes: each call is its own transaction', async () => {
    const tag = randomUUID();
    await audit(tag);
    await expect((async () => { await audit(tag); throw new Error('after'); })()).rejects.toThrow('after');
    expect(await rows(tag)).toBe(2);
  });

  it('keeps the tenant / workspace context set for RLS inside the scope', async () => {
    await withSharedTenantTransaction(ctx, async () => {
      const seen = await withTenantTransaction(ctx, async (c) => (await c.query("SELECT current_setting('app.tenant_id') t, current_setting('app.workspace_id') w")).rows[0]);
      expect(seen).toEqual({ t: world.tenantId, w: world.workspaceId });
    });
  });

  it('fails closed when a joined call targets another tenant or workspace', async () => {
    const tag = randomUUID();
    const foreign: TenantContext = { tenantId: other.tenantId, workspaceId: other.workspaceId, userId: ctx.userId };
    await expect(withSharedTenantTransaction(ctx, async () => {
      await audit(tag);
      await withTenantTransaction(foreign, async () => 1);
    })).rejects.toBeInstanceOf(SharedTransactionScopeError);
    expect(await rows(tag)).toBe(0);
    const sameTenantOtherWorkspace: TenantContext = { ...ctx, workspaceId: other.workspaceId };
    await expect(withSharedTenantTransaction(ctx, async () => { await withTenantTransaction(sameTenantOtherWorkspace, async () => 1); })).rejects.toBeInstanceOf(SharedTransactionScopeError);
  });

  it('cannot be nested', async () => {
    await expect(withSharedTenantTransaction(ctx, async () => { await withSharedTenantTransaction(ctx, async () => 1); })).rejects.toBeInstanceOf(SharedTransactionScopeError);
  });

  it('does not leak between concurrent scopes', async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    await Promise.allSettled([
      withSharedTenantTransaction(ctx, async () => { await audit(a); await new Promise((r) => setTimeout(r, 30)); throw new Error('a fails'); }),
      withSharedTenantTransaction(ctx, async () => { await audit(b); await new Promise((r) => setTimeout(r, 10)); }),
    ]);
    expect(await rows(a)).toBe(0);
    expect(await rows(b)).toBe(1);
  });
});
