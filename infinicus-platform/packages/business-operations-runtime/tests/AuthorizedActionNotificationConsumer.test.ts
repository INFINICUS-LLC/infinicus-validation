/** P0-6b: the BO consumer of control_loop.action.authorized@1 - delivery semantics with fakes (no database). */
import { describe, expect, it } from 'vitest';
import { DeliveryError } from '@infinicus/database';
import type { StoredBusinessEvent, TenantContext } from '@infinicus/database';
import { buildActionAuthorizedEvent } from '@infinicus/event-contracts';
import type { ActionAuthorizedPayload } from '@infinicus/event-contracts';
import { AuthorizedActionNotificationConsumer, TRANSIENT_INTAKE_REFUSALS } from '../src/authorized-action/AuthorizedActionNotificationConsumer.js';
import { PackageIntakeRefusedError } from '../src/authorized-action/AuthorizedActionIntakeService.js';

const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const DIGEST = `sha256:${'b'.repeat(64)}`;
const ctx: TenantContext = { tenantId: U(2), workspaceId: U(3), userId: U(99) };
const payload = (over: Partial<ActionAuthorizedPayload> = {}): ActionAuthorizedPayload => ({
  packageId: U(1), packageVersion: 1, digest: DIGEST, scope: { tenantId: U(2), workspaceId: U(3), businessId: U(4) },
  actionType: { code: 'inventory_reorder_policy_update', schemaVersion: '1' }, automationLevel: 2, expiresAt: null, decisionId: U(5), issuedAt: '2026-10-12T10:00:00.000Z', ...over,
});
const eventOf = (p: ActionAuthorizedPayload = payload()): StoredBusinessEvent => buildActionAuthorizedEvent({ payload: p, correlationId: U(9), causationId: null, recordedAt: '2026-10-12T10:00:00.000Z' }) as StoredBusinessEvent;
const doc = (over: { id?: string; version?: number; digest?: string } = {}) => ({ identity: { packageId: over.id ?? U(1), packageVersion: over.version ?? 1 }, integrity: { digest: over.digest ?? DIGEST } });

function harness(o: {
  gate?: boolean | 'throw'; inbox?: 'started' | 'already_processed' | 'already_processing' | 'retry_allowed'; pulled?: unknown; intake?: () => Promise<unknown>; recorder?: () => Promise<unknown>; exec?: 'terminal' | 'replayed' | 'retry' | 'throw';
} = {}) {
  const log: string[] = [];
  const consumer = new AuthorizedActionNotificationConsumer({
    gate: { isEnabled: async () => { if (o.gate === 'throw') throw new Error('down'); return o.gate ?? true; } },
    inbox: {
      beginProcessing: async () => { log.push('inbox.begin'); return { state: o.inbox ?? 'started' } as never; },
      markProcessed: async () => { log.push('inbox.processed'); },
      markFailed: async () => { log.push('inbox.failed'); },
    },
    source: { get: async () => { log.push('source.get'); return o.pulled === undefined ? { document: doc(), digest: DIGEST } : (o.pulled as never); } },
    intake: { intake: async (_c, _r) => { log.push('intake'); return (o.intake ? o.intake() : { outcome: 'CLAIMED', receiptId: U(50), claimId: U(51), claimedAt: '2026-10-12T10:00:00.000Z' }) as never; } },
    executor: {
      executeClaim: async (_c, claimId) => {
        log.push(`execute:${claimId}`);
        if (o.exec === 'throw') throw new Error('claim not found');
        if (o.exec === 'retry') return { state: 'RETRY', attemptNumber: 1, reasonCode: 'STATUS_UNAVAILABLE', retryAfterMs: 1000 } as never;
        return { state: 'TERMINAL', execution: {}, replayed: o.exec === 'replayed' } as never;
      },
    },
    recorder: { recordConsumed: async (r) => { log.push(`mirror:${r.receiptId}`); return (o.recorder ? o.recorder() : { outcome: 'RECORDED', recordedAt: 'x' }) as never; } },
  });
  return { consumer, log };
}
const failure = async (p: Promise<unknown>): Promise<DeliveryError> => {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(DeliveryError); return e as DeliveryError; }
  throw new Error('expected a DeliveryError');
};

describe('AuthorizedActionNotificationConsumer', () => {
  it('claims through intake, then mirrors with the BO receipt and marks the inbox processed', async () => {
    const h = harness();
    await h.consumer.handle(ctx, eventOf());
    expect(h.log).toEqual(['inbox.begin', 'source.get', 'intake', `mirror:${U(50)}`, `execute:${U(51)}`, 'inbox.processed']);
  });

  it('P0-6e: after the claim and the mirror it hands the claim to the engine once - the only trigger - and a replayed terminal result ends the delivery', async () => {
    for (const exec of ['terminal', 'replayed'] as const) {
      const h = harness({ exec });
      await h.consumer.handle(ctx, eventOf());
      expect(h.log.filter((l) => l.startsWith('execute:'))).toEqual([`execute:${U(51)}`]);
      expect(h.log.at(-1)).toBe('inbox.processed');
    }
  });

  it('P0-6e: an engine that cannot decide yet is a RETRYABLE delivery failure (the outbox redelivers); the delivery is never marked processed', async () => {
    const h = harness({ exec: 'retry' });
    const e = await failure(h.consumer.handle(ctx, eventOf()));
    expect([e.code, e.retryable]).toEqual(['STATUS_UNAVAILABLE', true]);
    expect(h.log).toContain('inbox.failed');
    expect(h.log).not.toContain('inbox.processed');
  });

  it('P0-6e: nothing is executed unless a claim exists - a refused intake, a closed gate or a bad payload never reach the engine', async () => {
    const refused = harness({ intake: async () => { throw new PackageIntakeRefusedError(['PACKAGE_REVOKED']); } });
    await refused.consumer.handle(ctx, eventOf());
    const closed = harness({ gate: false });
    await failure(closed.consumer.handle(ctx, eventOf()));
    const bad = harness();
    await failure(bad.consumer.handle(ctx, { ...eventOf(), payload: { x: 1 } } as StoredBusinessEvent));
    for (const h of [refused, closed, bad]) expect(h.log.some((l) => l.startsWith('execute:'))).toBe(false);
  });

  it('refuses a payload that is not the reference-only shape (non-retryable) before touching anything', async () => {
    const h = harness();
    const bad = { ...eventOf(), payload: { ...payload(), package: { x: 1 } } } as StoredBusinessEvent;
    const e = await failure(h.consumer.handle(ctx, bad));
    expect([e.code, e.retryable]).toEqual(['PAYLOAD_INVALID', false]);
    expect(h.log).toEqual([]);
  });

  it('refuses a notification whose scope is not the delivery scope (non-retryable)', async () => {
    for (const over of [{ scope: { tenantId: U(7), workspaceId: U(3), businessId: U(4) } }, { scope: { tenantId: U(2), workspaceId: U(7), businessId: U(4) } }]) {
      const h = harness();
      const e = await failure(h.consumer.handle(ctx, { ...eventOf(payload(over)), businessId: over.scope.businessId } as StoredBusinessEvent));
      expect(e.code).toBe('SCOPE_MISMATCH');
      expect(h.log).toEqual([]);
    }
    const h = harness();
    expect((await failure(h.consumer.handle(ctx, { ...eventOf(), businessId: U(8) } as StoredBusinessEvent))).code).toBe('SCOPE_MISMATCH');
    // a stored event whose envelope scope is the delivery scope but whose payload names another tenant or workspace
    for (const scope of [{ tenantId: U(7), workspaceId: U(3), businessId: U(4) }, { tenantId: U(2), workspaceId: U(7), businessId: U(4) }]) {
      const g = harness();
      const forged = { ...eventOf(), payload: payload({ scope }) } as StoredBusinessEvent;
      expect((await failure(g.consumer.handle(ctx, forged))).code, JSON.stringify(scope)).toBe('SCOPE_MISMATCH');
      expect(g.log).toEqual([]);
    }
  });

  it('a closed or failing gate is a non-retryable CAPABILITY_DISABLED with no inbox row, pull, intake or mirror', async () => {
    for (const gate of [false, 'throw'] as const) {
      const h = harness({ gate });
      const e = await failure(h.consumer.handle(ctx, eventOf()));
      expect([e.code, e.retryable]).toEqual(['CAPABILITY_DISABLED', false]);
      expect(h.log).toEqual([]);
    }
  });

  it('is idempotent: an already-processed notification does nothing; one being processed elsewhere is retried', async () => {
    const done = harness({ inbox: 'already_processed' });
    await done.consumer.handle(ctx, eventOf());
    expect(done.log).toEqual(['inbox.begin']);
    const busy = harness({ inbox: 'already_processing' });
    const e = await failure(busy.consumer.handle(ctx, eventOf()));
    expect([e.code, e.retryable]).toEqual(['IN_PROGRESS', true]);
    expect(busy.log).toEqual(['inbox.begin']);
    const retry = harness({ inbox: 'retry_allowed' });
    await retry.consumer.handle(ctx, eventOf());
    expect(retry.log).toContain('intake');
  });

  it('an unavailable package is retryable and marks the inbox failed so the retry can proceed', async () => {
    const h = harness({ pulled: null });
    const e = await failure(h.consumer.handle(ctx, eventOf()));
    expect([e.code, e.retryable]).toEqual(['PACKAGE_UNAVAILABLE', true]);
    expect(h.log).toEqual(['inbox.begin', 'source.get', 'inbox.failed']);
  });

  it('a pulled package that is not the one named (id, version or digest) is non-retryable and never reaches intake', async () => {
    for (const pulled of [
      { document: doc({ id: U(77) }), digest: DIGEST }, { document: doc({ version: 2 }), digest: DIGEST },
      { document: doc({ digest: `sha256:${'c'.repeat(64)}` }), digest: DIGEST }, { document: doc(), digest: `sha256:${'c'.repeat(64)}` },
      { document: 'not an object', digest: DIGEST },
    ]) {
      const h = harness({ pulled });
      const e = await failure(h.consumer.handle(ctx, eventOf()));
      expect([e.code, e.retryable]).toEqual(['PACKAGE_MISMATCH', false]);
      expect(h.log).not.toContain('intake');
      expect(h.log).toContain('inbox.failed');
    }
  });

  it('transient intake refusals are retried; a final refusal is a handled outcome with no mirror', async () => {
    expect([...TRANSIENT_INTAKE_REFUSALS].sort()).toEqual(['AUTHORITY_UNVERIFIABLE', 'EXECUTION_WINDOW_NOT_OPEN', 'STATUS_UNAVAILABLE', 'STATUS_UNVERIFIED']);
    for (const codes of [['STATUS_UNAVAILABLE'], ['STATUS_UNVERIFIED'], ['AUTHORITY_UNVERIFIABLE'], ['EXECUTION_WINDOW_NOT_OPEN'], ['STATUS_UNVERIFIED', 'AUTHORITY_UNVERIFIABLE']]) {
      const h = harness({ intake: async () => { throw new PackageIntakeRefusedError(codes); } });
      const e = await failure(h.consumer.handle(ctx, eventOf()));
      expect(e.retryable, codes.join()).toBe(true);
      expect(h.log).toContain('inbox.failed');
      expect(h.log.some((l) => l.startsWith('mirror'))).toBe(false);
    }
    for (const codes of [['AUTHORITY_REVOKED'], ['PACKAGE_REVOKED'], ['ACTION_TYPE_UNSUPPORTED_BY_EXECUTOR'], ['STATUS_UNAVAILABLE', 'AUTHORITY_REVOKED'], []]) {
      const h = harness({ intake: async () => { throw new PackageIntakeRefusedError(codes); } });
      await h.consumer.handle(ctx, eventOf());
      expect(h.log, codes.join()).toEqual(['inbox.begin', 'source.get', 'intake', 'inbox.processed']);
    }
  });

  it('an unexpected intake or mirror error is not swallowed: the inbox is marked failed and the error propagates for retry', async () => {
    const a = harness({ intake: async () => { throw new Error('db down'); } });
    await expect(a.consumer.handle(ctx, eventOf())).rejects.toThrow('db down');
    expect(a.log).toContain('inbox.failed');
    const b = harness({ recorder: async () => { throw new Error('aba down'); } });
    await expect(b.consumer.handle(ctx, eventOf())).rejects.toThrow('aba down');
    expect(b.log).toEqual(['inbox.begin', 'source.get', 'intake', `mirror:${U(50)}`, 'inbox.failed']);
  });

  it('an unrecordable mirror is not a delivery failure (BO\'s claim is canonical)', async () => {
    const h = harness({ recorder: async () => ({ outcome: 'NOT_RECORDABLE', reason: 'OTHER_TERMINAL_STATE' }) });
    await h.consumer.handle(ctx, eventOf());
    expect(h.log.at(-1)).toBe('inbox.processed');
  });

  it('exposes the consumer name that subscriptions route to', () => {
    expect(AuthorizedActionNotificationConsumer.NAME).toBe('bo.authorized_action_intake');
  });
});
