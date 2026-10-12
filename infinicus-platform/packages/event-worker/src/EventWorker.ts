/**
 * The worker cycle: discover scopes with dispatchable outbox rows, then dispatch each scope under its own tenant context. One scope's
 * failure never stops the others. `run` is a plain loop owned by the worker PROCESS (infrastructure/deployment/event-worker); nothing in
 * the API process starts, polls or schedules it.
 */
import type { DispatchSummary, OutboxDispatcher, TenantContext } from '@infinicus/database';
import type { ScopeDiscovery } from './ScopeDiscovery.js';

export interface EventWorkerDependencies {
  discovery: ScopeDiscovery;
  dispatcher: Pick<OutboxDispatcher, 'dispatchScope'>;
  eventTypes: readonly string[];
  /** The worker's system identity recorded in each scope's tenant context. Required: no default identity is invented. */
  actorUserId: string;
  batchSize: number;
  claimTimeoutMs: number;
  maxScopesPerCycle: number;
  clock?: () => Date;
  onScopeError?: (scope: { tenantId: string; workspaceId: string }, error: unknown) => void;
}

export interface WorkerCycleSummary extends DispatchSummary {
  scopes: number;
  scopeErrors: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const empty = (): WorkerCycleSummary => ({ recovered: 0, claimed: 0, published: 0, retryScheduled: 0, deadLettered: 0, scopes: 0, scopeErrors: 0 });

export class EventWorker {
  private readonly clock: () => Date;

  constructor(private readonly d: EventWorkerDependencies) {
    if (!UUID.test(d.actorUserId)) throw new Error('the worker actor user id must be a lowercase UUID');
    for (const [name, value] of [['batchSize', d.batchSize], ['claimTimeoutMs', d.claimTimeoutMs], ['maxScopesPerCycle', d.maxScopesPerCycle]] as const) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
    }
    if (d.eventTypes.length === 0) throw new Error('the worker needs at least one event type');
    this.clock = d.clock ?? (() => new Date());
  }

  async runOnce(): Promise<WorkerCycleSummary> {
    const now = this.clock();
    const scopes = await this.d.discovery.discover({
      now, eventTypes: this.d.eventTypes, staleBefore: new Date(now.getTime() - this.d.claimTimeoutMs), limit: this.d.maxScopesPerCycle,
    });
    const total = empty();
    for (const scope of scopes) {
      const ctx: TenantContext = { tenantId: scope.tenantId, workspaceId: scope.workspaceId, userId: this.d.actorUserId };
      total.scopes += 1;
      try {
        const s = await this.d.dispatcher.dispatchScope(ctx, { batchSize: this.d.batchSize });
        total.recovered += s.recovered; total.claimed += s.claimed; total.published += s.published;
        total.retryScheduled += s.retryScheduled; total.deadLettered += s.deadLettered;
      } catch (error) {
        total.scopeErrors += 1;
        this.d.onScopeError?.(scope, error);
      }
    }
    return total;
  }

  /** Loops until `signal` aborts. Sleeps `idleMs` after a cycle that found nothing, and does not sleep after productive cycles. */
  async run(signal: AbortSignal, idleMs: number, sleep: (ms: number, signal: AbortSignal) => Promise<void> = defaultSleep): Promise<void> {
    while (!signal.aborted) {
      let busy = false;
      try {
        const s = await this.runOnce();
        busy = s.claimed > 0;
      } catch (error) {
        this.d.onScopeError?.({ tenantId: '*', workspaceId: '*' }, error);
      }
      if (!busy && !signal.aborted) await sleep(idleMs, signal);
    }
  }
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}
