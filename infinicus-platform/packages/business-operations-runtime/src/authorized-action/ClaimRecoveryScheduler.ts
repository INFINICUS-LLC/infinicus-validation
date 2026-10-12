/**
 * The durable recovery signal of a Business Operations claim (P0-6g; owner ruling: Alternative C).
 *
 * A claim that never reaches a terminal execution outcome is stranded (the delivery that should drive it can exhaust its budget, or its worker
 * can vanish). So the intake writes ONE internal signal, `operations.authorized_action.recovery_due@1`, in the SAME transaction that creates the
 * claim, through the existing BUILD-33 outbox, due `EXECUTION_CLAIM_RECOVERY_MS` (the ruled 60 s) after the claim. The existing event worker
 * then delivers it like any other event (it finds the scope from that outbox row), and {@link ClaimRecoveryConsumer} hands the EXISTING claim to
 * the one execution engine.
 *
 * The signal id is derived from the claim id, so a claim has exactly one signal (a second schedule is a no-op). This module writes nothing else:
 * no claim, no execution, no inventory, and it reads no Approved Business Action table.
 */
import type { PoolClient } from 'pg';
import { OutboxRepository } from '@infinicus/database';
import type { TenantContext } from '@infinicus/database';
import { AUTHORIZED_ACTION_RECOVERY_CONSUMER, buildAuthorizedActionRecoveryEvent } from '@infinicus/event-contracts';
import type { AuthorizedActionRecoveryPayload } from '@infinicus/event-contracts';
import { EXECUTION_CLAIM_RECOVERY_MS } from '../authorized-action-execution/constants.js';

export interface ClaimRecoveryRequest {
  claimId: string;
  claimedAt: string;
  packageId: string;
  packageVersion: number;
  digest: string;
  scope: { tenantId: string; workspaceId: string; businessId: string };
  actionType: { code: string; schemaVersion: string };
  correlationId: string;
}

export interface ClaimRecoveryScheduler {
  /** Must write on `client` (the claim transaction). A thrown error rolls the claim back: no claim without its recovery signal. */
  schedule(client: PoolClient, ctx: TenantContext, request: ClaimRecoveryRequest): Promise<{ inserted: boolean }>;
}

/** The due time of a claim's signal: the claim time plus the recovery threshold, in millisecond UTC. */
export function recoveryDueAt(claimedAt: string, recoveryMs: number): string {
  return new Date(Date.parse(claimedAt) + recoveryMs).toISOString();
}

export function recoveryPayloadFor(request: ClaimRecoveryRequest, recoveryMs: number): AuthorizedActionRecoveryPayload {
  return {
    claimId: request.claimId, packageId: request.packageId, packageVersion: request.packageVersion, digest: request.digest,
    scope: { ...request.scope }, actionType: { ...request.actionType }, claimedAt: request.claimedAt, dueAt: recoveryDueAt(request.claimedAt, recoveryMs),
  };
}

export class OutboxClaimRecoveryScheduler implements ClaimRecoveryScheduler {
  constructor(
    private readonly outbox: Pick<OutboxRepository, 'enqueueIfAbsentOnClient'> = new OutboxRepository(),
    private readonly recoveryMs: number = EXECUTION_CLAIM_RECOVERY_MS,
  ) {
    if (!Number.isFinite(recoveryMs) || recoveryMs < 0) throw new Error('recoveryMs must be a non-negative number');
  }

  async schedule(client: PoolClient, ctx: TenantContext, request: ClaimRecoveryRequest): Promise<{ inserted: boolean }> {
    const payload = recoveryPayloadFor(request, this.recoveryMs);
    const event = buildAuthorizedActionRecoveryEvent({ payload, correlationId: request.correlationId });
    const r = await this.outbox.enqueueIfAbsentOnClient(client, ctx, { event, availableAt: new Date(payload.dueAt), headers: { consumers: [AUTHORIZED_ACTION_RECOVERY_CONSUMER] } });
    return { inserted: r.inserted };
  }
}
