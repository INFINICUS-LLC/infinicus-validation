/**
 * Publication of `operations.action.executed@1` by the BO execution engine (P0-6d).
 *
 * The event is written on the ENGINE'S OWN transaction client, in the same transaction as the terminal execution row, through the
 * existing BUILD-33 outbox (an idempotent insert keyed by the deterministic event id). Consequently an execution cannot commit without its
 * event, a rolled-back execution leaves no event, and a replay or retry never announces the same execution twice. Delivery after commit is
 * the dispatcher's job (at-least-once; OM's consumer is idempotent).
 *
 * The payload is a REFERENCE to the canonical evidence (execution id + digest) plus the execution FACT; it carries no evidence body, no
 * operational state and no claim about the effect of the action.
 */
import type { PoolClient } from 'pg';
import { OutboxRepository } from '@infinicus/database';
import type { ExecutionRecord, TenantContext } from '@infinicus/database';
import { ACTION_EXECUTED_CONSUMER, EVIDENCE_CONTRACT_REFERENCE, buildActionExecutedEvent } from './eventContract.js';
import type { ActionExecutedPayload } from './eventContract.js';

export interface ExecutionEventPublisher {
  /** Must write on `client` (the execution transaction). A thrown error rolls the execution back: no silent loss, no phantom event. */
  publish(client: PoolClient, ctx: TenantContext, execution: ExecutionRecord): Promise<{ inserted: boolean }>;
}

/** The reference payload for one terminal execution. Every value is copied from the execution fact. */
export function actionExecutedPayloadFor(e: ExecutionRecord): ActionExecutedPayload {
  return {
    executionId: e.id,
    contractVersion: EVIDENCE_CONTRACT_REFERENCE,
    evidenceDigest: e.evidenceDigest,
    scope: { tenantId: e.tenantId, workspaceId: e.workspaceId, businessId: e.businessId },
    actionType: { code: e.actionType.code, schemaVersion: e.actionType.schemaVersion },
    target: { kind: e.target.kind, id: e.target.id },
    packageId: e.packageId,
    packageVersion: e.packageVersion,
    claimId: e.claimId,
    outcome: e.outcome,
    mutationResult: e.mutationResult,
    recordedAt: e.recordedAt,
  };
}

export class OutboxExecutionEventPublisher implements ExecutionEventPublisher {
  constructor(private readonly outbox: Pick<OutboxRepository, 'enqueueIfAbsentOnClient'> = new OutboxRepository()) {}

  async publish(client: PoolClient, ctx: TenantContext, execution: ExecutionRecord): Promise<{ inserted: boolean }> {
    const event = buildActionExecutedEvent({ payload: actionExecutedPayloadFor(execution), correlationId: execution.correlationId, causationId: execution.claimId, recordedAt: execution.recordedAt });
    const r = await this.outbox.enqueueIfAbsentOnClient(client, ctx, { event, headers: { consumers: [ACTION_EXECUTED_CONSUMER] } });
    return { inserted: r.inserted };
  }
}
