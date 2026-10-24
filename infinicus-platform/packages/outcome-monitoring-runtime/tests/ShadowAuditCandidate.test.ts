import { describe, expect, it } from 'vitest';
import { preflightShadowAuditCandidate, type ShadowAuditCandidate } from '../src/ShadowAuditCandidate.js';
const ids = ['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444',
  '55555555-5555-4555-8555-555555555555','66666666-6666-4666-8666-666666666666',
  '77777777-7777-4777-8777-777777777777'];
const candidate = (): ShadowAuditCandidate => ({
  contractVersion: 'cl-shadow-audit/1', tenantId: ids[0], workspaceId: ids[1], businessId: ids[2],
  operatorId: ids[3], approverId: ids[4], assignmentId: ids[5], assignmentVersionId: ids[6],
  controlId: ids[2], controlVersion: 1, idempotencyKey: 'test-key', eventType: 'APPROVED',
  sourceDigest: `sha256:${'a'.repeat(64)}`, reasonCodes: [],
  releaseAuthorized: false, learningApplied: false, mutationsPermitted: false,
});
describe('CL-ACT-06C non-authorizing audit contract', () => {
  it('accepts a structurally valid proposal without granting authority or claiming persistence', () => {
    const r = preflightShadowAuditCandidate(candidate());
    expect(r).toEqual({ acceptedForSchemaReview: true, authorityGranted: false, auditPersisted: false, reasons: [] });
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.reasons)).toBe(true);
  });
  it('rejects self approval, missing approval lineage, malformed digest and invented authority', () => {
    const cases: Array<[Partial<ShadowAuditCandidate>, string]> = [
      [{ approverId: ids[3] }, 'APPROVAL_EVIDENCE_MISSING'],
      [{ assignmentVersionId: null }, 'APPROVAL_EVIDENCE_MISSING'],
      [{ controlVersion: 0 }, 'INVALID_CONTROL_VERSION'],
      [{ businessId: 'wrong' }, 'INVALID_SCOPE'],
      [{ sourceDigest: 'sha256:invalid' }, 'INVALID_SOURCE_DIGEST'],
      [{ releaseAuthorized: true as never }, 'FORBIDDEN_AUTHORITY'],
      [{ mutationsPermitted: true as never }, 'FORBIDDEN_AUTHORITY'],
      [{ reasonCodes: ['sensitive raw message'] }, 'INVALID_REASONS'],
    ];
    for (const [change, reason] of cases) {
      const r = preflightShadowAuditCandidate({ ...candidate(), ...change });
      expect(r.acceptedForSchemaReview).toBe(false);
      expect(r.authorityGranted).toBe(false);
      expect(r.auditPersisted).toBe(false);
      expect(r.reasons).toContain(reason);
    }
  });
});
