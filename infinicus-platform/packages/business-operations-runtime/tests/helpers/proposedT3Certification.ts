/** BO-PUB-DEV-02A-R4: test-only, non-authoritative T3 certification model.
 * It has no publisher identity, permission grant, persistence adapter, or route.
 */
import {
  canonicalJson as evidenceCanonicalJson, verifyInventoryMovementEvidence,
  type InventoryMovementEvidence,
} from '../../src/publication/record-evidence/inventoryMovementEvidence.js';

export interface ProposedHeader {
  id: string;
  tenantId: string;
  workspaceId: string;
  businessId: string;
  periodStart: string;
  periodEnd: string;
  recordCount: number;
  version: number;
  status: 'ready' | 'dispatched' | 'received' | 'cancelled';
  targetLayer: 'business_intelligence';
}
export interface ProposedStoredEvidence {
  headerId: string;
  headerVersion: number;
  artifact: InventoryMovementEvidence;
}
export type ProposedT3Decision =
  | { status: 'PROPOSED_NOT_ACTIVE'; code: 'STORE_CANDIDATE' | 'IDENTICAL_REPLAY' | 'STRUCTURAL_DISPATCH_CANDIDATE' }
  | { status: 'PROPOSED_NOT_ACTIVE'; code: 'HEADER_INVALID' | 'ARTIFACT_INVALID' | 'HEADER_MISMATCH' | 'STALE_HEADER' | 'EVIDENCE_MISSING' | 'CONFLICTING_EVIDENCE' };

const result = (code: ProposedT3Decision['code']): ProposedT3Decision => ({ status: 'PROPOSED_NOT_ACTIVE', code });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const canonicalBody = (a: InventoryMovementEvidence): string => evidenceCanonicalJson({
  contract: a.contract, recordSchemaVersion: a.recordSchemaVersion, scope: a.scope,
  source: a.source, ordering: a.ordering, recordCount: a.recordCount, records: a.records,
});

function validHeader(h: ProposedHeader): boolean {
  return UUID.test(h.id) && UUID.test(h.tenantId) && UUID.test(h.workspaceId) && UUID.test(h.businessId)
    && Number.isSafeInteger(h.recordCount) && h.recordCount >= 0
    && Number.isSafeInteger(h.version) && h.version > 0
    && h.periodStart < h.periodEnd && h.targetLayer === 'business_intelligence';
}
function matches(h: ProposedHeader, a: InventoryMovementEvidence): boolean {
  return a.source.boPublicationPackageId === h.id && a.scope.tenantId === h.tenantId
    && a.scope.workspaceId === h.workspaceId && a.scope.businessId === h.businessId
    && a.source.periodStart === h.periodStart && a.source.periodEnd === h.periodEnd
    && a.recordCount === h.recordCount;
}

/** Candidate store/replay decision. A positive code is structural only; it grants no write or dispatch authority. */
export function assessProposedBinding(h: ProposedHeader, a: InventoryMovementEvidence, stored: ProposedStoredEvidence | null): ProposedT3Decision {
  if (!validHeader(h)) return result('HEADER_INVALID');
  if (!verifyInventoryMovementEvidence(a).ok) return result('ARTIFACT_INVALID');
  if (!matches(h, a)) return result('HEADER_MISMATCH');
  if (stored) {
    if (stored.headerId !== h.id || !verifyInventoryMovementEvidence(stored.artifact).ok || !matches(h, stored.artifact))
      return result('CONFLICTING_EVIDENCE');
    if (stored.headerVersion > h.version || (h.status === 'ready' && stored.headerVersion !== h.version))
      return result('STALE_HEADER');
    return stored.artifact.evidenceId === a.evidenceId && stored.artifact.digest.value === a.digest.value
      && canonicalBody(stored.artifact) === canonicalBody(a)
      ? result('IDENTICAL_REPLAY') : result('CONFLICTING_EVIDENCE');
  }
  return h.status === 'ready' ? result('STORE_CANDIDATE') : result('STALE_HEADER');
}

/** No return value can authorize a ready-to-dispatched write. */
export function assessProposedDispatch(h: ProposedHeader, stored: ProposedStoredEvidence | null): ProposedT3Decision {
  if (!validHeader(h)) return result('HEADER_INVALID');
  if (h.status !== 'ready') return result('STALE_HEADER');
  if (!stored) return result('EVIDENCE_MISSING');
  const binding = assessProposedBinding(h, stored.artifact, stored);
  return binding.code === 'IDENTICAL_REPLAY' ? result('STRUCTURAL_DISPATCH_CANDIDATE') : binding;
}
