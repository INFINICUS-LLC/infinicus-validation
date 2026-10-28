/**
 * Reconstruction and independent verification of a PERSISTED DT -> SIM hand-off (NEW-BDT-SIM-01.SEC-01, defect D2). Pure and database-free.
 *
 * The database (`dt_handoff_envelopes` + `twin_confidence_scores`) is the source of truth; an HTTP response is not. Given the stored rows this proves, without
 * trusting the service that wrote them: the envelope still matches its SHA-256 digest, still satisfies the FROZEN `dt-to-sim` contract, belongs to the expected
 * tenant, workspace and business, agrees with the recorded columns, and rests on the recorded confidence score and its complete seven-factor basis.
 */
import { DT_TO_SIM_CONTRACT_VERSION, validateDTToSIMHandoff, type DTToSIMHandoff } from '@infinicus/handoff-contracts';
import type { DTHandoffEnvelopeRecord, TwinConfidenceScore } from '@infinicus/database';
import { digestOf } from './biPerformanceEvidence.js';
import { TWIN_CONFIDENCE_FACTORS } from './twinConfidencePolicy.js';

export const PERFORMANCE_HANDOFF_SCHEMA_VERSION = 'dt-to-sim-performance-handoff/1';

export const handoffDigest = (handoff: DTToSIMHandoff): string => digestOf(handoff);

export interface PersistedHandoffExpectation { tenantId: string; workspaceId: string; businessId: string }

export function verifyPersistedHandoff(record: DTHandoffEnvelopeRecord, score: TwinConfidenceScore | null, expected: PersistedHandoffExpectation): { valid: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (digestOf(record.envelope) !== record.envelopeDigest) reasons.push('envelope_digest_mismatch');
  const frozen = validateDTToSIMHandoff(record.envelope);
  if (!frozen.valid) reasons.push(...frozen.reasons.map((r) => `frozen_contract:${r}`));
  const h = record.envelope as Partial<DTToSIMHandoff> | null;
  const p = h?.payload;
  if (record.tenantId !== expected.tenantId || record.workspaceId !== expected.workspaceId || record.businessId !== expected.businessId) reasons.push('record_scope_mismatch');
  if (p) {
    if (p.tenantId !== record.tenantId || p.workspaceId !== record.workspaceId || p.businessId !== record.businessId) reasons.push('envelope_scope_mismatch');
    if (h?.handoffId !== record.dtPublicationPackageId) reasons.push('handoff_id_is_not_the_package');
    if (p.contractVersion !== record.contractVersion || record.contractVersion !== DT_TO_SIM_CONTRACT_VERSION) reasons.push('contract_version_mismatch');
  }
  if (record.schemaVersion !== PERFORMANCE_HANDOFF_SCHEMA_VERSION) reasons.push('schema_version_unsupported');
  if (score === null || score.id !== record.confidenceScoreId) reasons.push('confidence_score_missing');
  else {
    if (score.tenantId !== record.tenantId || score.workspaceId !== record.workspaceId || score.businessId !== record.businessId || score.snapshotVersionId !== record.snapshotVersionId) reasons.push('confidence_score_scope_mismatch');
    if (p?.quality?.confidence !== score.confidence) reasons.push('envelope_confidence_differs_from_recorded_score');
    try {
      const basis = JSON.parse(score.basis) as { kind?: string; score?: number; methodology?: { id?: string; version?: string; ratification?: string }; factors?: { factor?: string; evidenceRef?: string }[] };
      const factors = (basis.factors ?? []).map((f) => f.factor);
      if (basis.kind !== 'twin-confidence' || basis.score !== score.confidence) reasons.push('confidence_basis_mismatch');
      if (!basis.methodology?.id || !basis.methodology.version || !basis.methodology.ratification) reasons.push('confidence_methodology_missing');
      if (TWIN_CONFIDENCE_FACTORS.some((f) => !factors.includes(f)) || factors.length !== TWIN_CONFIDENCE_FACTORS.length || (basis.factors ?? []).some((f) => !f.evidenceRef)) reasons.push('confidence_basis_incomplete');
    } catch { reasons.push('confidence_basis_unreadable'); }
  }
  return { valid: reasons.length === 0, reasons };
}
