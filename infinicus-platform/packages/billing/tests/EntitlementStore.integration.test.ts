/**
 * POS2-02: the entitlement store through EntitlementService, on live PostgreSQL 16. Development and test fixtures only: the rows are written by the test
 * through the governed functions on the admin connection. Requires DATABASE_URL (application role) and ADMIN_DATABASE_URL.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { createPool, closePool, EntitlementRepository, type TenantContext, type GrantEntitlementInput } from '@infinicus/database';
import { EntitlementService } from '../src/EntitlementService.js';
import { CapabilityNotEntitledError, SubscriptionSuspendedError } from '../src/errors.js';
import type { Capability } from '../src/capabilities.js';

const run = !!process.env.DATABASE_URL;
const DAY = 86_400_000;
const ago = (ms: number) => new Date(Date.now() - ms);
const ahead = (ms: number) => new Date(Date.now() + ms);
let admin: Pool;
const service = new EntitlementService();

async function tenantCtx(label: string): Promise<TenantContext> {
  const tenantId = randomUUID(); const workspaceId = randomUUID(); const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  await admin.query(`INSERT INTO tenancy.tenants (id, name, slug, status, plan_code) VALUES ($1,$2,$3,'active','test')`, [tenantId, `Store ${label}`, `store-${label}-${sfx}`]);
  await admin.query(`INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,$3,$4,'active')`, [workspaceId, tenantId, `Store WS ${label}`, `store-ws-${label}-${sfx}`]);
  return { tenantId, workspaceId, userId: randomUUID() };
}
async function governed<T>(tenantId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await admin.connect();
  try {
    await c.query('BEGIN'); await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const out = await fn(c); await c.query('COMMIT'); return out;
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
const grant = (ctx: TenantContext, capability: string, over: Partial<GrantEntitlementInput> = {}) =>
  governed(ctx.tenantId, (c) => EntitlementRepository.grant(c, ctx.tenantId, {
    capability, sourceType: 'operator_grant', sourceReference: `fx-${randomUUID()}`, effectiveFrom: ago(DAY), ...over }));
const allowed = async (ctx: TenantContext, cap: Capability) => { try { await service.enforceCapability(ctx, cap); return true; } catch (e) { if (e instanceof CapabilityNotEntitledError) return false; throw e; } };

describe.runIf(run)('entitlement store through EntitlementService - live PostgreSQL', () => {
  beforeAll(() => {
    createPool({ connectionString: process.env.DATABASE_URL! });
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });
  });
  afterAll(async () => { await admin.end(); await closePool(); });

  it('the four required shapes: POS Core; POS Core + Growth; Growth only; POS Core + Pro + an add-on', async () => {
    const A = await tenantCtx('A'); const B = await tenantCtx('B'); const C = await tenantCtx('C'); const D = await tenantCtx('D');
    await grant(A, 'pos.core', { sourceType: 'subscription' });
    await grant(B, 'pos.core', { sourceType: 'subscription' }); await grant(B, 'intelligence.growth', { sourceType: 'subscription' });
    await grant(C, 'intelligence.growth', { sourceType: 'subscription' });
    await grant(D, 'pos.core', { sourceType: 'subscription' }); await grant(D, 'intelligence.pro', { sourceType: 'subscription' }); await grant(D, 'pos.inventory', { sourceType: 'add_on' });

    const matrix: [string, TenantContext, Capability[], Capability[]][] = [
      ['A', A, ['pos.core'], ['pos.inventory', 'intelligence.growth', 'intelligence.pro', 'pos.offline', 'enterprise.custom_limits']],
      ['B', B, ['pos.core', 'intelligence.growth'], ['intelligence.pro', 'pos.inventory']],
      ['C', C, ['intelligence.growth'], ['pos.core', 'pos.inventory', 'intelligence.pro']],
      ['D', D, ['pos.core', 'intelligence.pro', 'pos.inventory'], ['intelligence.growth', 'pos.offline']],
    ];
    for (const [name, ctx, yes, no] of matrix) {
      for (const c of yes) expect(await allowed(ctx, c), `${name} should hold ${c}`).toBe(true);
      for (const c of no) expect(await allowed(ctx, c), `${name} must not hold ${c}`).toBe(false);
      const profile = await service.resolveProfile(ctx);
      expect(profile.basis).toBe('store');
      expect([...profile.capabilities].sort()).toEqual([...yes].sort());
    }
  });

  it('a tenant with no store rows keeps today\'s behaviour: every functional subscription holds every capability (compatibility)', async () => {
    const ctx = await tenantCtx('compat');
    const profile = await service.resolveProfile(ctx);
    expect(profile.basis).toBe('compatibility');
    expect(await allowed(ctx, 'pos.core')).toBe(true);
    expect(await allowed(ctx, 'intelligence.pro')).toBe(true);
  });

  it('one tenant\'s rows never change another tenant\'s answer', async () => {
    const withRows = await tenantCtx('iso-a'); const without = await tenantCtx('iso-b');
    await grant(withRows, 'pos.core');
    expect((await service.resolveProfile(withRows)).basis).toBe('store');
    expect((await service.resolveProfile(without)).basis).toBe('compatibility');
    expect(await allowed(without, 'intelligence.pro')).toBe(true);
    expect(await allowed(withRows, 'intelligence.pro')).toBe(false);
  });

  it('expired, not-yet-started and revoked entitlements deny, and never fall back to compatibility', async () => {
    const ctx = await tenantCtx('lifecycle');
    await grant(ctx, 'pos.core', { effectiveFrom: ago(10 * DAY), effectiveUntil: ago(DAY) });            // expired
    await grant(ctx, 'pos.inventory', { effectiveFrom: ahead(DAY) });                                      // not started
    const g = await grant(ctx, 'pos.offline');                                                              // active, then revoked
    expect(await allowed(ctx, 'pos.offline')).toBe(true);
    await governed(ctx.tenantId, (c) => EntitlementRepository.revoke(c, ctx.tenantId, g.id));
    for (const c of ['pos.core', 'pos.inventory', 'pos.offline', 'intelligence.growth'] as Capability[]) expect(await allowed(ctx, c), c).toBe(false);
    expect((await service.resolveProfile(ctx)).basis).toBe('store');
  });

  it('several sources for one capability: it holds while any source is effective', async () => {
    const ctx = await tenantCtx('multi');
    const trial = await grant(ctx, 'pos.core', { sourceType: 'trial', effectiveUntil: ahead(DAY) });
    const contract = await grant(ctx, 'pos.core', { sourceType: 'enterprise_contract' });
    await governed(ctx.tenantId, (c) => EntitlementRepository.revoke(c, ctx.tenantId, trial.id));
    expect(await allowed(ctx, 'pos.core')).toBe(true);
    await governed(ctx.tenantId, (c) => EntitlementRepository.revoke(c, ctx.tenantId, contract.id));
    expect(await allowed(ctx, 'pos.core')).toBe(false);
  });

  it('an unknown capability is denied: a key outside the vocabulary grants nothing even if stored, and asking for one fails closed', async () => {
    const ctx = await tenantCtx('unknown');
    await grant(ctx, 'pos.future_thing');
    const profile = await service.resolveProfile(ctx);
    expect([...profile.capabilities]).toEqual([]);
    expect(await allowed(ctx, 'pos.future_thing' as Capability)).toBe(false);
    expect(await allowed(ctx, 'pos.core')).toBe(false);
  });

  it('a suspended subscription still stops a store-entitled tenant with the same 402 error', async () => {
    const ctx = await tenantCtx('suspended');
    await grant(ctx, 'pos.core');
    await service.startSubscription(ctx, 'free');
    await service.suspend(ctx, 'pos2_02_test');
    await expect(service.enforceCapability(ctx, 'pos.core')).rejects.toThrow(SubscriptionSuspendedError);
  });

  it('wasEntitledAt answers from history, and is no for a tenant with no store rows or an unknown capability', async () => {
    const ctx = await tenantCtx('history'); const none = await tenantCtx('history-none');
    const t0 = Date.now();
    const g = await grant(ctx, 'pos.core', { effectiveFrom: new Date(t0 - 10 * DAY), effectiveUntil: new Date(t0 + 10 * DAY) });
    expect(await service.wasEntitledAt(ctx, 'pos.core', new Date(t0 - 5 * DAY))).toBe(true);
    expect(await service.wasEntitledAt(ctx, 'pos.core', new Date(t0 - 11 * DAY))).toBe(false);
    expect(await service.wasEntitledAt(ctx, 'pos.core', new Date(t0 + 11 * DAY))).toBe(false);
    expect(await service.wasEntitledAt(ctx, 'pos.inventory', new Date(t0 - 5 * DAY))).toBe(false);
    expect(await service.wasEntitledAt(ctx, 'pos.nope', new Date(t0 - 5 * DAY))).toBe(false);
    const before = new Date(); await new Promise((r) => setTimeout(r, 20));
    await governed(ctx.tenantId, (c) => EntitlementRepository.revoke(c, ctx.tenantId, g.id));
    expect(await service.wasEntitledAt(ctx, 'pos.core', before)).toBe(true);        // held until the revocation moment
    expect(await service.wasEntitledAt(ctx, 'pos.core', new Date())).toBe(false);
    expect(await service.wasEntitledAt(none, 'pos.core', new Date())).toBe(false);  // compatibility has no history
  });
});

describe.skipIf(run)('entitlement store through EntitlementService (skipped, no DATABASE_URL)', () => {
  it('skips live tests when DATABASE_URL is not set', () => { expect(run).toBe(false); });
});
