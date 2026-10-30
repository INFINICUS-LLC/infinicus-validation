import { describe, expect, it } from 'vitest';
import { EventWorker } from '../src/EventWorker.js';
import { assertNoScopeErrors, describeScopeError, newScopeErrorLog, recordScopeErrors } from './helpers/scopeErrors.js';

/** CI-STAB-02 R2: the helper makes a swallowed scope error fail the test at the cycle that swallowed it, with a redacted cause. */
const ACTOR = '00000000-0000-4000-8000-000000000001';
const scope = (n: number) => ({ tenantId: `00000000-0000-4000-8000-00000000010${n}`, workspaceId: `00000000-0000-4000-8000-00000000020${n}` });
const summary = { recovered: 0, claimed: 1, published: 1, retryScheduled: 0, deadLettered: 0 };

function worker(dispatch: (tenantId: string) => Promise<typeof summary>, log = newScopeErrorLog()) {
  const w = new EventWorker({
    discovery: { discover: async () => [scope(1), scope(2)] },
    dispatcher: { dispatchScope: async (ctx) => dispatch(ctx.tenantId) },
    eventTypes: ['x.y.z'], actorUserId: ACTOR, batchSize: 1, claimTimeoutMs: 1, maxScopesPerCycle: 5,
    onScopeError: recordScopeErrors(log),
  });
  return { w, log };
}

describe('scope-error visibility helper', () => {
  it('a clean cycle passes and records nothing', async () => {
    const { w, log } = worker(async () => summary);
    const result = await w.runOnce();
    expect(() => assertNoScopeErrors(log, result)).not.toThrow();
    expect(log.entries).toEqual([]);
  });

  it('a scope that throws is swallowed by the worker (unchanged behavior) but FAILS the helper, naming the cause', async () => {
    const dbError = Object.assign(new Error('canceling statement due to lock timeout on 3f2b8c1e-9d4a-4e6b-8c7d-1a2b3c4d5e6f'), { code: '55P03', name: 'error' });
    const { w, log } = worker(async (tenantId) => { if (tenantId === scope(2).tenantId) throw dbError; return summary; });
    const result = await w.runOnce();
    expect(result).toMatchObject({ scopes: 2, published: 1, scopeErrors: 1 });          // the production worker still survives and counts it
    let thrown: Error | undefined;
    try { assertNoScopeErrors(log, result, 'recovery pass'); } catch (error) { thrown = error as Error; }
    expect(thrown?.message).toContain('recovery pass swallowed 1 scope error(s)');
    expect(thrown?.message).toContain('code=55P03');
    expect(thrown?.message).toContain('lock timeout');
    expect(thrown?.message).not.toContain('3f2b8c1e');                                  // identifiers are redacted
    expect(thrown?.message).not.toContain('at ');                                       // never a stack
  });

  it('only the NEW errors since the last check are reported, so one failure is not blamed on every later cycle', async () => {
    let fail = true;
    const { w, log } = worker(async () => { if (fail) throw new Error('first'); return summary; });
    const first = await w.runOnce();
    expect(() => assertNoScopeErrors(log, first)).toThrow(/first/);
    fail = false;
    const second = await w.runOnce();
    expect(() => assertNoScopeErrors(log, second)).not.toThrow();
  });

  it('a counted error with no callback entry still fails', () => {
    expect(() => assertNoScopeErrors(newScopeErrorLog(), { scopeErrors: 2 })).toThrow(/swallowed 2 scope error\(s\)/);
  });

  it('descriptions are bounded and tolerate non-Error throwables', () => {
    expect(describeScopeError('x'.repeat(5000)).length).toBeLessThanOrEqual(310);
    expect(describeScopeError(undefined)).toContain('Error');
    expect(describeScopeError({ message: 'plain object', code: '40P01' })).toContain('code=40P01');
  });
});
