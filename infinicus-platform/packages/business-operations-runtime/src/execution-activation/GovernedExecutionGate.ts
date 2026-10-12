/**
 * The governed execution gate (P0-6e): `ExecutionCapabilityGate` implemented as the THREE independent keys of planning decision 16.
 *
 *   1. build-time capability registry   - BO can execute this type at all
 *   2. governed activation record       - an administrator enabled this type for THIS business (database; no row = closed)
 *   3. global kill switch               - a process-level setting that can only REMOVE capability
 *
 * Open only when all three agree. Any doubt - a thrown error, a malformed scope, an unreadable record - is CLOSED. The gate answers only
 * "may this supported type execute for this business?": it is not authorization, not a claim, not a status check, and it never replaces the
 * fresh authority verification or the execution boundaries. It writes nothing.
 */
import { ExecutionCapabilityActivationRepository } from '@infinicus/database';
import type { TenantContext } from '@infinicus/database';
import type { ActionCapabilityRegistry, ExecutionCapabilityGate, PackageScope } from '@infinicus/handoff-contracts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface GovernedExecutionGateDependencies {
  /** BO's capability registry (key 1). Required: nothing defaults to "supported". */
  capabilities: ActionCapabilityRegistry;
  /** Key 3. Returns true when the global kill switch is engaged. Required: the composition root decides how it is read. */
  killSwitchEngaged: () => boolean;
  /** The system identity recorded in the tenant context of the read. Required: no default identity is invented. */
  actorUserId: string;
  activations?: Pick<ExecutionCapabilityActivationRepository, 'isEnabled'>;
}

export class GovernedExecutionGate implements ExecutionCapabilityGate {
  private readonly activations: Pick<ExecutionCapabilityActivationRepository, 'isEnabled'>;

  constructor(private readonly deps: GovernedExecutionGateDependencies) {
    if (typeof deps.actorUserId !== 'string' || !UUID.test(deps.actorUserId)) throw new Error('the gate needs a system actor user id (lowercase UUID)');
    this.activations = deps.activations ?? new ExecutionCapabilityActivationRepository();
  }

  async isEnabled(scope: PackageScope, actionType: { code: string; schemaVersion: string }): Promise<boolean> {
    try {
      if (this.deps.killSwitchEngaged() !== false) return false; // key 3: anything but an explicit "not engaged" is engaged
      if (!this.deps.capabilities.supports(actionType.code, actionType.schemaVersion)) return false; // key 1
      if (![scope?.tenantId, scope?.workspaceId, scope?.businessId].every((id) => typeof id === 'string' && UUID.test(id))) return false;
      const ctx: TenantContext = { tenantId: scope.tenantId, workspaceId: scope.workspaceId, userId: this.deps.actorUserId };
      return (await this.activations.isEnabled(ctx, scope.businessId, actionType)) === true; // key 2
    } catch {
      return false;
    }
  }
}
