/**
 * Administration of the governed activation record (P0-6e, Block 6). Server-authoritative: tenant, workspace and actor come from the
 * authenticated context; `businessId` is a lookup key the database verifies belongs to that scope (the record's trigger refuses otherwise).
 *
 * Enabling or disabling needs the EXISTING permission `bo:admin` ("Administer business operations configuration"); the caller (the API route)
 * enforces it and passes it here as the recorded governing fact, and this service refuses any other value. ABA's approval permissions are never
 * activation permissions. Only an action type BO's registry supports can be activated - a type it cannot execute is never "enabled".
 *
 * Every state change is one transaction: the version-chained record, the audit row, and (on enable) the idempotent delivery subscriptions of
 * the pipeline for the workspace. Repeating the state a business is already in changes nothing. Enabling grants NO authorization: ABA
 * authorization, the BO claim, the fresh authority check and the execution boundaries are all still required.
 */
import { EventSubscriptionRepository, ExecutionCapabilityActivationRepository, withTenantTransaction } from '@infinicus/database';
import type { ActivationState, ExecutionCapabilityActivation, TenantContext } from '@infinicus/database';
import { executionPipelineSubscriptions } from '@infinicus/event-contracts';
import type { ActionCapabilityRegistry } from '@infinicus/handoff-contracts';
import { PRODUCTION_BO_CAPABILITIES } from '../authorized-action/boActionCapabilities.js';

/** The existing business-operations administration permission (tenancy.permissions, migration 0137). No permission was invented. */
export const EXECUTION_ACTIVATION_PERMISSION = 'bo:admin';
export const EXECUTION_ACTIVATION_AUDIT_ACTIONS = Object.freeze({ enabled: 'bo.execution_activation.enabled', disabled: 'bo.execution_activation.disabled' });

export class ExecutionActivationError extends Error {
  constructor(readonly code: 'PERMISSION_INVALID' | 'ACTION_TYPE_UNSUPPORTED' | 'REASON_REQUIRED' | 'BUSINESS_NOT_IN_SCOPE' | 'INVALID_REQUEST', message: string) {
    super(message);
    this.name = 'ExecutionActivationError';
  }
}

export interface SetActivationRequest {
  businessId: string;
  actionType: { code: string; schemaVersion: string };
  state: ActivationState;
  reason: string;
  correlationId: string;
}

export interface ExecutionActivationServiceDependencies {
  capabilities?: ActionCapabilityRegistry;
  activations?: ExecutionCapabilityActivationRepository;
  subscriptions?: Pick<EventSubscriptionRepository, 'ensureOnClient'>;
}

export class ExecutionActivationService {
  private readonly capabilities: ActionCapabilityRegistry;
  private readonly activations: ExecutionCapabilityActivationRepository;
  private readonly subscriptions: Pick<EventSubscriptionRepository, 'ensureOnClient'>;

  constructor(deps: ExecutionActivationServiceDependencies = {}) {
    this.capabilities = deps.capabilities ?? PRODUCTION_BO_CAPABILITIES;
    this.activations = deps.activations ?? new ExecutionCapabilityActivationRepository();
    this.subscriptions = deps.subscriptions ?? new EventSubscriptionRepository();
  }

  async setActivation(ctx: TenantContext, permissionCode: string, request: SetActivationRequest): Promise<{ activation: ExecutionCapabilityActivation; changed: boolean }> {
    if (permissionCode !== EXECUTION_ACTIVATION_PERMISSION) throw new ExecutionActivationError('PERMISSION_INVALID', `activation is governed by ${EXECUTION_ACTIVATION_PERMISSION}`);
    const reason = typeof request.reason === 'string' ? request.reason.trim() : '';
    if (reason.length === 0 || reason.length > 500) throw new ExecutionActivationError('REASON_REQUIRED', 'a reason of 1 to 500 characters is required');
    const { code, schemaVersion } = request.actionType ?? ({} as { code?: string; schemaVersion?: string });
    if (typeof code !== 'string' || typeof schemaVersion !== 'string' || code.length === 0 || schemaVersion.length === 0) throw new ExecutionActivationError('INVALID_REQUEST', 'an action type and schema version are required');
    if (request.state !== 'ENABLED' && request.state !== 'DISABLED') throw new ExecutionActivationError('INVALID_REQUEST', 'state must be ENABLED or DISABLED');
    // Disabling is always allowed (it only removes capability); enabling needs a type BO can actually execute.
    if (request.state === 'ENABLED' && !this.capabilities.supports(code, schemaVersion)) {
      throw new ExecutionActivationError('ACTION_TYPE_UNSUPPORTED', `${code}@${schemaVersion} is not executable by Business Operations, so it cannot be activated`);
    }

    return withTenantTransaction(ctx, async (client) => {
      let result;
      try {
        result = await this.activations.recordOnClient(client, ctx, {
          businessId: request.businessId, actionType: { code, schemaVersion }, state: request.state, permissionCode, reason, correlationId: request.correlationId,
        });
      } catch (error) {
        if (error instanceof Error && /does not belong to the stated tenant and workspace/.test(error.message)) throw new ExecutionActivationError('BUSINESS_NOT_IN_SCOPE', 'the business is not in this tenant and workspace');
        throw error;
      }
      if (request.state === 'ENABLED') {
        for (const spec of executionPipelineSubscriptions(ctx.workspaceId)) await this.subscriptions.ensureOnClient(client, ctx, spec);
      }
      if (result.changed) {
        await this.activations.recordAudit(client, ctx, {
          businessId: request.businessId, entityId: result.activation.id, correlationId: request.correlationId,
          action: request.state === 'ENABLED' ? EXECUTION_ACTIVATION_AUDIT_ACTIONS.enabled : EXECUTION_ACTIVATION_AUDIT_ACTIONS.disabled,
          metadata: { actionType: `${code}@${schemaVersion}`, version: result.activation.version, state: request.state, permission: permissionCode, reason },
        });
      }
      return result;
    });
  }

  async current(ctx: TenantContext, businessId: string, actionType: { code: string; schemaVersion: string }): Promise<ExecutionCapabilityActivation | null> {
    return this.activations.getCurrent(ctx, businessId, actionType);
  }
}
