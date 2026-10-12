/**
 * Outcome Monitoring consumer of `operations.action.executed@1` (P0-6d, Block 4).
 *
 * Turns the reference-only notification into an OM verification record through {@link ExecutionVerificationService}. Delivery is
 * at-least-once, so it is idempotent through the inbox (`event_id` + consumer name) and through the verification table's own
 * (business, execution) uniqueness. Rejections are final (dead letter) except "evidence not obtainable yet", which is retried.
 * It changes no Business Operations data, emits nothing, and decides no outcome beyond PENDING / INCONCLUSIVE.
 */
import { DeliveryError, InboxRepository } from '@infinicus/database';
import type { EventConsumer, StoredBusinessEvent, TenantContext } from '@infinicus/database';
import { ACTION_EXECUTED_CONSUMER, isActionExecutedPayload } from '@infinicus/event-contracts';
import { ExecutionVerificationRejectedError } from './ExecutionVerificationService.js';
import type { ExecutionVerificationService } from './ExecutionVerificationService.js';

export interface ActionExecutedConsumerDependencies {
  verification: Pick<ExecutionVerificationService, 'verify'>;
  inbox?: Pick<InboxRepository, 'beginProcessing' | 'markProcessed' | 'markFailed'>;
}

export class ActionExecutedConsumer implements EventConsumer {
  /** The inbox consumer name and the subscription `destination_ref` this consumer is registered under. */
  static readonly NAME = ACTION_EXECUTED_CONSUMER;
  private readonly inbox: Pick<InboxRepository, 'beginProcessing' | 'markProcessed' | 'markFailed'>;

  constructor(private readonly deps: ActionExecutedConsumerDependencies) {
    this.inbox = deps.inbox ?? new InboxRepository();
  }

  async handle(ctx: TenantContext, event: StoredBusinessEvent): Promise<void> {
    const payload = event.payload;
    if (!isActionExecutedPayload(payload)) throw new DeliveryError('PAYLOAD_INVALID', 'the notification is not a valid reference-only payload', false);
    const { scope } = payload;
    if (event.tenantId !== ctx.tenantId || event.workspaceId !== ctx.workspaceId || event.businessId !== scope.businessId
      || scope.tenantId !== ctx.tenantId || scope.workspaceId !== ctx.workspaceId) {
      throw new DeliveryError('SCOPE_MISMATCH', 'the notification scope does not match the delivery scope', false);
    }

    const begun = await this.inbox.beginProcessing(ctx, { eventId: event.eventId, consumerName: ACTION_EXECUTED_CONSUMER, eventType: event.eventType, payload });
    if (begun.state === 'already_processed') return;
    if (begun.state === 'already_processing') throw new DeliveryError('IN_PROGRESS', 'this notification is being processed by another delivery', true);

    try {
      await this.deps.verification.verify(ctx, { payload, sourceEventId: event.eventId, correlationId: event.correlationId, causationId: event.causationId ?? null });
      await this.inbox.markProcessed(ctx, event.eventId, ACTION_EXECUTED_CONSUMER);
    } catch (error) {
      await this.inbox.markFailed(ctx, event.eventId, ACTION_EXECUTED_CONSUMER, error instanceof Error ? error.message : 'failed').catch(() => undefined);
      if (error instanceof ExecutionVerificationRejectedError) throw new DeliveryError(error.code, error.message, error.retryable);
      throw error;
    }
  }
}
