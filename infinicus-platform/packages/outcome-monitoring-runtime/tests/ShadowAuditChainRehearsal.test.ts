import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyProposedShadowAuditChain, type ShadowAuditChainRecord } from '../src/ShadowAuditChainRehearsal.js';
const make = (sequence: number, predecessorDigest: string | null, canonicalPayload: string): ShadowAuditChainRecord => ({
  sequence, predecessorDigest, canonicalPayload,
  recordDigest: 'sha256:' + createHash('sha256').update(JSON.stringify({
    sequence, predecessorDigest, canonicalPayload,
  }), 'utf8').digest('hex'),
});
describe('CL-ACT-06D proposed audit chain integrity (no persistence)', () => {
  it('accepts a consistent synthetic chain without granting audit or operator authority', () => {
    const first = make(1, null, '{"version":"cl-shadow-audit/1","event":"REQUESTED"}');
    const second = make(2, first.recordDigest, '{"version":"cl-shadow-audit/1","event":"REFUSED"}');
    const result = verifyProposedShadowAuditChain([first, second]);
    expect(result).toEqual({ structurallyConsistent: true, auditAcceptedAsAuthority: false, persisted: false, reasons: [] });
    expect(Object.isFrozen(result)).toBe(true);
  });
  it('rejects tampering, omission, reordering and broken predecessor links', () => {
    const a = make(1, null, 'request');
    const b = make(2, a.recordDigest, 'refusal');
    for (const chain of [
      [a, { ...b, canonicalPayload: 'approval' }],
      [b],
      [b, a],
      [a, { ...b, predecessorDigest: null }],
      [a, { ...b, sequence: 3 }],
    ]) {
      const result = verifyProposedShadowAuditChain(chain);
      expect(result.structurallyConsistent).toBe(false);
      expect(result.auditAcceptedAsAuthority).toBe(false);
      expect(result.persisted).toBe(false);
    }
  });
  it('refuses empty and malformed records', () => {
    expect(verifyProposedShadowAuditChain([]).reasons).toContain('EMPTY_CHAIN');
    expect(verifyProposedShadowAuditChain([{ sequence: 1, predecessorDigest: null, canonicalPayload: '', recordDigest: 'bad' }]).structurallyConsistent).toBe(false);
  });
});
