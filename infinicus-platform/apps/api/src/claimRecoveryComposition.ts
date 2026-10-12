import { AbaPackageStatusProvider } from '@infinicus/workflow';
import {
  AuthorizedActionExecutionService, ClaimRecoveryOperatorService, GovernedExecutionGate, PRODUCTION_BO_CAPABILITIES, killSwitchEngagedFrom,
} from '@infinicus/business-operations-runtime';
import type { ClaimRecoveryOperatorDependencies } from '@infinicus/business-operations-runtime';
import type { ActionCapabilityRegistry, AuthoritativePackageStatusProvider } from '@infinicus/handoff-contracts';

/**
 * Composition root: the interim operator recovery control (P0-6h). The ONLY place in the API where the ABA status provider is joined to the
 * Business Operations execution engine - Business Operations never imports ABA, and the route imports neither.
 *
 * The control is the existing scoped `runDue` of the one engine behind a `bo:admin`, audited, gate-checked request. The engine is built per request
 * for the ACTING user (the identity recorded on every read), with the same governed gate (registry + activation record + kill switch + valid
 * subscriptions) the worker uses.
 */
/** Ruled maximum age of the authoritative status/authority answer at judgement (owner ruling O-2); the same value the worker is configured with. */
export const OPERATOR_RECOVERY_STATUS_MAX_AGE_MS = 5_000;

export interface ClaimRecoveryCompositionOptions {
  /** Defaults to BO's production registry (exactly inventory_reorder_policy_update@1). Tests may inject their own. */
  capabilities?: ActionCapabilityRegistry;
  /** Key 3 of the gate. Defaults to the process environment (absent = not engaged; anything unrecognised = engaged). */
  killSwitchEngaged?: () => boolean;
  /** Tests may script the ABA-owned status port; production leaves it unset (the real ABA provider is used). */
  statusProviderFor?: (actorUserId: string) => AuthoritativePackageStatusProvider;
  executionStatusMaxAgeMs?: number;
  /** Test seam: the engine's clock for the due rule (60 s / backoff). Production leaves it unset (real time). */
  clock?: () => Date;
}

export function buildClaimRecoveryOperator(options: ClaimRecoveryCompositionOptions = {}): ClaimRecoveryOperatorService {
  const capabilities = options.capabilities ?? PRODUCTION_BO_CAPABILITIES;
  const killSwitchEngaged = options.killSwitchEngaged ?? (() => killSwitchEngagedFrom(process.env));
  const gateFor: ClaimRecoveryOperatorDependencies['gateFor'] = (ctx) => new GovernedExecutionGate({ capabilities, killSwitchEngaged, actorUserId: ctx.userId });
  return new ClaimRecoveryOperatorService({
    capabilities,
    gateFor,
    engineFor: (ctx) => new AuthorizedActionExecutionService({
      statusProvider: options.statusProviderFor ? options.statusProviderFor(ctx.userId) : new AbaPackageStatusProvider({ actorUserId: ctx.userId }),
      executionStatusMaxAgeMs: options.executionStatusMaxAgeMs ?? OPERATOR_RECOVERY_STATUS_MAX_AGE_MS,
      gate: gateFor(ctx), capabilities, ...(options.clock ? { clock: options.clock } : {}),
    }),
  });
}
