/**
 * Shared types for the Data Acquisition runtime (BUILD-31 §4).
 */

// ── Manual JSON intake (§4.5) ────────────────────────────────────────────────

export interface ManualIntakeRequest {
  businessId: string;
  dataSourceId: string;
  connectorId?: string;
  submissionType: string;
  records: unknown[];
  submissionNotes?: string;
  sourceReference?: string;
  metadata?: Record<string, unknown>;
  submittedBy?: string;
  correlationId?: string;
}

/**
 * §4.5 step 14: "return the run summary." Deliberately does not include the
 * raw records or per-record payloads — those stay behind their own read
 * endpoints (validation results, provenance), matching §5.6's "sensitive-
 * data fields not required by the endpoint" rule.
 */
export interface ManualIntakeResult {
  collectionRunId: string;
  state: string;
  manualSubmissionId: string;
  recordsReceived: number;
  recordsAccepted: number;
  recordsRejected: number;
  validationResultId: string;
  qualityScoreId: string | null;
  provenanceIds: string[];
  correlationId: string;
}

// ── Validation (§4.9) ────────────────────────────────────────────────────────

export type ValidationSeverity = 'error' | 'warning';

export interface RecordValidationIssue {
  ruleCode: string;
  fieldPath: string | null;
  severity: ValidationSeverity;
  issueType: string;
  message: string;
  observedValue?: unknown;
  expectedValue?: unknown;
}

export interface RecordValidationOutcome {
  /** Index into the original records array — the "record reference" for a manual submission. */
  recordIndex: number;
  isValid: boolean;
  errorCount: number;
  warningCount: number;
  issues: RecordValidationIssue[];
  /**
   * Deterministic canonical representation, used for duplicate detection
   * across the batch. Present even for invalid records so a caller can
   * still detect "this invalid record is also a duplicate of another."
   */
  canonicalKey: string;
}

export interface BatchValidationOutcome {
  records: RecordValidationOutcome[];
  totalErrorCount: number;
  totalWarningCount: number;
  duplicateRecordIndexes: number[];
  allValid: boolean;
}

// ── Quality scoring (§4.10) ──────────────────────────────────────────────────

export interface QualityDimensionScores {
  completeness: number;
  validity: number;
  consistency: number;
  timeliness: number;
  uniqueness: number;
  conformity: number;
}

export type QualityClassification = 'excellent' | 'acceptable' | 'degraded' | 'unacceptable';

export interface QualityScoreResult extends QualityDimensionScores {
  overallScore: number;
  classification: QualityClassification;
  weights: QualityDimensionScores;
}

// ── Provenance (§4.11) ───────────────────────────────────────────────────────

export interface ProvenanceInput {
  dataSourceId: string;
  businessId?: string;
  collectionRunId?: string;
  recordReference: string;
  sourceReference: string;
  record: unknown;
  /** R-01A: the prepared (normalized) form of `record`. When present, a 'normalize' transformation (raw hash -> prepared hash) is recorded. */
  preparedRecord?: unknown;
  /** R-01A: normalization rules applied (field + rule only; never values). */
  preparationActions?: ReadonlyArray<{ field: string; rule: string }>;
  parentProvenanceId?: string;
  correlationId?: string;
}
