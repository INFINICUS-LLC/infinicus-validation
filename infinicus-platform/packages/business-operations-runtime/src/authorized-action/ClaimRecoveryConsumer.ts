/**
 * Business Operations consumer of `operations.authorized_action.recovery_due@1` (P0-6g; owner ruling: stranded-claim recovery, Alternative C).
 *
 * When a claim's recovery signal falls due, this consumer resolves the EXISTING claim in the delivery's own scope and, if it still has no
 * terminal execution, hands it to the one execution engine ({@link AuthorizedActionExecutionService.executeClaim}). It is a nudge and nothing
 * more:
 *   - it never creates a claim (it has no intake and no package source: the signal names a claim, it does not carry or fetch a package);
 *   - it never mutates inventory and never writes an execution row (the engine does, under its per-claim lock);
 *   - it never re-drives a terminal claim: a claim with a terminal FAILED/REFUSED/SUCCEEDED execution is left exactly as it is;
 *   - it adds no second retry policy: the engine bounds the attempts (3) and writes the terminal outcome on the last one; "not decidable yet"
 *     is retried only through the outbox's own redelivery, exactly like the original delivery;
 *   - it re-establishes nothing from the event: the engine re-checks the gate, the registry, BO's immutable package copy and the CURRENT
 *     authority under the target lock before any mutation, as it does for every attempt.
 *
 * Delivery is at-least-once, so it is idempotent through the inbox (`event_id` + consumer name) and through the engine's own replay.
 */
import { DeliveryError, AuthorizedActionExecutionRepository, InboxRepository } from '@infinicus/database';
import type { EventConsumer, StoredBusinessEvent, TenantContext } from '@infinicus/database';
import { AUTHORIZED_ACTION_RECOVERY_CONSUMER, isAuthorizedActionRecoveryPayload } from '@infinicus/event-contracts';
import type { ExecutionCapabilityGate } from '@infinicus/handoff-contracts';
import { ClaimNotFoundError } from '../authorized-action-execution/AuthorizedActionExecutionService.js';
import type { AuthorizedActionExecutionService } from '../authorized-action-execution/AuthorizedActionExecutionService.js';

export interface ClaimRecoveryConsumerDependencies {
  /** The ONE executor: the same engine the notification consumer uses. A consumer without it could not recover anything. */
  executor: Pick<AuthorizedActionExecutionService, 'executeClaim'>;
  /** Required: the same governed gate; a closed (or throwing) gate recovers nothing. */
  gate: ExecutionCapabilityGate;
  claims?: Pick<AuthorizedActionExecutionRepository, 'getClaimState'>;
  inbox?: Pick<InboxRepository, 'beginProcessing' | 'markProcessed' | 'markFailed'>;
}

export class ClaimRecoveryConsumer implements EventConsumer {
  /** The inbox consumer name and the subscription `destination_ref` this consumer is registered under. */
  static readonly NAME = AUTHORIZED_ACTION_RECOVERY_CONSUMER;
  private readonly claims: Pick<AuthorizedActionExecutionRepository, 'getClaimState'>;
  private readonly inbox: Pick<InboxRepository, 'beginProcessing' | 'markProcessed' | 'markFailed'>;

  constructor(private readonly deps: ClaimRecoveryConsumerDependencies) {
    this.claims = deps.claims ?? new AuthorizedActionExecutionRepository();
    this.inbox = deps.inbox ?? new InboxRepository();
  }

  async handle(ctx: TenantContext, event: StoredBusinessEvent): Promise<void> {
    const payload = event.payload;
    if (!isAuthorizedActionRecoveryPayload(payload)) throw new DeliveryError('PAYLOAD_INVALID', 'the recovery signal is not a valid reference-only payload', false);
    const { scope } = payload;
    if (event.tenantId !== ctx.tenantId || event.workspaceId !== ctx.workspaceId || event.businessId !== scope.businessId
      || scope.tenantId !== ctx.tenantId || scope.workspaceId !== ctx.workspaceId) {
      throw new DeliveryError('SCOPE_MISMATCH', 'the recovery signal scope does not match the delivery scope', false);
    }

    // The signal only ever points at a claim BO already holds. Resolve it in the delivery's own scope; nothing here can create one.
    const claim = await this.claims.getClaimState(ctx, payload.claimId);
    if (!claim) throw new DeliveryError('CLAIM_NOT_FOUND', 'the recovery signal names no claim in this scope', false);
    if (claim.tenantId !== scope.tenantId || claim.workspaceId !== scope.workspaceId || claim.businessId !== scope.businessId
      || claim.packageId !== payload.packageId || claim.packageVersion !== payload.packageVersion || claim.digest !== payload.digest) {
      throw new DeliveryError('CLAIM_MISMATCH', 'the recovery signal does not describe the claim it names', false);
    }
    // A terminal outcome is spent: nothing is re-driven, whatever the gate says now.
    if (claim.terminalOutcome !== null) return;

    const open = await Promise.resolve().then(() => this.deps.gate.isEnabled(scope, payload.actionType)).then((v) => v === true, () => false); // a gate that cannot answer is closed
    if (!open) throw new DeliveryError('CAPABILITY_DISABLED', 'the authorized-action pipeline is not enabled for this business and action type', false);

    const begun = await this.inbox.beginProcessing(ctx, { eventId: event.eventId, consumerName: AUTHORIZED_ACTION_RECOVERY_CONSUMER, eventType: event.eventType, payload });
    if (begun.state === 'already_processed') return;
    if (begun.state === 'already_processing') throw new DeliveryError('IN_PROGRESS', 'this recovery signal is being processed by another delivery', true);

    try {
      await this.drive(ctx, payload.claimId, scope.businessId);
      await this.inbox.markProcessed(ctx, event.eventId, AUTHORIZED_ACTION_RECOVERY_CONSUMER);
    } catch (error) {
      await this.inbox.markFailed(ctx, event.eventId, AUTHORIZED_ACTION_RECOVERY_CONSUMER, error instanceof Error ? error.message : 'failed').catch(() => undefined);
      throw error;
    }
  }

  private async drive(ctx: TenantContext, claimId: string, businessId: string): Promise<void> {
    let executed;
    try {
      executed = await this.deps.executor.executeClaim({ ...ctx, businessId } as TenantContext, claimId);
    } catch (error) {
      if (error instanceof ClaimNotFoundError) throw new DeliveryError('CLAIM_NOT_FOUND', error.message, false);
      throw error;
    }
    // A terminal result - including the replay of one that landed meanwhile - ends the delivery. "Not decidable yet" is retried through the
    // outbox's own redelivery (the subscription carries the ruled 3 x 1s/5s/15s policy); the engine writes the terminal outcome itself on
    // its last attempt, so this can never loop past the engine's own bound.
    if (executed.state === 'RETRY') {
      throw new DeliveryError(executed.reasonCode, `recovery attempt ${executed.attemptNumber} could not decide yet (${executed.reasonCode})`, true);
    }
  }
}
