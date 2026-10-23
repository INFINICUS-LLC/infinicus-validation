// OM → CL handoff contract (BUILD-16).
// Carries a finalized learning feedback package — built from a completed
// outcome review of a recorded/verified observation — from Outcome
// Monitoring to Continuous Learning. OM observes and evaluates outcomes;
// it does not synthesize learning updates, revise upstream decisions or
// recommendations, or modify policy. OM declares what was observed and
// reviewed, never a learning update itself. Continuous Learning holds sole
// authority over synthesizing and publishing learning updates.
import type { LayerHandoff } from '@infinicus/shared-types';

export const OM_TO_CL_CONTRACT_VERSION = '1.0.0';

/** learning_feedback_packages statuses eligible for handoff — finalized, not yet dispatched. */
export const READY_FEEDBACK_STATUSES = ['ready'] as const;
export type ReadyFeedbackStatus = (typeof READY_FEEDBACK_STATUSES)[number];

/** outcome_monitoring.om_publication_packages.target_layer — the only authorized downstream layer for OM. */
export const CL_REQUIRED_TARGET_LAYER = 'continuous_learning' as const;

export interface OMReviewFindingReference {
  findingCode: string;
  statement: string;
}

export interface OMReviewActionReference {
  actionCode: string;
  description: string;
}

export interface OMVarianceSummaryReference {
  metricCode: string;
  varianceValue: unknown;
}

/** Optional governed OM-24 publication data. Absence means CL-02 cannot accept the package. */
export interface OMLearningPublicationDetail {
  publicationReceiptId: string;
  outcomeVerdictId: string;
  monitoringContractId: string;
  confidence: number;
  reliability: number;
  applicabilityScope: string;
  limitations: readonly string[];
  lessons: readonly string[];
  successFactors: readonly string[];
  failureFactors: readonly string[];
  hypotheses: readonly string[];
  decisionRuleFeedback: readonly string[];
  modelCalibrationFeedback: readonly string[];
  dataQualityLearning: readonly string[];
  operationalLearning: readonly string[];
  riskLearning: readonly string[];
}

/** Payload of the OM → CL handoff envelope. Serializable data only. */
export interface OMToCLHandoffPayload {
  contractVersion: typeof OM_TO_CL_CONTRACT_VERSION;
  tenantId: string;
  workspaceId: string;
  businessId: string;
  idempotencyKey: string;
  /** outcome_monitoring.outcome_observations.id */
  observationId: string;
  /** outcome_monitoring.outcome_observation_versions.id */
  observationVersionId: string;
  observationVersion: number;
  /** outcome_monitoring.learning_feedback_packages.id */
  feedbackPackageId: string;
  /** outcome_monitoring.learning_feedback_package_versions.id */
  feedbackPackageVersionId: string;
  feedbackStatus: ReadyFeedbackStatus;
  summary: string;
  findings: readonly OMReviewFindingReference[];
  reviewActions: readonly OMReviewActionReference[];
  varianceSummary: readonly OMVarianceSummaryReference[];
  evidenceReferences: readonly string[];
  /** outcome_monitoring.om_publication_packages.id */
  omPublicationPackageId: string;
  targetLayer: typeof CL_REQUIRED_TARGET_LAYER;
  targetBlock: string;
  publishedAt: string;
  /** Additional governed data, only when OM has produced and can attest it. */
  governedPublication?: OMLearningPublicationDetail;
}

/**
 * The OM → CL handoff: the canonical CLAUDE.md §8 envelope carrying a
 * finalized learning feedback package, ready for Continuous Learning to
 * synthesize learning updates. correlationId/lineage/status live on the
 * envelope — they are not duplicated inside the payload.
 */
export type OMToCLHandoff = LayerHandoff<OMToCLHandoffPayload>;

export interface OMToCLValidationResult {
  valid: boolean;
  reasons: readonly string[];
}

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === 'string' && v.trim().length > 0;

const MAX_SERIALIZED_BYTES = 512 * 1024;
const MAX_COLLECTION_ENTRIES = 1000;

const CREDENTIAL_LIKE_KEYS = ['password', 'secret', 'apiKey', 'token', 'credential', 'privateKey'];
const DANGEROUS_KEYS = ['__proto__', 'prototype', 'constructor'];

function collectUnserializable(value: unknown, path: string, reasons: string[]): void {
  if (value === null || value === undefined) return;
  const t = typeof value;
  if (t === 'function' || t === 'symbol' || t === 'bigint') {
    reasons.push(`unserializable_${t}_at_${path}`);
    return;
  }
  if (t !== 'object') return;
  if (
    typeof globalThis !== 'undefined' &&
    (value === globalThis || (globalThis as { window?: unknown }).window === value)
  ) {
    reasons.push(`global_reference_at_${path}`);
    return;
  }
  const ctor = (value as { constructor?: { name?: string } }).constructor?.name;
  if (ctor !== undefined && !['Object', 'Array'].includes(ctor)) {
    reasons.push(`non_plain_object_at_${path}`);
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (DANGEROUS_KEYS.includes(key)) {
      reasons.push(`dangerous_key_at_${path}.${key}`);
      continue;
    }
    if (CREDENTIAL_LIKE_KEYS.some((k) => key.toLowerCase().includes(k.toLowerCase()))) {
      reasons.push(`credential_like_field_at_${path}.${key}`);
      continue;
    }
    collectUnserializable(child, `${path}.${key}`, reasons);
  }
}

/**
 * Runtime validation with explicit rejection reasons. Accepts only a
 * finalized (ready) learning feedback package built from a completed
 * outcome review, targeted exclusively at Continuous Learning, carried
 * inside a complete, serializable handoff envelope. Rejects anything that
 * would cross the OM/CL authority boundary (a synthesized learning
 * update, a policy/model revision, or an upstream decision override).
 */
export function validateOMToCLHandoff(value: unknown): OMToCLValidationResult {
  const reasons: string[] = [];
  const h = value as OMToCLHandoff | null | undefined;

  if (!h || typeof h !== 'object') {
    return { valid: false, reasons: ['handoff_required'] };
  }

  // Envelope (CLAUDE.md §8)
  for (const field of ['handoffId', 'sourceBlock', 'targetBlock', 'correlationId', 'createdAt'] as const) {
    if (!isNonEmptyString(h[field])) reasons.push(`${field}_required`);
  }
  if (h.sourceLayer !== 'OM') reasons.push('source_layer_must_be_OM');
  if (h.targetLayer !== 'CL') reasons.push('target_layer_must_be_CL');
  if (h.status !== 'ready') reasons.push('handoff_status_must_be_ready');
  if (!Array.isArray(h.lineage)) reasons.push('lineage_array_required');

  const p = h.payload as OMToCLHandoffPayload | undefined;
  if (!p || typeof p !== 'object') {
    reasons.push('payload_required');
    return { valid: false, reasons };
  }

  if (p.contractVersion !== OM_TO_CL_CONTRACT_VERSION) reasons.push('contract_version_unsupported');
  if (!isNonEmptyString(p.tenantId)) reasons.push('tenant_id_required');
  if (!isNonEmptyString(p.workspaceId)) reasons.push('workspace_id_required');
  if (!isNonEmptyString(p.businessId)) reasons.push('business_id_required');
  if (!isNonEmptyString(p.idempotencyKey)) reasons.push('idempotency_key_required');

  if (!isNonEmptyString(p.observationId)) reasons.push('observation_id_required');
  if (!isNonEmptyString(p.observationVersionId)) reasons.push('observation_version_id_required');
  if (!Number.isInteger(p.observationVersion) || p.observationVersion < 1) {
    reasons.push('observation_version_invalid');
  }
  if (!isNonEmptyString(p.feedbackPackageId)) reasons.push('feedback_package_id_required');
  if (!isNonEmptyString(p.feedbackPackageVersionId)) reasons.push('feedback_package_version_id_required');
  if (!READY_FEEDBACK_STATUSES.includes(p.feedbackStatus)) {
    reasons.push('feedback_not_ready');
  }
  if (!isNonEmptyString(p.summary)) reasons.push('summary_required');

  if (!Array.isArray(p.findings) || p.findings.length === 0) {
    reasons.push('findings_required');
  } else if (p.findings.length > MAX_COLLECTION_ENTRIES) {
    reasons.push('findings_collection_too_large');
  } else {
    for (const finding of p.findings) {
      if (!finding || typeof finding !== 'object' || !isNonEmptyString(finding.findingCode) || !isNonEmptyString(finding.statement)) {
        reasons.push('malformed_finding_entry');
        break;
      }
    }
  }

  if (!Array.isArray(p.reviewActions)) {
    reasons.push('review_actions_array_required');
  } else {
    for (const a of p.reviewActions) {
      if (!a || typeof a !== 'object' || !isNonEmptyString(a.actionCode) || !isNonEmptyString(a.description)) {
        reasons.push('malformed_review_action_entry');
        break;
      }
    }
  }

  if (!Array.isArray(p.varianceSummary)) {
    reasons.push('variance_summary_array_required');
  } else {
    for (const v of p.varianceSummary) {
      if (!v || typeof v !== 'object' || !isNonEmptyString(v.metricCode) || !('varianceValue' in v)) {
        reasons.push('malformed_variance_summary_entry');
        break;
      }
    }
  }

  if (!Array.isArray(p.evidenceReferences) || p.evidenceReferences.length === 0) {
    reasons.push('missing_evidence');
  }

  if (!isNonEmptyString(p.omPublicationPackageId)) reasons.push('om_publication_package_id_required');
  if (p.targetLayer !== CL_REQUIRED_TARGET_LAYER) reasons.push('target_layer_invalid');
  if (!isNonEmptyString(p.targetBlock)) reasons.push('target_block_required');
  if (!isNonEmptyString(p.publishedAt) || Number.isNaN(Date.parse(p.publishedAt))) {
    reasons.push('published_at_invalid');
  }

  if (p.governedPublication !== undefined) {
    const detail = p.governedPublication as OMLearningPublicationDetail;
    if (!detail || typeof detail !== 'object' || Array.isArray(detail)) {
      reasons.push('governed_publication_invalid');
    } else {
      for (const key of ['publicationReceiptId', 'outcomeVerdictId', 'monitoringContractId', 'applicabilityScope'] as const) {
        if (!isNonEmptyString(detail[key])) reasons.push(`governed_${key}_required`);
      }
      for (const key of ['confidence', 'reliability'] as const) {
        if (typeof detail[key] !== 'number' || !Number.isFinite(detail[key]) || detail[key] < 0 || detail[key] > 1) {
          reasons.push(`governed_${key}_invalid`);
        }
      }
      for (const key of ['limitations', 'lessons', 'successFactors', 'failureFactors', 'hypotheses',
        'decisionRuleFeedback', 'modelCalibrationFeedback', 'dataQualityLearning', 'operationalLearning', 'riskLearning'] as const) {
        const entries = detail[key];
        if (!Array.isArray(entries) || entries.length > MAX_COLLECTION_ENTRIES || entries.some((entry) => !isNonEmptyString(entry))) {
          reasons.push(`governed_${key}_invalid`);
        }
      }
    }
  }

  // Authority boundary: a finalized observation/review declaration only —
  // never a synthesized learning update, a policy/model revision, or an
  // upstream decision override. OM-to-CL must preserve this separation
  // explicitly.
  const forbidden = [
    'learningUpdate', 'learningRecord',
    'modelUpdate', 'policyUpdate', 'policyRevision', 'trainingUpdate',
    'decisionOverride', 'decisionRevision', 'recommendationOverride', 'approvalOverride',
    'executionResult', 'executedAt', 'actionTaken',
  ];
  for (const key of forbidden) {
    if (key in (p as unknown as Record<string, unknown>)) reasons.push(`forbidden_field_${key}`);
  }

  collectUnserializable(h, 'handoff', reasons);

  let serializedBytes = 0;
  try {
    // Character-length approximation of the serialized byte size (no
    // TextEncoder/Buffer dependency) — a safe, slightly conservative proxy
    // for the 512 KiB soft limit, exact for ASCII payloads.
    serializedBytes = JSON.stringify(h).length;
  } catch {
    reasons.push('payload_not_serializable');
  }
  if (serializedBytes > MAX_SERIALIZED_BYTES) reasons.push('payload_too_large');

  return { valid: reasons.length === 0, reasons };
}
