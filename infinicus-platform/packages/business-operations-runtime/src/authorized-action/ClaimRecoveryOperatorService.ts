/**
 * Interim OPERATOR control for stranded claims (P0-6h; owner ruling: Alternative A, approved only as an interim manual control beside the
 * automatic recovery signal of P0-6g).
 *
 * It is the existing scoped recovery primitive, `AuthorizedActionExecutionService.runDue`, behind a governed request - nothing else:
 *   - ONE business and ONE action type per request (server-authoritative scope from the authenticated context; no cross-tenant listing);
 *   - the EXISTING `bo:admin` permission, passed by the caller and refused if it is anything else (as activation does);
 *   - refused while the governed gate is closed (a closed gate must never terminalize a held claim; the engine would record it REFUSED);
 *   - bounded (1..25 claims per request) and the SAME rules as the worker path: the 60 s / backoff due rule, a fresh ABA status and authority
 *     check under the target lock, the gate, and a terminal claim is never re-driven; it adds no retry policy and cannot create a claim;
 *   - audited as a USER action twice (requested BEFORE anything runs, completed with the per-claim results), alongside the engine's own rows.
 */
import { AuthorizedActionExecutionRepository } from '@infinicus/database';
import type { TenantContext } from '@infinicus/database';
import type { ActionCapabilityRegistry, ExecutionCapabilityGate } from '@infinicus/handoff-contracts';
import { PRODUCTION_BO_CAPABILITIES } from './boActionCapabilities.js';
import { EXECUTION_ACTIVATION_PERMISSION } from '../execution-activation/ExecutionActivationService.js';
import type { AuthorizedActionExecutionService } from '../authorized-action-execution/AuthorizedActionExecutionService.js';

/** The recovery operator is governed by the same existing permission as activation. No permission was invented. */
export const CLAIM_RECOVERY_OPERATOR_PERMISSION = EXECUTION_ACTIVATION_PERMISSION;
export const CLAIM_RECOVERY_OPERATOR_AUDIT_ACTIONS = Object.freeze({ requested: 'bo.claim_recovery.requested', completed: 'bo.claim_recovery.completed' });
export const CLAIM_RECOVERY_DEFAULT_LIMIT = 10;
export const CLAIM_RECOVERY_MAX_LIMIT = 25;

export class ClaimRecoveryOperatorError extends Error {
  constructor(readonly code: 'PERMISSION_INVALID' | 'REASON_REQUIRED' | 'INVALID_REQUEST' | 'ACTION_TYPE_UNSUPPORTED' | 'GATE_CLOSED', message: string) {
    super(message);
    this.name = 'ClaimRecoveryOperatorError';
  }
}

export interface ClaimRecoveryOperatorRequest {
  businessId: string;
  actionType: { code: string; schemaVersion: string };
  reason: string;
  limit?: number;
  correlationId: string;
}

export interface ClaimRecoveryOperatorResultRow {
  claimId: string;
  state: 'TERMINAL' | 'RETRY';
  /** TERMINAL only. */
  outcome?: string;
  reasonCode?: string | null;
  executionId?: string;
  /** TERMINAL: the stored outcome was returned unchanged (nothing re-driven). */
  replayed?: boolean;
  /** RETRY only. */
  attemptNumber?: number;
}

export interface ClaimRecoveryOperatorDependencies {
  /** The ONE engine, built by the composition root for the acting user (the ABA status provider stays outside BO). */
  engineFor: (ctx: TenantContext) => Pick<AuthorizedActionExecutionService, 'runDue'>;
  /** The same governed gate the engine uses. Required: a gate that cannot answer is closed. */
  gateFor: (ctx: TenantContext) => ExecutionCapabilityGate;
  capabilities?: ActionCapabilityRegistry;
  repository?: Pick<AuthorizedActionExecutionRepository, 'recordOperatorAudit'>;
}

export class ClaimRecoveryOperatorService {
  private readonly capabilities: ActionCapabilityRegistry;
  private readonly repository: Pick<AuthorizedActionExecutionRepository, 'recordOperatorAudit'>;

  constructor(private readonly deps: ClaimRecoveryOperatorDependencies) {
    this.capabilities = deps.capabilities ?? PRODUCTION_BO_CAPABILITIES;
    this.repository = deps.repository ?? new AuthorizedActionExecutionRepository();
  }

  async recover(ctx: TenantContext, permissionCode: string, request: ClaimRecoveryOperatorRequest): Promise<{ attempted: number; results: ClaimRecoveryOperatorResultRow[] }> {
    if (permissionCode !== CLAIM_RECOVERY_OPERATOR_PERMISSION) throw new ClaimRecoveryOperatorError('PERMISSION_INVALID', `claim recovery is governed by ${CLAIM_RECOVERY_OPERATOR_PERMISSION}`);
    const reason = typeof request.reason === 'string' ? request.reason.trim() : '';
    if (reason.length === 0 || reason.length > 500) throw new ClaimRecoveryOperatorError('REASON_REQUIRED', 'a reason of 1 to 500 characters is required');
    const { code, schemaVersion } = request.actionType ?? ({} as { code?: string; schemaVersion?: string });
    if (typeof code !== 'string' || typeof schemaVersion !== 'string' || code.length === 0 || schemaVersion.length === 0) throw new ClaimRecoveryOperatorError('INVALID_REQUEST', 'an action type and schema version are required');
    const limit = request.limit ?? CLAIM_RECOVERY_DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > CLAIM_RECOVERY_MAX_LIMIT) throw new ClaimRecoveryOperatorError('INVALID_REQUEST', `limit must be an integer from 1 to ${CLAIM_RECOVERY_MAX_LIMIT}`);
    if (!this.capabilities.supports(code, schemaVersion)) throw new ClaimRecoveryOperatorError('ACTION_TYPE_UNSUPPORTED', `${code}@${schemaVersion} is not executable by Business Operations`);

    const scope = { tenantId: ctx.tenantId, workspaceId: ctx.workspaceId, businessId: request.businessId };
    const open = await Promise.resolve().then(() => this.deps.gateFor(ctx).isEnabled(scope, { code, schemaVersion })).then((v) => v === true, () => false);
    if (!open) throw new ClaimRecoveryOperatorError('GATE_CLOSED', 'execution is not enabled for this business and action type; nothing was attempted (recovery never bypasses the gate)');

    const audit = { businessId: request.businessId, entityId: request.businessId, correlationId: request.correlationId };
    await this.repository.recordOperatorAudit(ctx, { ...audit, action: CLAIM_RECOVERY_OPERATOR_AUDIT_ACTIONS.requested, metadata: { actionType: `${code}@${schemaVersion}`, limit, reason } });

    const ran = await this.deps.engineFor(ctx).runDue(ctx, { limit, businessId: request.businessId, actionType: { code, schemaVersion } });
    const results: ClaimRecoveryOperatorResultRow[] = ran.map(({ claimId, result }) => result.state === 'TERMINAL'
      ? { claimId, state: 'TERMINAL', outcome: result.execution.outcome, reasonCode: result.execution.reasonCode, executionId: result.execution.id, replayed: result.replayed }
      : { claimId, state: 'RETRY', reasonCode: result.reasonCode, attemptNumber: result.attemptNumber });

    await this.repository.recordOperatorAudit(ctx, {
      ...audit, action: CLAIM_RECOVERY_OPERATOR_AUDIT_ACTIONS.completed,
      metadata: { actionType: `${code}@${schemaVersion}`, limit, reason, attempted: results.length, results: results.map((r) => ({ claimId: r.claimId, state: r.state, outcome: r.outcome ?? null, reasonCode: r.reasonCode ?? null })) },
    });
    return { attempted: results.length, results };
  }
}
