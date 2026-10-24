/**
 * CL-ACT-06D preparatory audit integrity rehearsal.
 * Pure verification over synthetic/external records: no persistence, authority,
 * permission grants, publication, or production feature activation.
 */
import { createHash } from 'node:crypto';

export interface ShadowAuditChainRecord {
  readonly sequence: number;
  readonly predecessorDigest: string | null;
  readonly recordDigest: string;
  readonly canonicalPayload: string;
}
export type ShadowAuditChainResult = Readonly<{
  structurallyConsistent: boolean;
  auditAcceptedAsAuthority: false;
  persisted: false;
  reasons: readonly string[];
}>;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** Caller must supply a canonical, versioned payload; this checks chain integrity, not provenance. */
export function verifyProposedShadowAuditChain(records: readonly ShadowAuditChainRecord[]): ShadowAuditChainResult {
  const reasons: string[] = [];
  if (!Array.isArray(records) || records.length === 0) reasons.push('EMPTY_CHAIN');
  else {
    let previous: string | null = null;
    for (let index = 0; index < records.length; index += 1) {
      const r = records[index];
      if (!r || !Number.isSafeInteger(r.sequence) || r.sequence !== index + 1) reasons.push('INVALID_SEQUENCE');
      if (!r || r.predecessorDigest !== previous) reasons.push('BROKEN_LINK');
      if (!r || typeof r.canonicalPayload !== 'string' || r.canonicalPayload.length === 0 ||
          r.canonicalPayload.length > 65536 || !DIGEST.test(r.recordDigest)) {
        reasons.push('INVALID_RECORD');
        previous = r?.recordDigest ?? null;
        continue;
      }
      const expected = 'sha256:' + createHash('sha256').update(
        JSON.stringify({ sequence: r.sequence, predecessorDigest: r.predecessorDigest, canonicalPayload: r.canonicalPayload }),
        'utf8'
      ).digest('hex');
      if (expected !== r.recordDigest) reasons.push('DIGEST_MISMATCH');
      previous = r.recordDigest;
    }
  }
  return Object.freeze({
    structurallyConsistent: reasons.length === 0,
    auditAcceptedAsAuthority: false,
    persisted: false,
    reasons: Object.freeze([...new Set(reasons)]),
  });
}
