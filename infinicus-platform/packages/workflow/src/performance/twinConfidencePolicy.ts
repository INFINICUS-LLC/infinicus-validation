/**
 * The Twin Confidence gate of the DT -> SIM performance hand-off (NEW-BDT-SIM-01.SEC-01, defect D1). Pure and database-free.
 *
 * WHAT THE FROZEN SPECIFICATIONS DEFINE (and this module encodes - nothing more):
 *  - Business Digital Twin locked spec section 15: Twin Confidence is a transparent measure derived from SEVEN named factors (below).
 *  - layer-handoff-contracts section 29: the default DT -> SIM confidence threshold is 0.75, a platform minimum that tenant policy may raise but never lower.
 *  - The frozen `dt-to-sim` contract: `quality.confidence` is a number in 0..1.
 * WHAT THEY DO NOT DEFINE: any formula, weight, scale or per-factor measurement. No score is therefore computed here. The score must come from an explicit,
 * owner-ratified methodology supplied through the `TwinConfidencePolicy` port; until one is ratified the production policy is `UnratifiedTwinConfidencePolicy`,
 * which assesses nothing, so the hand-off stays CLOSED (default deny). Evidence integrity (digests, cross-checks) is a precondition of the hand-off, not a
 * confidence; and Twin Confidence is evidence-state quality, not a forecast.
 */
import type { BiPerformanceEvidence } from '@infinicus/handoff-contracts';
import type { TenantContext } from '@infinicus/database';
import { canonicalJson } from './biPerformanceEvidence.js';

export const TWIN_CONFIDENCE_FACTORS = [
  'DATA_COMPLETENESS', 'DATA_FRESHNESS', 'DATA_QUALITY', 'HISTORICAL_DEPTH', 'MODEL_CALIBRATION', 'DEPENDENCY_COVERAGE', 'SOURCE_RELIABILITY',
] as const;
export type TwinConfidenceFactor = (typeof TWIN_CONFIDENCE_FACTORS)[number];

/** layer-handoff-contracts section 29, "DT -> SIM confidence: 0.75". A platform minimum: a policy may raise it, never lower it. */
export const DT_TO_SIM_MIN_CONFIDENCE = 0.75;

export interface TwinConfidenceFactorBasis {
  factor: TwinConfidenceFactor;
  /** A reference to the recorded evidence the factor's contribution rests on (never free-floating). */
  evidenceRef: string;
}
export interface TwinConfidenceMethodology {
  id: string;
  version: string;
  /** Where the owner ratified this methodology. */
  ratification: string;
}
export type TwinConfidenceAssessment =
  | { status: 'ASSESSED'; score: number; methodology: TwinConfidenceMethodology; factors: TwinConfidenceFactorBasis[] }
  | { status: 'UNAVAILABLE'; reason: string };

export interface TwinConfidenceInput { businessId: string; snapshotId: string; evidence: BiPerformanceEvidence }
/** The one port through which a ratified Twin Confidence methodology enters. */
export interface TwinConfidencePolicy { assess(ctx: TenantContext, input: TwinConfidenceInput): Promise<TwinConfidenceAssessment> }

/** The production policy while no methodology is ratified: it assesses nothing, so no hand-off can pass the gate. */
export class UnratifiedTwinConfidencePolicy implements TwinConfidencePolicy {
  async assess(): Promise<TwinConfidenceAssessment> {
    return { status: 'UNAVAILABLE', reason: 'no Twin Confidence methodology has been ratified by the owner (BDT locked spec section 15 lists factors but defines no formula)' };
  }
}

export type ConfidenceRefusalCode = 'CONFIDENCE_UNAVAILABLE' | 'CONFIDENCE_BASIS_INCOMPLETE' | 'CONFIDENCE_UNSUPPORTED' | 'CONFIDENCE_BELOW_THRESHOLD';
export type ConfidenceGateResult =
  | { ok: true; score: number; basis: string; methodology: TwinConfidenceMethodology }
  | { ok: false; code: ConfidenceRefusalCode; detail: string };

const decimals = (n: number): number => { const s = String(n); const i = s.indexOf('.'); return i < 0 ? 0 : s.length - i - 1; };
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/**
 * Applies the gate to an assessment: it must exist, name its ratified methodology, account for ALL seven factors exactly once each with recorded evidence (an
 * unavailable factor is never silently counted as complete), carry a score representable in the twin_confidence_scores column (0..1, at most four decimals) and
 * meet the threshold. `minimum` may be raised by policy but never below the platform minimum.
 */
export function evaluateConfidenceGate(assessment: TwinConfidenceAssessment, minimum: number = DT_TO_SIM_MIN_CONFIDENCE): ConfidenceGateResult {
  if (!Number.isFinite(minimum) || minimum < DT_TO_SIM_MIN_CONFIDENCE || minimum > 1) {
    return { ok: false, code: 'CONFIDENCE_UNSUPPORTED', detail: `the confidence threshold must be between the platform minimum ${DT_TO_SIM_MIN_CONFIDENCE} and 1` };
  }
  if (assessment.status !== 'ASSESSED') return { ok: false, code: 'CONFIDENCE_UNAVAILABLE', detail: assessment.reason };
  const m = assessment.methodology;
  if (!m || !text(m.id) || !text(m.version) || !text(m.ratification)) {
    return { ok: false, code: 'CONFIDENCE_UNSUPPORTED', detail: 'the assessment does not name a ratified methodology (id, version, ratification)' };
  }
  const seen = new Map<string, string>();
  for (const f of assessment.factors ?? []) {
    if (!TWIN_CONFIDENCE_FACTORS.includes(f?.factor) || !text(f.evidenceRef) || seen.has(f.factor)) {
      return { ok: false, code: 'CONFIDENCE_BASIS_INCOMPLETE', detail: `an unknown, duplicated or evidence-less factor was supplied: ${String(f?.factor)}` };
    }
    seen.set(f.factor, f.evidenceRef);
  }
  const missing = TWIN_CONFIDENCE_FACTORS.filter((f) => !seen.has(f));
  if (missing.length > 0) return { ok: false, code: 'CONFIDENCE_BASIS_INCOMPLETE', detail: `the basis does not account for: ${missing.join(', ')}` };
  const score = assessment.score;
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1 || decimals(score) > 4) {
    return { ok: false, code: 'CONFIDENCE_UNSUPPORTED', detail: 'the score must be a number from 0 to 1 with at most four decimals' };
  }
  if (score < minimum) return { ok: false, code: 'CONFIDENCE_BELOW_THRESHOLD', detail: `Twin Confidence ${score} is below the required ${minimum}` };
  const factors = TWIN_CONFIDENCE_FACTORS.map((factor) => ({ factor, evidenceRef: seen.get(factor)! }));
  return { ok: true, score, methodology: m, basis: canonicalJson({ kind: 'twin-confidence', methodology: m, score, factors }) };
}
