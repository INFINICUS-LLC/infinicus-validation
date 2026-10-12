import { describe, expect, it } from 'vitest';
import type { DispatchSummary, TenantContext } from '@infinicus/database';
import { EventWorker } from '../src/index.js';
import type { ScopeDiscovery } from '../src/index.js';

const ACTOR = '00000000-0000-4000-8000-0000000000aa';
const scope = (n: number) => ({ tenantId: `00000000-0000-4000-8000-0000000001${n}0`.slice(0, 36), workspaceId: `00000000-0000-4000-8000-0000000002${n}0`.slice(0, 36) });
const summary = (over: Partial<DispatchSummary> = {}): DispatchSummary => ({ recovered: 0, claimed: 0, published: 0, retryScheduled: 0, deadLettered: 0, ...over });

function worker(discovered: ReturnType<typeof scope>[], dispatch: (ctx: TenantContext) => Promise<DispatchSummary>, over: Record<string, unknown> = {}) {
  const calls: { discover?: unknown; ctxs: TenantContext[]; batch: number[] } = { ctxs: [], batch: [] };
  const discovery: ScopeDiscovery = { discover: async (i) => { calls.discover = i; return discovered; } };
  const w = new EventWorker({
    discovery, dispatcher: { dispatchScope: async (ctx, o) => { calls.ctxs.push(ctx); calls.batch.push(o.batchSize); return dispatch(ctx); } },
    eventTypes: ['control_loop.action.authorized'], actorUserId: ACTOR, batchSize: 7, claimTimeoutMs: 60_000, maxScopesPerCycle: 5,
    clock: () => new Date('2026-10-12T10:00:00.000Z'), ...over,
  });
  return { w, calls };
}

describe('EventWorker', () => {
  it('discovers scopes for the configured types and dispatches each under its own tenant context and the worker identity', async () => {
    const { w, calls } = worker([scope(1), scope(2)], async () => summary({ claimed: 2, published: 2 }));
    const r = await w.runOnce();
    expect(calls.discover).toMatchObject({ eventTypes: ['control_loop.action.authorized'], limit: 5, staleBefore: new Date('2026-10-12T09:59:00.000Z') });
    expect(calls.ctxs).toEqual([{ ...scope(1), userId: ACTOR }, { ...scope(2), userId: ACTOR }]);
    expect(calls.batch).toEqual([7, 7]);
    expect(r).toMatchObject({ scopes: 2, claimed: 4, published: 4, scopeErrors: 0 });
  });

  it('does nothing when there are no scopes (and never dispatches without discovery)', async () => {
    const { w, calls } = worker([], async () => summary());
    expect(await w.runOnce()).toMatchObject({ scopes: 0, claimed: 0 });
    expect(calls.ctxs).toEqual([]);
  });

  it('one scope failing does not stop the others, and is reported', async () => {
    const seen: unknown[] = [];
    const { w } = worker([scope(1), scope(2), scope(3)], async (ctx) => {
      if (ctx.tenantId === scope(2).tenantId) throw new Error('boom');
      return summary({ claimed: 1, published: 1 });
    }, { onScopeError: (s: unknown) => seen.push(s) });
    const r = await w.runOnce();
    expect(r).toMatchObject({ scopes: 3, published: 2, scopeErrors: 1 });
    expect(seen).toEqual([scope(2)]);
  });

  it('sums retry and dead-letter counts', async () => {
    const { w } = worker([scope(1)], async () => summary({ claimed: 3, published: 1, retryScheduled: 1, deadLettered: 1, recovered: 2 }));
    expect(await w.runOnce()).toMatchObject({ claimed: 3, published: 1, retryScheduled: 1, deadLettered: 1, recovered: 2 });
  });

  it('refuses to be built without a UUID actor, positive sizes or event types', () => {
    const d = { discovery: { discover: async () => [] }, dispatcher: { dispatchScope: async () => summary() } };
    const ok = { ...d, eventTypes: ['x.y.z'], actorUserId: ACTOR, batchSize: 1, claimTimeoutMs: 1, maxScopesPerCycle: 1 };
    expect(() => new EventWorker(ok)).not.toThrow();
    for (const bad of [{ actorUserId: 'x' }, { batchSize: 0 }, { claimTimeoutMs: -1 }, { maxScopesPerCycle: Number.NaN }, { eventTypes: [] }]) {
      expect(() => new EventWorker({ ...ok, ...bad })).toThrow();
    }
  });

  it('run loops until aborted, sleeps only when idle, and survives a failing cycle', async () => {
    let cycles = 0;
    const ac = new AbortController();
    const discovery: ScopeDiscovery = { discover: async () => { cycles += 1; if (cycles === 1) throw new Error('db down'); return cycles === 2 ? [scope(1)] : []; } };
    const errors: unknown[] = [];
    const w = new EventWorker({
      discovery, dispatcher: { dispatchScope: async () => summary({ claimed: 1, published: 1 }) }, eventTypes: ['x.y.z'], actorUserId: ACTOR,
      batchSize: 1, claimTimeoutMs: 1, maxScopesPerCycle: 1, onScopeError: (s) => errors.push(s),
    });
    const sleeps: number[] = [];
    await w.run(ac.signal, 250, async (ms) => { sleeps.push(ms); if (sleeps.length === 2) ac.abort(); });
    expect(cycles).toBe(3); // failed (sleep), productive (no sleep), idle (sleep + abort)
    expect(sleeps).toEqual([250, 250]);
    expect(errors).toEqual([{ tenantId: '*', workspaceId: '*' }]);
  });
});
