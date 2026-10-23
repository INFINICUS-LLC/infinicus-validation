/** CL-02: validate governed publication detail after the OM learning gate has released the handoff. */
import type { OMToCLHandoff, OMLearningPublicationDetail } from '@infinicus/handoff-contracts';
import { createHash } from 'node:crypto';

export interface CL02Decision {
  status: 'rejected';
  reasons: readonly string[];
  governedPublicationDigest?: string;
}

const arrayFields = ['limitations', 'lessons', 'successFactors', 'failureFactors', 'hypotheses',
  'decisionRuleFeedback', 'modelCalibrationFeedback', 'dataQualityLearning', 'operationalLearning', 'riskLearning'] as const;
const textFields = ['publicationReceiptId', 'outcomeVerdictId', 'monitoringContractId', 'applicabilityScope'] as const;
const nonblank = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

export function validateCL02Publication(handoff: OMToCLHandoff): CL02Decision {
  const detail: OMLearningPublicationDetail | undefined = handoff.payload.governedPublication;
  if (detail === undefined) return { status: 'rejected', reasons: ['CL02_GOVERNED_PUBLICATION_MISSING'] };
  const reasons: string[] = [];
  if (handoff.sourceBlock !== 'OM-24') reasons.push('CL02_SOURCE_BLOCK_INVALID');
  if (handoff.targetBlock !== 'CL-01' || handoff.payload.targetBlock !== 'CL-01') reasons.push('CL02_TARGET_BLOCK_INVALID');
  for (const field of textFields) if (!nonblank(detail[field])) reasons.push(`CL02_${field}_INVALID`);
  for (const field of ['confidence', 'reliability'] as const) {
    const score = detail[field];
    if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) reasons.push(`CL02_${field}_INVALID`);
  }
  for (const field of arrayFields) {
    const entries = detail[field];
    if (!Array.isArray(entries) || entries.length > 1000 || entries.some((entry) => !nonblank(entry))) reasons.push(`CL02_${field}_INVALID`);
  }
  // OM-24 receipt and verdict have no authoritative persistence/verification source yet.
  // Shape alone must never turn caller-supplied claims into accepted learning.
  reasons.push('CL02_GOVERNED_SOURCE_UNVERIFIED');
  return { status: 'rejected', reasons,
    governedPublicationDigest: `sha256:${createHash('sha256').update(JSON.stringify(detail)).digest('hex')}` };
}
