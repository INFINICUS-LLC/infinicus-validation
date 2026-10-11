/**
 * ABA package issuance policy (P0-5 Block 3d; owner rulings 1-8).
 *
 * Pure and database-free. Given the authoritative facts the issuer loaded server-side, it either REFUSES (with every
 * reason it can establish) or assembles the unsealed `aap/1` candidate. It never accepts a caller-supplied authorization
 * fact, never reconstructs final parameters (it copies the database-verified capture), and never invents a value: a
 * missing source is a refusal, not a default.
 *
 * Judged here, with the existing P0-2 / P0-3 policy modules reused rather than re-implemented:
 *   approval decided and audited exactly once; authority valid at decision time (assignment version + canonical provenance);
 *   risk tier (P0-2); persisted-fact freshness gate (P0-3); canonical action type + ACTIVE workspace registration that equals it;
 *   an enabled Level 2 policy that names the action type; accountable owner; execution boundaries; UPPER_SNAKE NOT_APPLICABLE codes.
 * Level 3 and Level 4 are never issuable here (Level 3 needs rule-authorization provenance that does not exist yet; Level 4 is
 * NOT_ENABLED).
 */

import { canonicalize, actionTypeMatchesCanonical } from '@infinicus/handoff-contracts';
import type {
  ActionTypeContract, ActionTypeRegistry, AuthorizedActionPackageBody, AutomationLevelValue, PackageEnablementPolicy,
} from '@infinicus/handoff-contracts';
import type {
  AccountableOwnerShape, ActionTypeWithStatus, AuthorizedActionBoundaries, AuthorizedActionCapture, EffectivePolicy, IssuanceSources,
  OwnerAssignment,
} from '@infinicus/database';
import { evaluateApprovalGate } from './approvalGate.js';
import type { TwinFreshness } from './approvalGate.js';
import { approverTier, evaluateApproval, isRiskClass } from './approvalRiskPolicy.js';

/** The single component allowed to issue packages (the contract's architecture test allow-lists exactly this issuer). */
export const ISSUER_COMPONENT = 'aba.package-issuer';
/** Only Level 2 (human approval / system execution) is issuable. Level 3 lacks rule provenance; Level 4 is NOT_ENABLED. */
export const ISSUABLE_AUTOMATION_LEVELS: readonly AutomationLevelValue[] = Object.freeze([2]);
export const ISSUANCE_ENABLEMENT: PackageEnablementPolicy = Object.freeze({ automationLevels: ISSUABLE_AUTOMATION_LEVELS });
/** Level 2 policy template convention: the enabled policy version's `specification.actionTypes` lists `{code, schemaVersion}` entries. */
export const POLICY_ACTION_TYPES_KEY = 'actionTypes';
export const NOT_APPLICABLE_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const REQUIRED_PERMISSION_FIELD = 'permissionUsed';

export type IssuanceRefusalCode =
  | 'ACTION_NOT_FOUND' | 'DECISION_NOT_APPROVED'
  | 'APPROVAL_AUDIT_MISSING' | 'APPROVAL_AUDIT_AMBIGUOUS' | 'APPROVAL_AUDIT_MISMATCH'
  | 'AUTHORITY_NOT_ESTABLISHED' | 'AUTHORITY_REVOKED'
  | 'REVIEW_FACTS_MISSING' | 'RISK_POLICY' | 'FRESHNESS_GATE' | 'RECOMMENDATION_LINEAGE_MISSING'
  | 'CAPTURE_MISSING' | 'CAPTURE_MISMATCH' | 'ACTION_VERSION_MISSING'
  | 'ACTION_TYPE_NOT_CANONICAL' | 'ACTION_TYPE_NOT_ACTIVE' | 'ACTION_TYPE_DIVERGES_FROM_CANONICAL'
  | 'LEVEL2_POLICY_NOT_ENABLED'
  | 'OWNER_MISSING' | 'BOUNDARIES_MISSING' | 'NOT_APPLICABLE_REASON_CODE_INVALID'
  | 'PACKAGE_INVALID' | 'STORED_PACKAGE_INVALID' | 'EXISTING_PACKAGE_NOT_REPLAYABLE' | 'SUPERSESSION_BLOCKED'
  | 'PERSISTENCE_FAILED' | 'AUDIT_FAILED';

export interface IssuanceRefusal {
  code: IssuanceRefusalCode;
  message: string;
}

/** Everything the issuer loads (server-side, by identifier) before judging. */
export interface IssuanceFacts {
  tenantId: string;
  workspaceId: string;
  sources: IssuanceSources;
  capture: AuthorizedActionCapture | null;
  owner: OwnerAssignment | null;
  ownerShape: AccountableOwnerShape | null;
  boundaries: AuthorizedActionBoundaries | null;
  /** The workspace registration of the captured action type, with its status; null when none exists. */
  registered: ActionTypeWithStatus | null;
  /** The enabled Level 2 policy, and its version specification. */
  level2Policy: { effective: EffectivePolicy; specification: Record<string, unknown> } | null;
  twin: TwinFreshness | null;
  canonicalTypes: ActionTypeRegistry;
  packageId: string;
  packageVersion: number;
  supersedes: { packageId: string; packageVersion: number } | null;
  correlationId: string;
}

export type IssuanceEvaluation =
  | { ok: true; candidate: AuthorizedActionPackageBody; approvalAuditEventId: string }
  | { ok: false; refusals: IssuanceRefusal[] };

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim().length > 0 ? v : null);

/** Finds every governed NOT_APPLICABLE reason code in a document, with its path. */
export function collectNotApplicableCodes(value: unknown, path = '$', out: { path: string; code: unknown }[] = []): { path: string; code: unknown }[] {
  if (Array.isArray(value)) {
    value.forEach((item, i) => collectNotApplicableCodes(item, `${path}[${i}]`, out));
  } else if (isObject(value)) {
    if (value.state === 'NOT_APPLICABLE') out.push({ path: `${path}.reason.code`, code: isObject(value.reason) ? value.reason.code : undefined });
    for (const [k, v] of Object.entries(value)) collectNotApplicableCodes(v, `${path}.${k}`, out);
  }
  return out;
}

/** Owner ruling 4: stored reason codes must already be UPPER_SNAKE_CASE. They are never normalized; a bad one refuses issuance. */
export function notApplicableCodeProblems(document: unknown): string[] {
  return collectNotApplicableCodes(document)
    .filter((c) => typeof c.code !== 'string' || !NOT_APPLICABLE_CODE_PATTERN.test(c.code))
    .map((c) => `${c.path} must be UPPER_SNAKE_CASE (found ${JSON.stringify(c.code)})`);
}

/**
 * Compares two package documents for idempotency: everything that is an authoritative INPUT must be equal, while the
 * facts that change on every issuance attempt (version, supersession link, issue time, freshness assessment time, trace
 * correlation) are ignored. Equal inputs = the same issuance; different inputs = a new package version.
 */
export function authoritativeInputsKey(document: unknown): string {
  const clone = JSON.parse(JSON.stringify(document)) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  delete clone.integrity;
  if (isObject(clone.identity)) { delete clone.identity.packageVersion; delete clone.identity.supersedes; }
  if (isObject(clone.issuance)) delete clone.issuance.issuedAt;
  if (isObject(clone.validity) && isObject(clone.validity.freshness)) delete clone.validity.freshness.assessedAt;
  if (isObject(clone.trace)) delete clone.trace.correlationId;
  return canonicalize(clone);
}

export function evaluateIssuance(f: IssuanceFacts): IssuanceEvaluation {
  const refusals: IssuanceRefusal[] = [];
  const refuse = (code: IssuanceRefusalCode, message: string): void => { refusals.push({ code, message }); };
  const { sources } = f;
  const { action, decision } = sources;

  // --- the approval itself: approved, audited exactly once -------------------------------------------------------
  if (decision.status !== 'approved' && decision.status !== 'approved_with_modifications') {
    refuse('DECISION_NOT_APPROVED', `the decision status is "${decision.status}"; only approved or approved_with_modifications can be issued`);
  }
  const expectedEvent = `approval.${decision.status}`;
  let audit: IssuanceSources['approvalAudit']['events'][number] | null = null;
  if (sources.approvalAudit.events.length === 0) {
    refuse('APPROVAL_AUDIT_MISSING', 'the decision has no approval audit event');
  } else if (sources.approvalAudit.events.length > 1) {
    refuse('APPROVAL_AUDIT_AMBIGUOUS', 'the decision has more than one approval audit event');
  } else {
    audit = sources.approvalAudit.events[0];
    if (audit.eventType !== expectedEvent) refuse('APPROVAL_AUDIT_MISMATCH', `the approval audit event is ${audit.eventType}, expected ${expectedEvent}`);
  }

  const detail = audit?.detail ?? {};
  const approver = isObject(detail.approver) ? detail.approver : {};
  const facts = isObject(detail.facts) ? detail.facts : null;
  const approverUserId = text(approver.userId);
  const permissionUsed = text(detail[REQUIRED_PERMISSION_FIELD]);
  if (audit) {
    if (detail.schema !== 'approval-audit/1') refuse('APPROVAL_AUDIT_MISMATCH', 'the approval audit event is not an approval-audit/1 record');
    if (detail.decisionId !== decision.decisionId || detail.reviewPackageId !== decision.reviewPackageId) {
      refuse('APPROVAL_AUDIT_MISMATCH', 'the approval audit event names a different decision or review');
    }
    if (approver.assignmentId !== decision.approverAssignmentId) refuse('APPROVAL_AUDIT_MISMATCH', 'the approval audit event names a different approver assignment than the decision');
    if (approverUserId === null) refuse('APPROVAL_AUDIT_MISMATCH', 'the approval audit event records no approver');
    if (permissionUsed === null) refuse('APPROVAL_AUDIT_MISMATCH', 'the approval audit event records no permission used');
    if (facts === null) refuse('REVIEW_FACTS_MISSING', 'the approval audit event recorded no review facts');
  }

  // --- authority valid at decision time (assignment version + canonical provenance) ------------------------------------
  const assignment = sources.assignment;
  let assignmentVersionId = '';
  let roleCode = '';
  let scopeId = '';
  if (audit && assignment) {
    if (assignment.versionAtDecision === null) {
      refuse('AUTHORITY_NOT_ESTABLISHED', 'the approver assignment had no version at the decision time');
    } else {
      assignmentVersionId = assignment.versionAtDecision.id;
      roleCode = assignment.versionAtDecision.roleCode;
      if (approver.roleCode !== roleCode) refuse('APPROVAL_AUDIT_MISMATCH', 'the role recorded at approval differs from the assignment version in force at that time');
    }
    if (approverUserId !== null && assignment.userId !== approverUserId) refuse('APPROVAL_AUDIT_MISMATCH', 'the approver recorded at approval is not the assignment holder');
    const decidedMs = Date.parse(audit.occurredAt);
    const upToDecision = assignment.provenance.filter((p) => Date.parse(p.createdAt) <= decidedMs);
    const last = upToDecision[upToDecision.length - 1];
    if (!last || last.entry.action !== 'grant' || last.entry.state !== 'active') {
      refuse('AUTHORITY_NOT_ESTABLISHED', 'no active canonical authority grant existed at the decision time');
    } else {
      scopeId = last.scopeId;
    }
    const latest = assignment.provenance[assignment.provenance.length - 1];
    if (assignment.status !== 'active' || (latest && latest.entry.action === 'revoke')) {
      refuse('AUTHORITY_REVOKED', 'the approver authority has been revoked since the decision; a package is not issued from revoked authority');
    }
  } else if (audit) {
    refuse('AUTHORITY_NOT_ESTABLISHED', 'the approver assignment does not exist');
  }

  // --- review facts, risk tier (P0-2), freshness gate (P0-3) -----------------------------------------------------------
  const review = sources.review;
  let riskClass: 'low' | 'medium' | 'high' | 'critical' = 'high';
  let riskBasis: 'PERSISTED' | 'UNCLASSIFIED_FAIL_CLOSED_HIGH' = 'UNCLASSIFIED_FAIL_CLOSED_HIGH';
  let requiredTier = 0;
  let tier = 0;
  if (!review) {
    if (audit && facts !== null) refuse('REVIEW_FACTS_MISSING', 'the review version recorded at approval cannot be found for this decision');
  } else {
    if (facts !== null && (facts.riskClass ?? null) !== review.riskClass) {
      refuse('APPROVAL_AUDIT_MISMATCH', 'the risk class recorded at approval differs from the persisted review version');
    }
    const verdict = evaluateApproval({ riskClass: review.riskClass, roleCode, outcome: 'approve' });
    requiredTier = verdict.requirement.requiredTier;
    tier = approverTier(roleCode);
    riskClass = verdict.requirement.riskClass;
    riskBasis = isRiskClass(review.riskClass) ? 'PERSISTED' : 'UNCLASSIFIED_FAIL_CLOSED_HIGH';
    if (!verdict.allowed) refuse('RISK_POLICY', verdict.reason);
    const gate = evaluateApprovalGate({
      facts: { isTimeSensitive: review.isTimeSensitive, validUntil: review.validUntil === null ? null : new Date(review.validUntil), twinSnapshotId: review.twinSnapshotId },
      now: new Date(sources.now),
      twin: f.twin,
    });
    if (!gate.allowed) refuse('FRESHNESS_GATE', gate.reasons.join('; '));
    if (!review.recommendation || review.recommendation.businessId !== action.businessId || action.sourceRecommendationId !== review.recommendation.recommendationId) {
      refuse('RECOMMENDATION_LINEAGE_MISSING', 'the review version does not trace to the action\'s recommendation');
    }
  }

  // --- structured capture (separate ABA step; approved-without-capture is NOT issuable) -------------------------------
  const capture = f.capture;
  if (!capture) {
    refuse('CAPTURE_MISSING', 'no structured capture exists for this approved action: it is approved but not issuable');
  } else {
    if (capture.decisionId !== decision.decisionId || capture.decisionStatus !== decision.status || capture.decisionVersionId !== decision.decisionVersionId) {
      refuse('CAPTURE_MISMATCH', 'the capture does not match the approved decision, its status or its latest version');
    }
  }
  if (action.actionVersionId === null) refuse('ACTION_VERSION_MISSING', 'the authorized action has no version');

  // --- canonical action type + workspace activation ---------------------------------------------------------------------
  if (capture) {
    const canonical = f.canonicalTypes.resolve(capture.actionType.code, capture.actionType.schemaVersion);
    if (!canonical) {
      refuse('ACTION_TYPE_NOT_CANONICAL', `${capture.actionType.code}@${capture.actionType.schemaVersion} is not a canonical platform action type`);
    } else if (!f.registered || f.registered.status !== 'ACTIVE') {
      refuse('ACTION_TYPE_NOT_ACTIVE', `${capture.actionType.code}@${capture.actionType.schemaVersion} is not ACTIVE in this workspace (${f.registered?.status ?? 'not registered'})`);
    } else {
      const d = f.registered.definition;
      const stored = { code: d.code, schemaVersion: d.schemaVersion, targetKinds: d.targetKinds, parameters: d.parameters, governanceImpact: d.governanceImpact, applicability: d.applicability } as unknown as ActionTypeContract;
      if (!actionTypeMatchesCanonical(stored, canonical)) {
        refuse('ACTION_TYPE_DIVERGES_FROM_CANONICAL', 'the workspace registration redefines the canonical action type; the canonical contract governs');
      }
    }
  }

  // --- automation level: Level 2 only, with an enabled policy that names this action type ------------------------------
  if (!f.level2Policy) {
    refuse('LEVEL2_POLICY_NOT_ENABLED', 'no enabled Level 2 automation policy exists for this workspace');
  } else if (capture) {
    const listed = f.level2Policy.specification[POLICY_ACTION_TYPES_KEY];
    const names = Array.isArray(listed) && listed.some((e) => isObject(e) && e.code === capture.actionType.code && e.schemaVersion === capture.actionType.schemaVersion);
    if (!names) refuse('LEVEL2_POLICY_NOT_ENABLED', `the enabled Level 2 policy does not cover ${capture.actionType.code}@${capture.actionType.schemaVersion}`);
  }

  // --- owner, boundaries -------------------------------------------------------------------------------------------------
  if (!f.owner || !f.ownerShape) refuse('OWNER_MISSING', 'no accountable owner is assigned to this action');
  if (!f.boundaries) refuse('BOUNDARIES_MISSING', 'no execution boundaries (window, preconditions, budget, rollback, monitoring, simulation reference) are authored for this action');
  else if (capture && f.boundaries.captureId !== capture.id) refuse('CAPTURE_MISMATCH', 'the execution boundaries belong to a different capture');

  if (refusals.length > 0 || !audit || !capture || !review || !f.ownerShape || !f.boundaries || !f.level2Policy || !review.recommendation || action.actionVersionId === null) {
    return { ok: false, refusals };
  }

  // --- assemble (every value is a persisted fact; nothing is caller-supplied) -------------------------------------------
  const b = f.boundaries;
  const window = b.executionWindow;
  const bounds: { source: 'DECISION_VALID_UNTIL' | 'EXECUTION_WINDOW_END'; at: string }[] = [];
  if (review.validUntil !== null) bounds.push({ source: 'DECISION_VALID_UNTIL', at: review.validUntil });
  if (window.state === 'VALUE' && window.value.endsAt !== null) bounds.push({ source: 'EXECUTION_WINDOW_END', at: window.value.endsAt });
  const earliest = bounds.reduce<string | null>((min, x) => (min === null || Date.parse(x.at) < Date.parse(min) ? x.at : min), null);
  const contractTypeRef = `${capture.actionType.code}@${capture.actionType.schemaVersion}`;

  const body = {
    contractVersion: 'aap/1',
    identity: { packageId: f.packageId, packageVersion: f.packageVersion, supersedes: f.supersedes },
    scope: { tenantId: f.tenantId, workspaceId: f.workspaceId, businessId: action.businessId },
    issuance: { issuedAt: sources.now, issuerComponent: ISSUER_COMPONENT },
    action: {
      actionId: action.actionId,
      actionVersionId: action.actionVersionId,
      type: capture.actionType,
      target: capture.target,
      parameters: capture.finalParameters,
      automationLevel: { level: 2, policy: { policyId: f.level2Policy.effective.policyId, policyVersionId: f.level2Policy.effective.policyVersionId } },
      ...{
        executionWindow: b.executionWindow, preconditions: b.preconditions, budget: b.budget, rollback: b.rollback, monitoring: b.monitoring,
      },
    },
    lineage: {
      recommendation: { recommendationId: review.recommendation.recommendationId, recommendationVersionId: review.recommendation.recommendationVersionId },
      review: { reviewPackageId: review.reviewPackageId, reviewVersionId: review.reviewVersionId },
      decision: { decisionId: decision.decisionId, decisionVersionId: capture.decisionVersionId },
      twinSnapshotId: review.twinSnapshotId === null
        ? { state: 'NOT_APPLICABLE', reason: { code: 'NO_TWIN_SNAPSHOT', statement: 'The recommendation was not computed from a Digital Twin snapshot.' } }
        : { state: 'VALUE', value: review.twinSnapshotId },
      simulationRunId: b.simulationRun,
      proposedParameters: capture.proposed,
      modification: capture.modification,
      modificationEvaluation: capture.modificationEvaluation,
    },
    authorization: {
      mode: 'HUMAN_APPROVAL',
      decisionStatus: decision.status,
      decidedAt: audit.occurredAt,
      approver: { userId: approverUserId, assignmentId: decision.approverAssignmentId, assignmentVersionId, roleCode },
      authorityProvenance: { scopeId },
      permissionUsed,
      approvalAuditEventId: audit.id,
      risk: { riskClass, basis: riskBasis, requiredApproverTier: requiredTier, approverTier: tier },
    },
    accountableOwner: f.ownerShape,
    validity: {
      isTimeSensitive: review.isTimeSensitive === true,
      decisionValidUntil: review.validUntil === null
        ? { state: 'NOT_APPLICABLE', reason: { code: 'NO_DECISION_VALID_UNTIL', statement: 'The decision carries no valid_until.' } }
        : { state: 'VALUE', value: review.validUntil },
      freshness: { assessedAt: sources.now, twin: review.twinSnapshotId === null ? 'NOT_APPLICABLE' : 'FRESH' },
      expiryBounds: bounds,
      expiresAt: earliest === null
        ? {
          state: 'NOT_APPLICABLE',
          reason: { code: 'NO_VALIDITY_BOUND', statement: 'No validity bound applies to this action type.', basis: { kind: 'ACTION_SCHEMA', ref: contractTypeRef } },
        }
        : { state: 'VALUE', value: earliest },
    },
    consumption: { mode: 'SINGLE_USE' },
    trace: { correlationId: f.correlationId, causationId: audit.id },
  } as unknown as AuthorizedActionPackageBody;

  const codeProblems = notApplicableCodeProblems(body);
  if (codeProblems.length > 0) {
    return { ok: false, refusals: codeProblems.map((message) => ({ code: 'NOT_APPLICABLE_REASON_CODE_INVALID' as const, message })) };
  }
  return { ok: true, candidate: body, approvalAuditEventId: audit.id };
}
