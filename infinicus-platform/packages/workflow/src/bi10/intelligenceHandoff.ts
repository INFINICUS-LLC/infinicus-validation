/**
 * BI-10 -> BI-11..BI-18 intelligence hand-off (BI-2-DEV-06), frozen contract "BI-10 to BI-11–BI-18": calculation run ID, metric result IDs, metric values,
 * dimensional groups, time buckets, units, target status, threshold status, source row counts, correlation ID. Pure and deterministic like the calculation:
 * no clock, no random id, no I/O, nothing stored or published.
 *
 * The run is checked before anything is handed on: its id must be the one derived from its hand-off id and the datasets it read, every result id must be the one
 * derived from that run, metric version and group, and every value, status and count must be internally consistent. A run that was altered, or that does not
 * add up, is refused - downstream blocks never receive a number this module cannot account for. The package identity covers the results themselves
 * (resultsFingerprint), so it names exactly what was handed over.
 *
 * Same differences from the frozen JavaScript as the calculation (docs/bi-metric-calculation.md): the frozen hand-off had a random id and `createdAt` from the
 * clock; this one carries the stored source timestamp of the BI-09 hand-off (`handoffSourceTimestamp`). A run with no results is refused instead of published empty.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../bi/metricDefinition.js';
import { deterministicUuid } from '../bi/metricRegistry.js';
import { parseDecimal, decimalToString } from './exactDecimal.js';
import { deriveCalculationRunId, deriveMetricResultId, type CalculationRun, type MetricResult } from './metricCalculation.js';

/** The frozen engine addresses every intelligence-domain block; routing by domain is not part of the frozen contract. */
export const INTELLIGENCE_TARGET_BLOCKS = ['BI-11', 'BI-12', 'BI-13', 'BI-14', 'BI-15', 'BI-16', 'BI-17', 'BI-18'] as const;

export type IntelligenceHandoffErrorCode = 'RUN_INVALID' | 'RUN_IDENTITY_MISMATCH' | 'RESULT_INVALID' | 'RUN_HAS_NO_RESULTS';
export interface IntelligenceHandoffFailure { ok: false; code: IntelligenceHandoffErrorCode; detail: string }

export interface IntelligenceHandoff {
  intelligenceHandoffId: string;
  sourceBlock: 'BI-10';
  targetBlocks: typeof INTELLIGENCE_TARGET_BLOCKS;
  calculationRunId: string;
  calculationHandoffId: string;
  warehouseSnapshotId: string | null;
  correlationId: string;
  /** The stored creation time of the newest handed-over metric version (not a calculation time and not a persisted time). */
  handoffSourceTimestamp: string;
  metricResultIds: string[];
  metricResults: MetricResult[];
  /** SHA-256 of the canonical results: what exactly this package carries. */
  resultsFingerprint: string;
  status: 'ready';
}
export type IntelligenceHandoffOutcome = { ok: true; handoff: IntelligenceHandoff } | IntelligenceHandoffFailure;

const fail = (code: IntelligenceHandoffErrorCode, detail: string): IntelligenceHandoffFailure => ({ ok: false, code, detail });
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const THRESHOLD_STATUSES = ['no_data', 'normal', 'warning', 'critical', 'good'];
const isCanonicalDecimal = (v: unknown): v is string => typeof v === 'string' && ((d) => d !== null && decimalToString(d) === v)(parseDecimal(v));

function checkResult(run: CalculationRun, r: MetricResult, index: number): IntelligenceHandoffFailure | null {
  const at = `result ${index}`;
  if (!isRecord(r) || !nonEmpty(r.metricId) || !nonEmpty(r.metricCode) || !Number.isInteger(r.metricVersion) || !nonEmpty(r.groupKey) || !isRecord(r.group)) return fail('RESULT_INVALID', `${at} is malformed.`);
  if (r.calculationRunId !== run.calculationRunId || r.calculationHandoffId !== run.calculationHandoffId) return fail('RESULT_INVALID', `${at} belongs to another run or hand-off.`);
  if (r.groupKey !== canonicalJson(r.group)) return fail('RESULT_INVALID', `${at} has a group key that does not match its group.`);
  if (r.metricResultId !== deriveMetricResultId(run.calculationRunId, r.metricId, r.metricVersion, r.groupKey)) return fail('RESULT_INVALID', `${at} has an id that does not match its run, metric version and group.`);
  if (r.value !== null && !isCanonicalDecimal(r.value)) return fail('RESULT_INVALID', `${at} has a value that is not canonical decimal text.`);
  if (r.target !== null && !isCanonicalDecimal(r.target)) return fail('RESULT_INVALID', `${at} has a target that is not canonical decimal text.`);
  if ((r.value === null) !== (r.calculationStatus === 'no_data') || (r.value !== null && r.calculationStatus !== 'completed')) return fail('RESULT_INVALID', `${at} has a status that does not match its value.`);
  if (!isRecord(r.threshold) || !THRESHOLD_STATUSES.includes(r.threshold.status as string) || (r.value === null) !== (r.threshold.status === 'no_data')) return fail('RESULT_INVALID', `${at} has a threshold status that does not match its value.`);
  if (r.threshold.targetMet !== null && typeof r.threshold.targetMet !== 'boolean') return fail('RESULT_INVALID', `${at} has a malformed target status.`);
  if (r.sourceRowCount !== null && !(Number.isInteger(r.sourceRowCount) && r.sourceRowCount >= 0)) return fail('RESULT_INVALID', `${at} has a malformed source row count.`);
  if (!nonEmpty(r.unit) || !nonEmpty(r.metricContentHash) || !nonEmpty(r.warehouseDatasetId)) return fail('RESULT_INVALID', `${at} lacks its unit, definition hash or dataset.`);
  return null;
}

export function buildIntelligenceHandoff(run: CalculationRun): IntelligenceHandoffOutcome {
  if (!isRecord(run) || !nonEmpty(run.calculationRunId) || !nonEmpty(run.calculationHandoffId) || !nonEmpty(run.correlationId) || !Array.isArray(run.datasets) || !Array.isArray(run.results)
    || !nonEmpty(run.handoffSourceTimestamp) || Number.isNaN(Date.parse(run.handoffSourceTimestamp)) || !Number.isInteger(run.metricCount) || run.metricCount < 1
    || (run.warehouseSnapshotId !== null && !nonEmpty(run.warehouseSnapshotId))) {
    return fail('RUN_INVALID', 'the calculation run is incomplete or malformed.');
  }
  if (run.calculationRunId !== deriveCalculationRunId(run.calculationHandoffId, run.datasets)) return fail('RUN_IDENTITY_MISMATCH', 'the run identity does not match its hand-off and the datasets it read.');
  if (run.results.length === 0) return fail('RUN_HAS_NO_RESULTS', 'the run produced no result to hand on.');
  const ids = new Set<string>();
  for (let i = 0; i < run.results.length; i += 1) {
    const problem = checkResult(run, run.results[i]!, i);
    if (problem) return problem;
    const id = run.results[i]!.metricResultId;
    if (ids.has(id)) return fail('RESULT_INVALID', `result ${i} repeats an id.`);
    ids.add(id);
  }
  if (new Set(run.results.map((r) => r.metricId)).size > run.metricCount) return fail('RUN_INVALID', 'the run has results for more metrics than it calculated.');
  const metricResults = structuredClone(run.results);
  const resultsFingerprint = createHash('sha256').update(canonicalJson(metricResults)).digest('hex');
  return {
    ok: true,
    handoff: {
      intelligenceHandoffId: deterministicUuid(canonicalJson({ kind: 'bi-intelligence-handoff/v1', calculationRunId: run.calculationRunId, targetBlocks: INTELLIGENCE_TARGET_BLOCKS, resultsFingerprint })),
      sourceBlock: 'BI-10',
      targetBlocks: INTELLIGENCE_TARGET_BLOCKS,
      calculationRunId: run.calculationRunId,
      calculationHandoffId: run.calculationHandoffId,
      warehouseSnapshotId: run.warehouseSnapshotId,
      correlationId: run.correlationId,
      handoffSourceTimestamp: run.handoffSourceTimestamp,
      metricResultIds: metricResults.map((r) => r.metricResultId),
      metricResults,
      resultsFingerprint,
      status: 'ready',
    },
  };
}
