import { ActionAuthorizedAnnouncer, AuthorizedActionPackageIssuer } from '@infinicus/workflow';
import { GovernedExecutionGate, PRODUCTION_BO_CAPABILITIES, killSwitchEngagedFrom } from '@infinicus/business-operations-runtime';
import type { ActionCapabilityRegistry } from '@infinicus/handoff-contracts';

/**
 * Composition root: the ABA announcement edge (P0-6f). The ONLY place the ABA issuer is joined to the Business Operations activation gate.
 *
 * ABA announces authorization only: the issuer seals the package and, inside the same transaction, the existing `ActionAuthorizedAnnouncer`
 * writes the reference-only `control_loop.action.authorized@1` notification to the existing outbox - or nothing, when the governed gate is
 * closed (the package then stays ISSUED and is announced by an identical issue request once the business is activated). Business Operations
 * still validates, claims and executes; ABA never calls it, reads its tables or mutates inventory. ABA depends on the gate as an interface
 * (a factory over the issuing context); the BO implementation is supplied here, and nowhere inside ABA.
 */
export interface AbaAnnouncementCompositionOptions {
  /** Defaults to BO's production registry (exactly inventory_reorder_policy_update@1). Tests may inject their own. */
  capabilities?: ActionCapabilityRegistry;
  /** Key 3 of the gate. Defaults to the process environment (absent = not engaged; anything unrecognised = engaged). */
  killSwitchEngaged?: () => boolean;
}

export function buildAbaPackageIssuer(options: AbaAnnouncementCompositionOptions = {}): AuthorizedActionPackageIssuer {
  const capabilities = options.capabilities ?? PRODUCTION_BO_CAPABILITIES;
  const killSwitchEngaged = options.killSwitchEngaged ?? (() => killSwitchEngagedFrom(process.env));
  const announcer = new ActionAuthorizedAnnouncer({
    // The issuing user is the identity recorded on the activation read; the answer still comes only from the activation record.
    gate: (ctx) => new GovernedExecutionGate({ capabilities, killSwitchEngaged, actorUserId: ctx.userId }),
  });
  return new AuthorizedActionPackageIssuer({ announcer });
}
