import type { ActionExecutionVerification, GovernedMeasurementDefinition, TenantContext } from '@infinicus/database';

/** Advisory inputs for OM-MEASURE-7. No source in this block can confer observation authority. */
export interface VerificationCandidate {
  businessId: string;
  execution: ActionExecutionVerification | null;
  executorId: string | null;
  definition: GovernedMeasurementDefinition | null;
  metricApproved: boolean;
  criterionApproved: boolean;
  baseline: { complete: boolean; businessId: string; currency: string; metricCode: string; metricVersion: number;
    openedAt: string; closedAt: string } | null;
  window: { openedAt: string; closedAt: string } | null;
  observation: {
    id: string; versionId: string; businessId: string; currency: string; metricCode: string; metricVersion: number;
    writerAuthorized: boolean; sourceDigest: string; provenanceValid: boolean;
  } | null;
  attribution: { status: 'PASS' | 'FAIL' | 'INCONCLUSIVE'; sourceDigest: string; assessorId: string; version: number } | null;
  approval: { userId: string; businessId: string; authorityConfirmed: boolean } | null;
  evaluatedAt: string;
}

export type VerificationRefusalReason =
  | 'EXECUTION_EVIDENCE_MISSING' | 'EXECUTION_NOT_APPLIED' | 'SCOPE_MISMATCH'
  | 'METRIC_UNAPPROVED' | 'BASELINE_INCOMPLETE' | 'WINDOW_INCOMPLETE'
  | 'OBSERVATION_UNAUTHORIZED' | 'PROVENANCE_INVALID' | 'CURRENCY_MISMATCH'
  | 'ATTRIBUTION_NOT_PASSED' | 'APPROVER_UNAUTHORIZED' | 'SELF_APPROVAL'
  | 'CRITERION_UNAPPROVED' | 'OBSERVATION_AUTHORITY_PENDING';

export interface VerificationRefusalAssessment {
  readonly verdictAllowed: false;
  readonly reasons: readonly VerificationRefusalReason[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const validDate = (value: string): number => {
  if (!UTC.test(value)) return NaN;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : NaN;
};

/**
 * Classifies refusal reasons only. It has no writer, grant, verdict, or release capability.
 * Caller-provided facts cannot become authoritative through this function; even a clean
 * candidate stays closed until an owner-approved observation and attribution contract exists.
 */
export function assessVerificationRefusal(ctx: TenantContext, candidate: VerificationCandidate): VerificationRefusalAssessment {
  const reasons = new Set<VerificationRefusalReason>();
  const { execution, definition, baseline, window, observation, attribution, approval } = candidate;
  if (!execution || !UUID.test(execution.id) || !UUID.test(execution.executionId) || !DIGEST.test(execution.evidenceDigest)) {
    reasons.add('EXECUTION_EVIDENCE_MISSING');
  } else {
    if (execution.executionState !== 'EXECUTION_VERIFIED' || execution.executionOutcome !== 'SUCCEEDED' || execution.mutationResult !== 'APPLIED')
      reasons.add('EXECUTION_NOT_APPLIED');
    if (execution.tenantId !== ctx.tenantId || execution.workspaceId !== ctx.workspaceId || execution.businessId !== candidate.businessId)
      reasons.add('SCOPE_MISMATCH');
  }
  if (!definition || !candidate.metricApproved || definition.metricCode !== candidate.observation?.metricCode ||
      definition.businessId !== candidate.businessId ||
      (execution && (definition.actionTypeCode !== execution.actionType.code || definition.actionTypeSchemaVersion !== execution.actionType.schemaVersion)))
    reasons.add('METRIC_UNAPPROVED');
  const opened = window ? validDate(window.openedAt) : NaN;
  const baselineOpened = baseline ? validDate(baseline.openedAt) : NaN;
  const baselineClosed = baseline ? validDate(baseline.closedAt) : NaN;
  if (!baseline || !baseline.complete || baseline.businessId !== candidate.businessId ||
      !Number.isInteger(baseline.metricVersion) || baseline.metricVersion <= 0 ||
      baseline.metricCode !== definition?.metricCode || !baseline.currency ||
      !Number.isFinite(baselineOpened) || !Number.isFinite(baselineClosed) || baselineOpened >= baselineClosed ||
      (Number.isFinite(opened) && baselineClosed !== opened) ||
      (definition && baselineClosed - baselineOpened !== definition.baselineSeconds * 1000))
    reasons.add('BASELINE_INCOMPLETE');
  const closed = window ? validDate(window.closedAt) : NaN;
  const now = validDate(candidate.evaluatedAt);
  if (!Number.isFinite(opened) || !Number.isFinite(closed) || !Number.isFinite(now) ||
      opened >= closed || closed > now || (execution && opened < validDate(execution.executionRecordedAt)) ||
      (definition && closed - opened !== definition.windowSeconds * 1000)) reasons.add('WINDOW_INCOMPLETE');
  if (!observation || !UUID.test(observation.id) || !UUID.test(observation.versionId) || !observation.writerAuthorized)
    reasons.add('OBSERVATION_UNAUTHORIZED');
  if (!observation || !observation.provenanceValid || !DIGEST.test(observation.sourceDigest) ||
      (attribution && !DIGEST.test(attribution.sourceDigest))) reasons.add('PROVENANCE_INVALID');
  if (!observation || !baseline || observation.businessId !== candidate.businessId ||
      observation.currency !== baseline.currency || observation.metricCode !== baseline.metricCode ||
      observation.metricVersion !== baseline.metricVersion) reasons.add('CURRENCY_MISMATCH');
  if (!attribution || attribution.status !== 'PASS' || !DIGEST.test(attribution.sourceDigest) ||
      !UUID.test(attribution.assessorId) || !Number.isInteger(attribution.version) || attribution.version <= 0)
    reasons.add('ATTRIBUTION_NOT_PASSED');
  if (!approval || !UUID.test(approval.userId) || approval.businessId !== candidate.businessId || !approval.authorityConfirmed ||
      approval.userId !== definition?.approverId) reasons.add('APPROVER_UNAUTHORIZED');
  if (!UUID.test(candidate.executorId ?? '') || !approval || approval.userId === candidate.executorId ||
      approval.userId === definition?.authorId || approval.userId === attribution?.assessorId) reasons.add('SELF_APPROVAL');
  if (!definition || !candidate.criterionApproved || !Number.isFinite(Number(definition.successThreshold)) ||
      !['increase', 'decrease'].includes(definition.successDirection)) reasons.add('CRITERION_UNAPPROVED');
  reasons.add('OBSERVATION_AUTHORITY_PENDING');
  return { verdictAllowed: false, reasons: [...reasons] };
}
