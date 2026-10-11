/**
 * ABA authoring / administration service (P0-5 ABA authoring block).
 *
 * The governed production path that makes a Level 2 AuthorizedActionPackage ISSUABLE: action-type registration, Level 2 policy,
 * structured capture, accountable owner, execution boundaries, and the call to the one issuer. It executes nothing: no Business
 * Operations code, no inventory change, no ACTION_AUTHORIZED, no ExecutionEvidence, no ABA->BO transport.
 *
 * Authority comes ONLY from the authenticated server-side context (`ctx`) and the route's permission, passed as `rc`. Business and action
 * ids are lookup keys that are verified against that context; nothing the caller sends is trusted as authority. Specifically:
 *  - an action-type registration is derived from the CANONICAL shared contract; the caller names only code + schemaVersion;
 *  - a policy is Level 2 only; Level 3 is recognized but NOT_ENABLED, Level 4 is future / NOT_ENABLED;
 *  - the capture's decision, decision version and decision status come from the stored action; the modification author is the verified
 *    decision approver, its time and every evaluation time are the database clock; the final parameters are derived here AND re-derived and
 *    verified by the database - a caller cannot supply them;
 *  - capture and boundaries are authored by the decision's own still-active approver (existing approval-authority verification);
 *  - NOT_APPLICABLE is accepted only with an UPPER_SNAKE reason code and only where the canonical contract allows it (fail closed).
 * Every mutation and its audit row (`audit.audit_events`: actor, permission used, scope, target, time, correlation, reason) commit or roll
 * back together in one shared tenant transaction. An exact replay returns the stored result and writes no second audit row.
 */

import { randomUUID } from 'node:crypto';
import { SimulationRunRepositoryReferenceVerifier, type SimulationRunReferenceVerifier } from './SimulationRunReferenceVerifier.js';
import {
  ActionTypeRegistryRepository, ApprovalDecisionRepository, ApprovedActionRepository, ApproverAuthorityRepository, AuthorizedActionBoundaryRepository,
  AuthorizedActionCaptureRepository, AuthorizedActionPackageRepository, AutomationLevelPolicyRepository, BusinessRepository,
  AbaConflictError as ConflictError, GovernanceAuditRepository, AbaNotFoundError as NotFoundError, AbaValidationError as ValidationError, withSharedTenantTransaction,
} from '@infinicus/database';
import type {
  ActionTypeWithStatus, AuthorizedActionBoundaries, AuthorizedActionCapture, GovernedValue, OwnerAssignment, TenantContext,
} from '@infinicus/database';
import {
  SIMULATION_NOT_APPLICABLE_ALLOWED, actionTypeKey, canonicalActionTypeRegistry, canonicalize, checkParameterValue, requiredGovernanceDimensions,
} from '@infinicus/handoff-contracts';
import type { ActionTypeContract, ActionTypeRegistry, GovernanceDimension, GovernanceEvidenceVerifier, JsonValue } from '@infinicus/handoff-contracts';
import { ApproverAuthorityNotEstablishedError } from './DecisionWorkflowService.js';
import { AuthorizedActionPackageIssuer, type IssuePackageResult } from './AuthorizedActionPackageIssuer.js';
import { POLICY_ACTION_TYPES_KEY, notApplicableCodeProblems } from './packageIssuancePolicy.js';

const MS_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BOUNDARY_FIELDS = ['executionWindow', 'preconditions', 'budget', 'rollback', 'monitoring'] as const;

/** Audit-only request facts. `permissionUsed` is recorded, never trusted as authority (the route enforced it already). */
export interface AuthoringRequestContext {
  permissionUsed: string;
  /** The request correlation id (any string from the edge); normalised to a UUID for storage, original kept in the audit metadata. */
  correlationId: string;
}

export type ActionTypeStatusName = 'DRAFT' | 'ACTIVE' | 'RETIRED';
export interface ActionTypeView { id: string; code: string; schemaVersion: string; status: ActionTypeStatusName; targetKinds: string[]; created?: boolean }
export interface PolicyVersionView { versionNumber: number; policyVersionId: string; description: string; actionTypes: { code: string; schemaVersion: string }[]; enabled: boolean }
export interface PolicyView { policyId: string; policyCode: string; automationLevel: number; versions: PolicyVersionView[]; created?: boolean }
export interface EnablementView { automationLevels: number[]; effective: { policyCode: string; automationLevel: number; versionNumber: number; policyVersionId: string }[] }

export interface CaptureInput {
  actionType: { code: string; schemaVersion: string };
  target: { kind: string; id: string };
  /** The ADI-proposed parameter set. Its reference is derived from the action's own source recommendation, never from the caller. */
  proposedParameters: Record<string, JsonValue>;
  /** Required exactly when the decision is approved_with_modifications. */
  modification?: { reason: string; changes: { parameter: string; operation: 'SET' | 'ADD' | 'REMOVE'; before?: JsonValue; after?: JsonValue }[] };
  /** Evidence references for the governance dimensions the modification touches. Times and results are stamped by the server. */
  evaluationEvidence?: { dimension: GovernanceDimension; evidenceRef: { kind: string; id: string } }[];
}
export interface CaptureView { captureId: string; actionId: string; decisionStatus: string; actionType: { code: string; schemaVersion: string }; finalParameters: Record<string, JsonValue>; capturedAt: string; created: boolean }

export interface OwnerInput {
  ownerUserId: string;
  membershipId: string;
  roleCode: string;
  dueAt: GovernedValue<string>;
  escalationPolicy: GovernedValue<{ ref: string }>;
}
export interface OwnerView { assignmentId: string; assignmentVersion: number; ownerUserId: string; membershipId: string; roleCode: string; assignedAt: string; created: boolean }

export interface BoundariesInput {
  executionWindow: GovernedValue<{ startsAt: string; endsAt: string | null }>;
  preconditions: GovernedValue<{ code: string; operator: string; operand: JsonValue }[]>;
  budget: GovernedValue<{ amount: string; currency: string }>;
  rollback: GovernedValue<{ instructions: string }>;
  monitoring: GovernedValue<{ metrics: { metricCode: string; target: JsonValue | null; unit: string | null }[] }>;
  simulationRun: GovernedValue<string>;
}
export interface BoundariesView { boundariesId: string; boundaryVersion: number; authoredAt: string; created: boolean }

export interface IssuedPackageView {
  outcome: 'ISSUED' | 'REPLAYED';
  packageId: string;
  packageVersion: number;
  status: 'ISSUED';
  digest: string;
  issuedAt: string;
  expiresAt: string | null;
  automationLevel: number;
  actionType: { code: string; schemaVersion: string };
  supersedes: { packageId: string; packageVersion: number } | null;
}

export interface AuthoringStatusView {
  actionId: string;
  decision: { id: string; status: string };
  actionType: { code: string; schemaVersion: string; status: ActionTypeStatusName | 'NOT_REGISTERED' } | null;
  capture: { recorded: boolean; capturedAt: string | null };
  owner: { assigned: boolean; assignmentVersion: number | null };
  boundaries: { authored: boolean; boundaryVersion: number | null };
  level2Policy: { enabled: boolean; policyCode: string | null; versionNumber: number | null };
  latestPackage: { packageId: string; packageVersion: number; lifecycle: string; digest: string; expiresAt: string | null } | null;
  /** Authoring steps still missing before an issuance attempt can succeed. Informational: the issuer alone decides. */
  missing: ('CAPTURE' | 'ACTION_TYPE_ACTIVE' | 'OWNER' | 'BOUNDARIES' | 'LEVEL2_POLICY')[];
}

export interface AbaAuthoringDependencies {
  businesses: BusinessRepository;
  approvedActions: ApprovedActionRepository;
  decisions: ApprovalDecisionRepository;
  approverAuthority: ApproverAuthorityRepository;
  captures: AuthorizedActionCaptureRepository;
  boundaries: AuthorizedActionBoundaryRepository;
  actionTypes: ActionTypeRegistryRepository;
  policies: AutomationLevelPolicyRepository;
  packages: AuthorizedActionPackageRepository;
  audit: GovernanceAuditRepository;
  issuer: AuthorizedActionPackageIssuer;
  /** The canonical platform vocabulary (shared-contract truth). */
  canonicalTypes: ActionTypeRegistry;
  /** Proves a simulation-run reference exists, is in scope and completed. */
  simulationRuns: SimulationRunReferenceVerifier;
  /**
   * The authoritative governance-evidence verifier (shared contract). NONE is registered in production today: with no verifier a
   * modified approval cannot be captured (fail closed). A caller's evidence reference is never proof.
   */
  evidenceVerifier: GovernanceEvidenceVerifier | null;
}

const defaults = (): AbaAuthoringDependencies => ({
  businesses: new BusinessRepository(), approvedActions: new ApprovedActionRepository(), decisions: new ApprovalDecisionRepository(),
  approverAuthority: new ApproverAuthorityRepository(), captures: new AuthorizedActionCaptureRepository(), boundaries: new AuthorizedActionBoundaryRepository(),
  actionTypes: new ActionTypeRegistryRepository(), policies: new AutomationLevelPolicyRepository(), packages: new AuthorizedActionPackageRepository(),
  audit: new GovernanceAuditRepository(), issuer: new AuthorizedActionPackageIssuer(), canonicalTypes: canonicalActionTypeRegistry(),
  simulationRuns: new SimulationRunRepositoryReferenceVerifier(), evidenceVerifier: null,
});

const invalid = (message: string): ValidationError => new ValidationError('AbaAuthoring', [message]);

/** Applies the structured delta to the original set exactly as the database does (SET/ADD/REMOVE, exact `before`). */
export function deriveFinalParameters(
  proposed: Record<string, JsonValue>,
  changes: readonly { parameter: string; operation: 'SET' | 'ADD' | 'REMOVE'; before?: JsonValue; after?: JsonValue }[],
): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = { ...proposed };
  const seen = new Set<string>();
  for (const ch of changes) {
    if (seen.has(ch.parameter)) throw invalid(`parameter ${ch.parameter} is changed more than once`);
    seen.add(ch.parameter);
    const had = Object.prototype.hasOwnProperty.call(proposed, ch.parameter);
    if (ch.operation === 'ADD') {
      if (had || ch.before !== undefined || ch.after === undefined) throw invalid(`ADD ${ch.parameter} needs an absent parameter and an after value only`);
      out[ch.parameter] = ch.after;
    } else if (ch.operation === 'REMOVE') {
      if (!had || ch.before === undefined || ch.after !== undefined || canonicalize(ch.before) !== canonicalize(proposed[ch.parameter])) throw invalid(`REMOVE ${ch.parameter} needs the original value as before and no after`);
      delete out[ch.parameter];
    } else {
      if (!had || ch.before === undefined || ch.after === undefined || canonicalize(ch.before) !== canonicalize(proposed[ch.parameter])) throw invalid(`SET ${ch.parameter} needs the original value as before and a new after`);
      if (canonicalize(ch.before) === canonicalize(ch.after)) throw invalid(`SET ${ch.parameter} must change the value`);
      out[ch.parameter] = ch.after;
    }
  }
  return out;
}

export class AbaAuthoringService {
  private readonly d: AbaAuthoringDependencies;

  constructor(deps: Partial<AbaAuthoringDependencies> = {}) {
    this.d = { ...defaults(), ...deps };
  }

  // ── shared helpers ──────────────────────────────────────────────────────────────────────────────────────────────────

  private normalise(rc: AuthoringRequestContext): { permissionUsed: string; correlationId: string; requestCorrelationId: string } {
    if (typeof rc.permissionUsed !== 'string' || rc.permissionUsed.length === 0) throw invalid('permissionUsed is required for the audit record');
    return { permissionUsed: rc.permissionUsed, correlationId: UUID.test(rc.correlationId) ? rc.correlationId : randomUUID(), requestCorrelationId: String(rc.correlationId).slice(0, 200) };
  }

  private async auditRow(ctx: TenantContext, rc: ReturnType<AbaAuthoringService['normalise']>, a: {
    action: string; entityType: string; entityId: string | null; businessId: string | null; reason?: string | null; detail?: Record<string, unknown>;
  }): Promise<void> {
    await this.d.audit.record(ctx, {
      action: a.action, entityType: a.entityType, entityId: a.entityId, businessId: a.businessId, correlationId: rc.correlationId,
      metadata: { permissionUsed: rc.permissionUsed, requestCorrelationId: rc.requestCorrelationId, reason: a.reason ?? null, ...(a.detail ?? {}) },
    });
  }

  /** The business must exist in the caller's workspace (RLS-confined lookup); anything else is indistinguishable from not found. */
  private async requireBusiness(ctx: TenantContext, businessId: string): Promise<void> {
    if (!UUID.test(businessId)) throw new NotFoundError('Business', businessId);
    await this.d.businesses.getById(ctx, businessId);
  }

  private async requireAction(ctx: TenantContext, businessId: string, actionId: string) {
    await this.requireBusiness(ctx, businessId);
    if (!UUID.test(actionId)) throw new NotFoundError('ApprovedAction', actionId);
    const action = await this.d.approvedActions.getById(ctx, actionId);
    if (action.businessId !== businessId) throw new NotFoundError('ApprovedAction', actionId);
    return action;
  }

  private canonicalOrRefuse(code: string, schemaVersion: string): ActionTypeContract {
    const canonical = this.d.canonicalTypes.resolve(code, schemaVersion);
    if (!canonical) throw invalid(`${code}@${schemaVersion} is not a canonical platform action type; a workspace cannot define its own meaning`);
    return canonical;
  }

  private static viewOf(t: ActionTypeWithStatus, created?: boolean): ActionTypeView {
    return { id: t.definition.id, code: t.definition.code, schemaVersion: t.definition.schemaVersion, status: t.status, targetKinds: t.definition.targetKinds, ...(created === undefined ? {} : { created }) };
  }

  // ── A. action-type governance (aba:admin) ───────────────────────────────────────────────────────────────────────────

  /** Registers the canonical definition for `code@schemaVersion` in this workspace (DRAFT). The caller supplies no definition. */
  async defineActionType(ctx: TenantContext, rc0: AuthoringRequestContext, input: { code: string; schemaVersion: string }): Promise<ActionTypeView> {
    const rc = this.normalise(rc0);
    const canonical = this.canonicalOrRefuse(input.code, input.schemaVersion);
    return withSharedTenantTransaction(ctx, async () => {
      const before = await this.d.actionTypes.get(ctx, input.code, input.schemaVersion);
      const definition = await this.d.actionTypes.define(ctx, {
        code: canonical.code, schemaVersion: canonical.schemaVersion, targetKinds: [...canonical.targetKinds],
        parameters: canonical.parameters as unknown as Record<string, unknown>,
        governanceImpact: Object.fromEntries(Object.entries(canonical.governanceImpact).map(([k, v]) => [k, [...v]])),
        applicability: { ...canonical.applicability } as Record<string, string>,
        definedByUserId: ctx.userId, correlationId: rc.correlationId,
      });
      const after = await this.d.actionTypes.getById(ctx, definition.id);
      if (!after) throw new NotFoundError('ActionType', definition.id);
      if (!before) {
        await this.auditRow(ctx, rc, { action: 'aba.action_type.defined', entityType: 'action_type_definition', entityId: definition.id, businessId: null, detail: { code: canonical.code, schemaVersion: canonical.schemaVersion } });
      }
      return AbaAuthoringService.viewOf(after, !before);
    });
  }

  private async changeActionType(ctx: TenantContext, rc0: AuthoringRequestContext, code: string, schemaVersion: string, target: 'ACTIVE' | 'RETIRED', reason?: string): Promise<ActionTypeView> {
    const rc = this.normalise(rc0);
    return withSharedTenantTransaction(ctx, async () => {
      const found = await this.d.actionTypes.get(ctx, code, schemaVersion);
      if (!found) throw new NotFoundError('ActionType', `${code}@${schemaVersion}`);
      const change = { actorUserId: ctx.userId, correlationId: rc.correlationId, ...(reason === undefined ? {} : { reason }) };
      const result = target === 'ACTIVE' ? await this.d.actionTypes.activate(ctx, found.definition.id, change) : await this.d.actionTypes.retire(ctx, found.definition.id, change);
      const changed = result.status !== found.status;
      if (changed) {
        await this.auditRow(ctx, rc, {
          action: target === 'ACTIVE' ? 'aba.action_type.activated' : 'aba.action_type.retired', entityType: 'action_type_definition', entityId: found.definition.id,
          businessId: null, reason: reason ?? null, detail: { code, schemaVersion, from: found.status, to: result.status },
        });
      }
      return AbaAuthoringService.viewOf(result, changed);
    });
  }

  activateActionType(ctx: TenantContext, rc: AuthoringRequestContext, code: string, schemaVersion: string): Promise<ActionTypeView> {
    return this.changeActionType(ctx, rc, code, schemaVersion, 'ACTIVE');
  }

  retireActionType(ctx: TenantContext, rc: AuthoringRequestContext, code: string, schemaVersion: string, reason: string): Promise<ActionTypeView> {
    if (typeof reason !== 'string' || reason.trim().length === 0) throw invalid('a reason is required to retire an action type');
    return this.changeActionType(ctx, rc, code, schemaVersion, 'RETIRED', reason.trim());
  }

  async listActionTypes(ctx: TenantContext): Promise<ActionTypeView[]> {
    return (await this.d.actionTypes.listAll(ctx)).map((t) => AbaAuthoringService.viewOf(t));
  }

  async getActionType(ctx: TenantContext, code: string, schemaVersion: string): Promise<ActionTypeView> {
    const found = await this.d.actionTypes.get(ctx, code, schemaVersion);
    if (!found) throw new NotFoundError('ActionType', `${code}@${schemaVersion}`);
    return AbaAuthoringService.viewOf(found);
  }

  // ── B. Level 2 policy (aba:admin) ───────────────────────────────────────────────────────────────────────────────────

  /** A policy specification is derived from canonical action types only: `{actionTypes: [{code, schemaVersion}]}`, sorted, no duplicates. */
  private specificationFor(actionTypes: readonly { code: string; schemaVersion: string }[]): Record<string, unknown> {
    if (!Array.isArray(actionTypes) || actionTypes.length === 0) throw invalid('at least one action type is required');
    const keys = new Set<string>();
    for (const t of actionTypes) {
      this.canonicalOrRefuse(t.code, t.schemaVersion);
      const key = actionTypeKey(t.code, t.schemaVersion);
      if (keys.has(key)) throw invalid(`duplicate action type ${key}`);
      keys.add(key);
    }
    const sorted = [...actionTypes].map((t) => ({ code: t.code, schemaVersion: t.schemaVersion })).sort((a, b) => actionTypeKey(a.code, a.schemaVersion).localeCompare(actionTypeKey(b.code, b.schemaVersion)));
    return { [POLICY_ACTION_TYPES_KEY]: sorted };
  }

  private static levelGate(level: number): void {
    if (level === 2) return;
    if (level === 3) throw invalid('automation Level 3 is recognized but NOT_ENABLED: it needs rule-authorization provenance that does not exist yet');
    if (level === 4) throw invalid('automation Level 4 is a future capability and is NOT_ENABLED');
    throw invalid('only automation Level 2 can be administered');
  }

  private async policyView(ctx: TenantContext, policyCode: string): Promise<PolicyView> {
    const policy = await this.d.policies.getPolicyByCode(ctx, policyCode);
    if (!policy) throw new NotFoundError('AutomationPolicy', policyCode);
    const versions = await this.d.policies.listVersions(ctx, policy.id);
    const enablement = await this.d.policies.getEnablement(ctx);
    const enabledIds = new Set(enablement.effective.map((e) => e.policyVersionId));
    return {
      policyId: policy.id, policyCode: policy.policyCode, automationLevel: policy.automationLevel,
      versions: versions.map((v) => ({
        versionNumber: v.versionNumber, policyVersionId: v.id, description: v.description, enabled: enabledIds.has(v.id),
        actionTypes: ((v.specification[POLICY_ACTION_TYPES_KEY] as { code: string; schemaVersion: string }[] | undefined) ?? []).map((t) => ({ code: t.code, schemaVersion: t.schemaVersion })),
      })),
    };
  }

  async createPolicy(ctx: TenantContext, rc0: AuthoringRequestContext, input: { policyCode: string; automationLevel: number; description: string; actionTypes: { code: string; schemaVersion: string }[] }): Promise<PolicyView> {
    const rc = this.normalise(rc0);
    AbaAuthoringService.levelGate(input.automationLevel);
    const specification = this.specificationFor(input.actionTypes);
    return withSharedTenantTransaction(ctx, async () => {
      const before = await this.d.policies.getPolicyByCode(ctx, input.policyCode);
      const { policy } = await this.d.policies.createPolicy(ctx, {
        policyCode: input.policyCode, automationLevel: 2, description: input.description, specification, createdByUserId: ctx.userId, correlationId: rc.correlationId,
      });
      if (!before) {
        await this.auditRow(ctx, rc, { action: 'aba.policy.created', entityType: 'automation_level_policy', entityId: policy.id, businessId: null, detail: { policyCode: input.policyCode, automationLevel: 2, specification } });
      }
      return { ...(await this.policyView(ctx, input.policyCode)), created: !before };
    });
  }

  async addPolicyVersion(ctx: TenantContext, rc0: AuthoringRequestContext, policyCode: string, input: { description: string; actionTypes: { code: string; schemaVersion: string }[] }): Promise<PolicyView> {
    const rc = this.normalise(rc0);
    const specification = this.specificationFor(input.actionTypes);
    return withSharedTenantTransaction(ctx, async () => {
      const policy = await this.d.policies.getPolicyByCode(ctx, policyCode);
      if (!policy) throw new NotFoundError('AutomationPolicy', policyCode);
      AbaAuthoringService.levelGate(policy.automationLevel);
      const before = (await this.d.policies.listVersions(ctx, policy.id)).length;
      const version = await this.d.policies.addVersion(ctx, policy.id, { description: input.description, specification, createdByUserId: ctx.userId, correlationId: rc.correlationId });
      const created = version.versionNumber > before;
      if (created) {
        await this.auditRow(ctx, rc, { action: 'aba.policy.version_added', entityType: 'automation_level_policy_version', entityId: version.id, businessId: null, detail: { policyCode, versionNumber: version.versionNumber, specification } });
      }
      return { ...(await this.policyView(ctx, policyCode)), created };
    });
  }

  private async changeEnablement(ctx: TenantContext, rc0: AuthoringRequestContext, policyCode: string, versionNumber: number, target: 'ENABLED' | 'DISABLED', reason: string): Promise<PolicyView> {
    const rc = this.normalise(rc0);
    if (typeof reason !== 'string' || reason.trim().length === 0) throw invalid('a reason is required');
    return withSharedTenantTransaction(ctx, async () => {
      const policy = await this.d.policies.getPolicyByCode(ctx, policyCode);
      if (!policy) throw new NotFoundError('AutomationPolicy', policyCode);
      // The route never enables Level 3 or 4, whatever is stored (the database refuses it too).
      AbaAuthoringService.levelGate(policy.automationLevel);
      const version = (await this.d.policies.listVersions(ctx, policy.id)).find((v) => v.versionNumber === versionNumber);
      if (!version) throw new NotFoundError('AutomationPolicyVersion', `${policyCode}@${versionNumber}`);
      if (target === 'ENABLED') {
        const latestNumber = Math.max(...(await this.d.policies.listVersions(ctx, policy.id)).map((v) => v.versionNumber));
        if (version.versionNumber !== latestNumber) throw new ConflictError('AutomationPolicyVersion', `only the latest version (${latestNumber}) of a policy can be enabled`);
      }
      const wasEnabled = (await this.d.policies.getEnablement(ctx)).effective.some((e) => e.policyVersionId === version.id);
      const change = { actorUserId: ctx.userId, reason: reason.trim(), correlationId: rc.correlationId };
      if (target === 'ENABLED') await this.d.policies.enable(ctx, version.id, change); else await this.d.policies.disable(ctx, version.id, change);
      if (wasEnabled !== (target === 'ENABLED')) {
        await this.auditRow(ctx, rc, {
          action: target === 'ENABLED' ? 'aba.policy.enabled' : 'aba.policy.disabled', entityType: 'automation_level_policy_version', entityId: version.id,
          businessId: null, reason: reason.trim(), detail: { policyCode, versionNumber, automationLevel: policy.automationLevel },
        });
      }
      return { ...(await this.policyView(ctx, policyCode)), created: wasEnabled !== (target === 'ENABLED') };
    });
  }

  enablePolicyVersion(ctx: TenantContext, rc: AuthoringRequestContext, policyCode: string, versionNumber: number, reason: string): Promise<PolicyView> {
    return this.changeEnablement(ctx, rc, policyCode, versionNumber, 'ENABLED', reason);
  }

  disablePolicyVersion(ctx: TenantContext, rc: AuthoringRequestContext, policyCode: string, versionNumber: number, reason: string): Promise<PolicyView> {
    return this.changeEnablement(ctx, rc, policyCode, versionNumber, 'DISABLED', reason);
  }

  getPolicy(ctx: TenantContext, policyCode: string): Promise<PolicyView> {
    return this.policyView(ctx, policyCode);
  }

  async getEnablement(ctx: TenantContext): Promise<EnablementView> {
    const e = await this.d.policies.getEnablement(ctx);
    return {
      automationLevels: [...e.automationLevels],
      effective: e.effective.map((p) => ({ policyCode: p.policyCode, automationLevel: p.automationLevel, versionNumber: p.versionNumber, policyVersionId: p.policyVersionId })),
    };
  }

  // ── C. structured capture (aba:write + decision approver) ───────────────────────────────────────────────────────────

  /** The caller must be the decision's own approver and that authority must still be active (existing approval-authority verification). */
  private async requireDecisionApprover(ctx: TenantContext, approverAssignmentId: string): Promise<void> {
    const assignment = await this.d.approverAuthority.getById(ctx, approverAssignmentId);
    if (assignment.userId !== ctx.userId || assignment.status !== 'active') {
      throw new ApproverAuthorityNotEstablishedError('only the decision\'s own approver, while that authority is active, can author the capture and boundaries');
    }
  }

  async recordCapture(ctx: TenantContext, rc0: AuthoringRequestContext, businessId: string, actionId: string, input: CaptureInput): Promise<CaptureView> {
    const rc = this.normalise(rc0);
    const action = await this.requireAction(ctx, businessId, actionId);
    const decision = await this.d.decisions.getById(ctx, action.decisionId);
    if (decision.status !== 'approved' && decision.status !== 'approved_with_modifications') {
      throw new ConflictError('AbaAuthoring', `the decision is "${decision.status}": capture can only follow an approved decision (approved without capture stays not issuable)`);
    }
    const decisionVersion = await this.d.decisions.getLatestVersion(ctx, decision.id);
    if (!decisionVersion) throw new ConflictError('AbaAuthoring', 'the decision has no version');
    await this.requireDecisionApprover(ctx, decision.approverAssignmentId);
    if (!action.sourceRecommendationId) throw new ConflictError('AbaAuthoring', 'the action has no source recommendation to reference as the original proposal');

    const canonical = this.canonicalOrRefuse(input.actionType.code, input.actionType.schemaVersion);
    if (!canonical.targetKinds.includes(input.target.kind)) throw invalid(`target kind ${input.target.kind} is not allowed for ${canonical.code}@${canonical.schemaVersion}`);
    const checkSet = (label: string, params: Record<string, JsonValue>): void => {
      for (const name of Object.keys(params)) {
        const spec = Object.prototype.hasOwnProperty.call(canonical.parameters, name) ? canonical.parameters[name] : undefined;
        if (!spec) throw invalid(`${label}: parameter ${name} is not declared by ${canonical.code}@${canonical.schemaVersion}`);
        const problems = checkParameterValue(spec, params[name]);
        if (problems.length > 0) throw invalid(`${label}: parameter ${name} ${problems.join('; ')}`);
      }
      for (const [name, spec] of Object.entries(canonical.parameters)) if (spec.required && !(name in params)) throw invalid(`${label}: required parameter ${name} is missing`);
    };
    checkSet('proposed', input.proposedParameters);

    const modified = decision.status === 'approved_with_modifications';
    if (modified && (!input.modification || input.modification.changes.length === 0)) throw invalid('an approved-with-modifications decision requires a structured modification delta and reason');
    if (!modified && input.modification) throw invalid('a plain approval carries no modification');
    const finalParameters = modified ? deriveFinalParameters(input.proposedParameters, input.modification!.changes) : { ...input.proposedParameters };
    checkSet('final', finalParameters);

    return withSharedTenantTransaction(ctx, async () => {
      const now = await this.d.audit.databaseNow(ctx);
      let modification: AuthorizedActionCapture['modification'];
      let evaluation: AuthorizedActionCapture['modificationEvaluation'];
      if (modified) {
        const changes = input.modification!.changes;
        modification = { state: 'VALUE', value: { reason: input.modification!.reason, modifiedByUserId: ctx.userId, modifiedAt: now, changes } };
        const required = requiredGovernanceDimensions(canonical, changes.map((c) => c.parameter));
        if (required.dimensions.length === 0) {
          evaluation = { state: 'NOT_APPLICABLE', reason: { code: 'NO_GOVERNANCE_IMPACT', statement: 'The modified parameters declare no governance impact.' } };
        } else {
          const given = new Map((input.evaluationEvidence ?? []).map((e) => [e.dimension, e.evidenceRef]));
          const missing = required.dimensions.filter((dim) => !given.has(dim));
          if (missing.length > 0) throw invalid(`evaluation evidence is required for: ${missing.join(', ')}`);
          // A reference is not proof. Every required dimension must be VERIFIED by the registered authoritative verifier, and the
          // verifier's answer (not the caller's reference alone) is what is persisted. No verifier registered = fail closed.
          const verifier = this.d.evidenceVerifier;
          if (!verifier) {
            throw new ConflictError('AbaAuthoring', `no authoritative governance evidence verifier is registered, so a modification touching ${required.dimensions.join(', ')} cannot be captured (an evidence reference alone is not proof)`);
          }
          const evidence: { dimension: GovernanceDimension; evaluatedAt: string; result: 'PASSED'; evidenceRef: { kind: string; id: string } }[] = [];
          for (const dimension of required.dimensions) {
            const ref = given.get(dimension)!;
            const verdict = await verifier.verify({
              tenantId: ctx.tenantId, workspaceId: ctx.workspaceId, businessId, dimension, evidenceRef: { kind: ref.kind, id: ref.id },
              subject: { actionId, actionType: { code: canonical.code, schemaVersion: canonical.schemaVersion }, target: { kind: input.target.kind, id: input.target.id }, finalParameters },
            });
            if (!verdict || verdict.status !== 'VERIFIED') {
              throw new ConflictError('AbaAuthoring', `${dimension} evidence was not verified: ${verdict && verdict.status === 'REFUSED' ? verdict.reason : 'no verdict'}`);
            }
            if (verdict.dimension !== dimension || verdict.result !== 'PASSED' || verdict.evidenceRef.kind !== ref.kind || verdict.evidenceRef.id !== ref.id) {
              throw new ConflictError('AbaAuthoring', `${dimension} evidence verdict does not match the requested dimension, result or reference`);
            }
            if (!MS_UTC.test(verdict.evaluatedAt) || Number.isNaN(Date.parse(verdict.evaluatedAt))) {
              throw new ConflictError('AbaAuthoring', `${dimension} evidence verdict carries a malformed evaluation time`);
            }
            const evaluatedMs = Date.parse(verdict.evaluatedAt);
            if (evaluatedMs < Date.parse(now)) throw new ConflictError('AbaAuthoring', `${dimension} evaluation predates the modification, so it is not fresh`);
            if (evaluatedMs > Date.parse(await this.d.audit.databaseNow(ctx))) throw new ConflictError('AbaAuthoring', `${dimension} evaluation is dated after the database clock`);
            evidence.push({ dimension, evaluatedAt: verdict.evaluatedAt, result: 'PASSED', evidenceRef: { kind: verdict.evidenceRef.kind, id: verdict.evidenceRef.id } });
          }
          evaluation = { state: 'VALUE', value: { basis: required.basis, evidence } };
        }
      } else {
        if ((input.evaluationEvidence ?? []).length > 0) throw invalid('a plain approval carries no modification evaluation');
        modification = { state: 'NOT_APPLICABLE', reason: { code: 'PLAIN_APPROVAL', statement: 'Approved as proposed.' } };
        evaluation = { state: 'NOT_APPLICABLE', reason: { code: 'NO_MODIFICATION', statement: 'No modification to evaluate.' } };
      }

      const candidate = {
        businessId, actionId, decisionId: decision.id, decisionVersionId: decisionVersion.id, decisionStatus: decision.status as 'approved' | 'approved_with_modifications',
        actionType: { code: canonical.code, schemaVersion: canonical.schemaVersion }, target: { kind: input.target.kind, id: input.target.id },
        proposed: { state: 'VALUE' as const, value: { source: { layer: 'ADI' as const, recordType: 'decision_recommendation', recordId: action.sourceRecommendationId! }, parameters: input.proposedParameters } },
        modification, modificationEvaluation: evaluation, finalParameters,
        capturedByUserId: ctx.userId, correlationId: rc.correlationId,
      };
      const codeProblems = notApplicableCodeProblems(candidate);
      if (codeProblems.length > 0) throw invalid(codeProblems.join('; '));

      const before = await this.d.captures.getCaptureByActionId(ctx, actionId);
      // The database re-derives the final set from the original and the delta and refuses any disagreement.
      const capture = await this.d.captures.recordCapture(ctx, candidate);
      if (!before) {
        await this.auditRow(ctx, rc, {
          action: 'aba.capture.recorded', entityType: 'authorized_action_capture', entityId: capture.id, businessId,
          detail: { actionId, decisionId: decision.id, decisionStatus: decision.status, actionType: candidate.actionType, modified },
        });
      }
      return { captureId: capture.id, actionId, decisionStatus: capture.decisionStatus, actionType: capture.actionType, finalParameters: capture.finalParameters as Record<string, JsonValue>, capturedAt: capture.capturedAt, created: !before };
    });
  }

  // ── D. accountable owner (aba:write) ────────────────────────────────────────────────────────────────────────────────

  async assignOwner(ctx: TenantContext, rc0: AuthoringRequestContext, businessId: string, actionId: string, input: OwnerInput): Promise<OwnerView> {
    const rc = this.normalise(rc0);
    await this.requireAction(ctx, businessId, actionId);
    if (!UUID.test(input.ownerUserId) || !UUID.test(input.membershipId)) throw invalid('ownerUserId and membershipId must be UUIDs');
    const candidate = {
      businessId, actionId, owner: { userId: input.ownerUserId, membershipId: input.membershipId }, roleCode: input.roleCode, assignedByUserId: ctx.userId,
      dueAt: input.dueAt, escalationPolicy: input.escalationPolicy, correlationId: rc.correlationId,
    };
    const codeProblems = notApplicableCodeProblems({ dueAt: input.dueAt, escalationPolicy: input.escalationPolicy });
    if (codeProblems.length > 0) throw invalid(codeProblems.join('; '));
    return withSharedTenantTransaction(ctx, async () => {
      const before = await this.d.captures.getCurrentOwner(ctx, actionId);
      // The database verifies the owner is a real user with an ACTIVE membership in THIS tenant and workspace.
      const owner: OwnerAssignment = await this.d.captures.assignOwner(ctx, candidate);
      const created = !before || before.assignmentVersion !== owner.assignmentVersion;
      if (created) {
        await this.auditRow(ctx, rc, {
          action: 'aba.owner.assigned', entityType: 'authorized_action_owner_assignment', entityId: owner.id, businessId,
          detail: { actionId, assignmentVersion: owner.assignmentVersion, ownerUserId: owner.owner.userId, roleCode: owner.roleCode },
        });
      }
      return { assignmentId: owner.id, assignmentVersion: owner.assignmentVersion, ownerUserId: owner.owner.userId, membershipId: owner.owner.membershipId, roleCode: owner.roleCode, assignedAt: owner.assignedAt, created };
    });
  }

  // ── E. execution boundaries (aba:write + decision approver) ─────────────────────────────────────────────────────────

  async authorBoundaries(ctx: TenantContext, rc0: AuthoringRequestContext, businessId: string, actionId: string, input: BoundariesInput): Promise<BoundariesView> {
    const rc = this.normalise(rc0);
    const action = await this.requireAction(ctx, businessId, actionId);
    const decision = await this.d.decisions.getById(ctx, action.decisionId);
    await this.requireDecisionApprover(ctx, decision.approverAssignmentId);
    const capture = await this.d.captures.getCaptureByActionId(ctx, actionId);
    if (!capture) throw new ConflictError('AbaAuthoring', 'boundaries can only be authored after the structured capture');
    const canonical = this.canonicalOrRefuse(capture.actionType.code, capture.actionType.schemaVersion);
    const codeProblems = notApplicableCodeProblems(input);
    if (codeProblems.length > 0) throw invalid(codeProblems.join('; '));
    // Fail closed: NOT_APPLICABLE only where the CANONICAL contract says so (the database re-checks against the registered type).
    for (const field of BOUNDARY_FIELDS) {
      if (input[field].state === 'NOT_APPLICABLE' && canonical.applicability[field] !== 'NOT_APPLICABLE_ALLOWED') {
        throw invalid(`${canonical.code}@${canonical.schemaVersion} requires ${field}; NOT_APPLICABLE is not permitted`);
      }
    }
    if (input.simulationRun.state === 'NOT_APPLICABLE' && !SIMULATION_NOT_APPLICABLE_ALLOWED.has(actionTypeKey(canonical.code, canonical.schemaVersion))) {
      throw invalid(`${canonical.code}@${canonical.schemaVersion} requires a simulation run reference; NOT_APPLICABLE is not permitted`);
    }
    return withSharedTenantTransaction(ctx, async () => {
      if (input.simulationRun.state === 'VALUE') {
        // The reference must be a real, in-scope, completed run of the Simulation layer (not merely a well-formed UUID).
        const verdict = await this.d.simulationRuns.verify(ctx, { businessId, runId: input.simulationRun.value });
        if (!verdict.ok) throw new ConflictError('AbaAuthoring', `simulation run reference refused: ${verdict.reason}`);
      }
      const before = await this.d.boundaries.getCurrent(ctx, actionId);
      const stored: AuthorizedActionBoundaries = await this.d.boundaries.recordBoundaries(ctx, {
        businessId, actionId, captureId: capture.id, authoredByUserId: ctx.userId, correlationId: rc.correlationId,
        executionWindow: input.executionWindow, preconditions: input.preconditions as never, budget: input.budget, rollback: input.rollback,
        monitoring: input.monitoring as never, simulationRun: input.simulationRun,
      } as never);
      const created = !before || before.boundaryVersion !== stored.boundaryVersion;
      if (created) {
        await this.auditRow(ctx, rc, {
          action: 'aba.boundaries.authored', entityType: 'authorized_action_boundaries', entityId: stored.id, businessId,
          detail: { actionId, boundaryVersion: stored.boundaryVersion, captureId: capture.id },
        });
      }
      return { boundariesId: stored.id, boundaryVersion: stored.boundaryVersion, authoredAt: stored.authoredAt, created };
    });
  }

  // ── F. issuance (aba:write; identifiers only) ───────────────────────────────────────────────────────────────────────

  /** Invokes the ONE issuer with identifiers only. Everything else is loaded and judged by the issuer itself. */
  async issuePackage(ctx: TenantContext, rc0: AuthoringRequestContext, businessId: string, actionId: string): Promise<IssuedPackageView> {
    const rc = this.normalise(rc0);
    await this.requireAction(ctx, businessId, actionId);
    const result: IssuePackageResult = await this.d.issuer.issue(ctx, { actionId, correlationId: rc.correlationId, permissionUsed: rc.permissionUsed });
    const p = result.package;
    return {
      outcome: result.outcome, packageId: p.identity.packageId, packageVersion: p.identity.packageVersion, status: 'ISSUED', digest: p.integrity.digest,
      issuedAt: p.issuance.issuedAt, expiresAt: p.validity.expiresAt.state === 'VALUE' ? p.validity.expiresAt.value : null,
      automationLevel: p.action.automationLevel.level, actionType: { code: p.action.type.code, schemaVersion: p.action.type.schemaVersion },
      supersedes: p.identity.supersedes,
    };
  }

  // ── G. safe reads (aba:read) ────────────────────────────────────────────────────────────────────────────────────────

  async getAuthoringStatus(ctx: TenantContext, businessId: string, actionId: string): Promise<AuthoringStatusView> {
    const action = await this.requireAction(ctx, businessId, actionId);
    const decision = await this.d.decisions.getById(ctx, action.decisionId);
    const capture = await this.d.captures.getCaptureByActionId(ctx, actionId);
    const owner = await this.d.captures.getCurrentOwner(ctx, actionId);
    const boundaries = await this.d.boundaries.getCurrent(ctx, actionId);
    const registered = capture ? await this.d.actionTypes.get(ctx, capture.actionType.code, capture.actionType.schemaVersion) : null;
    const effective = await this.d.policies.getEffectivePolicy(ctx, 2);
    const header = await this.d.packages.getHeaderByActionId(ctx, actionId);
    const latest = header ? await this.d.packages.getLatestVersion(ctx, header.id) : null;
    const status = latest ? await this.d.packages.getAuthoritativeStatus(ctx, latest.packageId, latest.packageVersion) : null;
    const missing: AuthoringStatusView['missing'] = [];
    if (!capture) missing.push('CAPTURE');
    if (capture && registered?.status !== 'ACTIVE') missing.push('ACTION_TYPE_ACTIVE');
    if (!owner) missing.push('OWNER');
    if (!boundaries) missing.push('BOUNDARIES');
    if (!effective) missing.push('LEVEL2_POLICY');
    return {
      actionId, decision: { id: decision.id, status: decision.status },
      actionType: capture ? { code: capture.actionType.code, schemaVersion: capture.actionType.schemaVersion, status: registered?.status ?? 'NOT_REGISTERED' } : null,
      capture: { recorded: Boolean(capture), capturedAt: capture?.capturedAt ?? null },
      owner: { assigned: Boolean(owner), assignmentVersion: owner?.assignmentVersion ?? null },
      boundaries: { authored: Boolean(boundaries), boundaryVersion: boundaries?.boundaryVersion ?? null },
      level2Policy: { enabled: Boolean(effective), policyCode: effective?.policyCode ?? null, versionNumber: effective?.versionNumber ?? null },
      latestPackage: latest && status ? { packageId: latest.packageId, packageVersion: latest.packageVersion, lifecycle: status.lifecycle, digest: latest.digest, expiresAt: latest.expiresAt } : null,
      missing,
    };
  }
}

