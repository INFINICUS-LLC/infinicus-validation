/**
 * Business Operations consumer of `control_loop.action.authorized@1` (P0-6b; planning decision 2).
 *
 * Turns a reference-only notification into the EXISTING intake: pull the sealed package through the ABA-owned source port, check it is
 * exactly the package the event names, hand it to {@link AuthorizedActionIntakeService} (which validates, asks the authoritative status
 * provider, writes the receipt and takes the single-use claim), then ask ABA to mirror the claim as CONSUMED (BO's claim stays canonical).
 * It claims nothing itself (intake does), changes no inventory itself (the execution engine does, when handed the claim), reads no ABA table and trusts nothing in the event beyond the
 * reference: the document, scope, digest, authority and status are all re-established from the pulled package and the provider.
 *
 * Delivery is at-least-once, so it is idempotent through the inbox (`event_id` + consumer name) and through intake's own replay.
 * Gated by the same execution capability gate as the producer: a closed gate fails the delivery NON-retryably (dead letter; a replay needs
 * governed approval) and creates no receipt, claim or inbox row. Business refusals are final outcomes (the intake attempt is the record);
 * only "could not find out yet" conditions are retried.
 */
import { DeliveryError, InboxRepository } from '@infinicus/database';
import type { EventConsumer, StoredBusinessEvent, TenantContext } from '@infinicus/database';
import { ACTION_AUTHORIZED_CONSUMER, isActionAuthorizedPayload } from '@infinicus/event-contracts';
import type { ActionAuthorizedPayload } from '@infinicus/event-contracts';
import type { ExecutionCapabilityGate, AuthorizedActionPackageSource, PackageConsumptionRecorder } from '@infinicus/handoff-contracts';
import { PackageIntakeRefusedError } from './AuthorizedActionIntakeService.js';
import type { AuthorizedActionIntakeService } from './AuthorizedActionIntakeService.js';
import type { AuthorizedActionExecutionService } from '../authorized-action-execution/AuthorizedActionExecutionService.js';

/** Refusals that mean "the answer was not obtainable or fresh yet", not "this package is not acceptable". Everything else is final. */
export const TRANSIENT_INTAKE_REFUSALS: readonly string[] = Object.freeze([
  'STATUS_UNAVAILABLE', 'STATUS_UNVERIFIED', 'AUTHORITY_UNVERIFIABLE', 'EXECUTION_WINDOW_NOT_OPEN',
]);

export interface AuthorizedActionNotificationConsumerDependencies {
  intake: Pick<AuthorizedActionIntakeService, 'intake'>;
  source: AuthorizedActionPackageSource;
  recorder: PackageConsumptionRecorder;
  /**
   * The ONE canonical trigger of execution (P0-6e): once BO holds the single-use claim, this consumer hands the claim id to the engine and does
   * nothing else. Required: a consumer without an executor would claim and strand. The consumer never mutates inventory itself.
   */
  executor: Pick<AuthorizedActionExecutionService, 'executeClaim'>;
  /** Required: there is no default, and the platform's only implementation until P0-6e denies everything. */
  gate: ExecutionCapabilityGate;
  inbox?: Pick<InboxRepository, 'beginProcessing' | 'markProcessed' | 'markFailed'>;
}

const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

export class AuthorizedActionNotificationConsumer implements EventConsumer {
  /** The inbox consumer name and the subscription `destination_ref` this consumer is registered under. */
  static readonly NAME = ACTION_AUTHORIZED_CONSUMER;
  private readonly inbox: Pick<InboxRepository, 'beginProcessing' | 'markProcessed' | 'markFailed'>;

  constructor(private readonly deps: AuthorizedActionNotificationConsumerDependencies) {
    this.inbox = deps.inbox ?? new InboxRepository();
  }

  async handle(ctx: TenantContext, event: StoredBusinessEvent): Promise<void> {
    const payload = event.payload;
    if (!isActionAuthorizedPayload(payload)) throw new DeliveryError('PAYLOAD_INVALID', 'the notification is not a valid reference-only payload', false);
    const { scope } = payload;
    if (event.tenantId !== ctx.tenantId || event.workspaceId !== ctx.workspaceId || event.businessId !== scope.businessId
      || scope.tenantId !== ctx.tenantId || scope.workspaceId !== ctx.workspaceId) {
      throw new DeliveryError('SCOPE_MISMATCH', 'the notification scope does not match the delivery scope', false);
    }

    const open = await Promise.resolve().then(() => this.deps.gate.isEnabled(scope, payload.actionType)).then((v) => v === true, () => false); // a gate that cannot answer is closed
    if (!open) throw new DeliveryError('CAPABILITY_DISABLED', 'the authorized-action pipeline is not enabled for this business and action type', false);

    const begun = await this.inbox.beginProcessing(ctx, { eventId: event.eventId, consumerName: ACTION_AUTHORIZED_CONSUMER, eventType: event.eventType, payload });
    if (begun.state === 'already_processed') return;
    if (begun.state === 'already_processing') throw new DeliveryError('IN_PROGRESS', 'this notification is being processed by another delivery', true);

    try {
      await this.process(ctx, event, payload);
      await this.inbox.markProcessed(ctx, event.eventId, ACTION_AUTHORIZED_CONSUMER);
    } catch (error) {
      await this.inbox.markFailed(ctx, event.eventId, ACTION_AUTHORIZED_CONSUMER, error instanceof Error ? error.message : 'failed').catch(() => undefined);
      throw error;
    }
  }

  private async process(ctx: TenantContext, event: StoredBusinessEvent, payload: ActionAuthorizedPayload): Promise<void> {
    const { scope } = payload;
    const pulled = await this.deps.source.get({ packageId: payload.packageId, packageVersion: payload.packageVersion, scope });
    if (!pulled) throw new DeliveryError('PACKAGE_UNAVAILABLE', 'the sealed package could not be pulled from Approved Business Action', true);

    const doc = pulled.document;
    const identity = isRec(doc) && isRec(doc.identity) ? doc.identity : {};
    const integrity = isRec(doc) && isRec(doc.integrity) ? doc.integrity : {};
    if (identity.packageId !== payload.packageId || identity.packageVersion !== payload.packageVersion
      || integrity.digest !== payload.digest || pulled.digest !== payload.digest) {
      throw new DeliveryError('PACKAGE_MISMATCH', 'the pulled package is not the package the notification names', false);
    }

    let result;
    try {
      result = await this.deps.intake.intake({ ...ctx, businessId: scope.businessId }, { package: doc, correlationId: event.correlationId });
    } catch (error) {
      if (error instanceof PackageIntakeRefusedError) {
        const transient = error.codes.length > 0 && error.codes.every((c) => TRANSIENT_INTAKE_REFUSALS.includes(c));
        if (transient) throw new DeliveryError(error.codes[0], `intake could not decide yet (${error.codes.join(', ')})`, true);
        return; // a final business refusal: the intake attempt row is the record; the notification is handled
      }
      throw error;
    }

    // BO's claim is canonical. The ABA mirror is best-effort-but-retried: an unrecordable mirror is not a delivery failure.
    await this.deps.recorder.recordConsumed({
      packageId: payload.packageId, packageVersion: payload.packageVersion, digest: payload.digest, scope, receiptId: result.receiptId,
    });

    // The claim is held: hand it to the engine (the only executor). A terminal result - including a replay of one - ends the delivery; the
    // engine re-checks the gate, the registry, the package, and the CURRENT authority under the target lock, so none of that is trusted here.
    // "Not decidable yet" is retried through the outbox's own redelivery (the subscription carries the ruled 3 x 1s/5s/15s policy); the
    // engine bounds the attempts and writes the terminal FAILED itself on the last one.
    const executed = await this.deps.executor.executeClaim({ ...ctx, businessId: scope.businessId } as TenantContext, result.claimId);
    if (executed.state === 'RETRY') {
      throw new DeliveryError(executed.reasonCode, `execution attempt ${executed.attemptNumber} could not decide yet (${executed.reasonCode})`, true);
    }
  }
}
