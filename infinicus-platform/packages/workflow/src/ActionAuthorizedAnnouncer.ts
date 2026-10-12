/**
 * ABA producer of `control_loop.action.authorized@1` (P0-6b; planning decision 2, ruling O-9).
 *
 * Announces that a package version was sealed, by writing ONE outbox row on the caller's shared tenant transaction (the issuance
 * transaction), so the package and its notification commit or roll back together. The payload is reference-only (id, version, digest,
 * scope, action type, level, expiry, decision, issue time): the package body never leaves ABA through the event; Business Operations pulls
 * the sealed document through the ABA-owned source port and validates it itself.
 *
 * Gated by the SAME execution capability gate the consumer uses, closed by default (a closed or throwing gate emits NOTHING, so packages
 * stay ISSUED and are announced later by an idempotent re-issue request once activation is on). The event id is deterministic per package
 * version, so announcing twice is a no-op, never a duplicate notification. This class emits an announcement only: it grants, claims and
 * executes nothing, and it never reaches Business Operations.
 */
import { OutboxRepository } from '@infinicus/database';
import type { TenantContext } from '@infinicus/database';
import { ACTION_AUTHORIZED_CONSUMER, buildActionAuthorizedEvent } from '@infinicus/event-contracts';
import type { ActionAuthorizedPayload } from '@infinicus/event-contracts';
import { DENY_ALL_EXECUTION_GATE } from '@infinicus/handoff-contracts';
import type { AuthorizedActionPackageV1, ExecutionCapabilityGate } from '@infinicus/handoff-contracts';

export type AnnouncementOutcome = 'ANNOUNCED' | 'ALREADY_ANNOUNCED' | 'GATE_CLOSED';

export interface PackageAnnouncementTrace {
  correlationId: string;
  /** The approval audit event that led to the package (the package's own causation). */
  causationId: string | null;
}

/** What the issuer needs from a producer: announce a sealed package inside the issuance transaction. */
export interface PackageAnnouncer {
  announce(ctx: TenantContext, pkg: AuthorizedActionPackageV1, trace: PackageAnnouncementTrace): Promise<AnnouncementOutcome>;
}

/** A gate chosen per announcement from the issuing tenant context (the composition root owns how). Fail closed: it must still answer per scope. */
export type ExecutionCapabilityGateFactory = (ctx: TenantContext) => ExecutionCapabilityGate;

export interface ActionAuthorizedAnnouncerDependencies {
  /** The activation control, or a factory building it from the issuing context. Never inferred: an absent gate is DENY_ALL. */
  gate: ExecutionCapabilityGate | ExecutionCapabilityGateFactory;
  outbox: Pick<OutboxRepository, 'enqueueIfAbsent'>;
  clock: () => Date;
}

/** The reference-only payload for a sealed package. Every value is copied from the sealed document; nothing is computed or defaulted. */
export function actionAuthorizedPayloadFor(pkg: AuthorizedActionPackageV1): ActionAuthorizedPayload {
  const expiry = pkg.validity.expiresAt;
  return {
    packageId: pkg.identity.packageId,
    packageVersion: pkg.identity.packageVersion,
    digest: pkg.integrity.digest,
    scope: { tenantId: pkg.scope.tenantId, workspaceId: pkg.scope.workspaceId, businessId: pkg.scope.businessId },
    actionType: { code: pkg.action.type.code, schemaVersion: pkg.action.type.schemaVersion },
    automationLevel: pkg.action.automationLevel.level,
    expiresAt: expiry.state === 'VALUE' ? expiry.value : null,
    decisionId: pkg.lineage.decision.decisionId,
    issuedAt: pkg.issuance.issuedAt,
  };
}

export class ActionAuthorizedAnnouncer implements PackageAnnouncer {
  private readonly d: ActionAuthorizedAnnouncerDependencies;

  constructor(deps: Partial<ActionAuthorizedAnnouncerDependencies> = {}) {
    this.d = {
      gate: deps.gate ?? DENY_ALL_EXECUTION_GATE,
      outbox: deps.outbox ?? new OutboxRepository(),
      clock: deps.clock ?? (() => new Date()),
    };
  }

  async announce(ctx: TenantContext, pkg: AuthorizedActionPackageV1, trace: PackageAnnouncementTrace): Promise<AnnouncementOutcome> {
    const payload = actionAuthorizedPayloadFor(pkg);
    const open = await Promise.resolve()
      .then(() => (typeof this.d.gate === 'function' ? this.d.gate(ctx) : this.d.gate).isEnabled(payload.scope, payload.actionType))
      .then((v) => v === true, () => false); // a gate (or gate factory) that cannot answer is closed
    if (!open) return 'GATE_CLOSED';

    const now = this.d.clock();
    const event = buildActionAuthorizedEvent({ payload, correlationId: trace.correlationId, causationId: trace.causationId, recordedAt: now.toISOString() });
    // Business Operations refuses a claim before the execution window opens, so the notification becomes dispatchable when it opens.
    const window = pkg.action.executionWindow;
    const opensAt = window.state === 'VALUE' ? new Date(window.value.startsAt) : null;
    const availableAt = opensAt !== null && opensAt.getTime() > now.getTime() ? opensAt : now;
    const result = await this.d.outbox.enqueueIfAbsent(ctx, { event, availableAt, headers: { consumers: [ACTION_AUTHORIZED_CONSUMER] } });
    return result.inserted ? 'ANNOUNCED' : 'ALREADY_ANNOUNCED';
  }
}
