import { describe, expect, it } from 'vitest';
import { assessShadowOperatorProposal, type ShadowAuthorityProposal } from '../src/ShadowOperatorAuthorityProposal.js';
const ids = ['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444',
  '55555555-5555-4555-8555-555555555555','66666666-6666-4666-8666-666666666666'];
const valid = (): ShadowAuthorityProposal => ({
  tenantId: ids[0], workspaceId: ids[1], businessId: ids[2],
  operatorId: ids[3], approverId: ids[4], assignmentId: ids[5],
  permissionCode: 'cl:shadow:evaluate', controlVersion: 1, authorityVersion: 1,
  active: true, revoked: false, evaluatedAt: '2026-10-24T00:00:00.000Z',
  expiresAt: '2026-10-25T00:00:00.000Z',
});
describe('CL-ACT-06 preparatory operator authority', () => {
  it('never authorizes evaluation, learning, or mutation, even when a proposal appears valid', () => {
    const r = assessShadowOperatorProposal(valid());
    expect(r.acceptedForReview).toBe(true);
    expect(r).toMatchObject({ mode: 'PROPOSAL_ONLY', permitsEvaluation: false, permitsLearning: false, permitsMutation: false, reasons: [] });
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.reasons)).toBe(true);
  });
  it('accepts canonical UTC timestamp syntax for review only and rejects noncanonical timestamps', () => {
    const acceptable = assessShadowOperatorProposal(valid());
    expect(acceptable.acceptedForReview).toBe(true);
    expect(acceptable.reasons).toEqual([]);
    expect(acceptable.permitsEvaluation).toBe(false);
    for (const expiresAt of ['2026-10-25', '2026-10-25T00:00:00Z', '2026-10-25T00:00:00.000+00:00', 'invalid']) {
      const result = assessShadowOperatorProposal({ ...valid(), expiresAt });
      expect(result.acceptedForReview, expiresAt).toBe(false);
      expect(result.reasons).toContain('EXPIRED_OR_INVALID_TIME');
    }
  });
  it('refuses self approval, revoked, expired, wrong permissions and malformed versions', () => {
    for (const [change, reason] of [
      [{ approverId: ids[3] }, 'SELF_APPROVAL'],
      [{ revoked: true }, 'INACTIVE_OR_REVOKED'],
      [{ active: false }, 'INACTIVE_OR_REVOKED'],
      [{ expiresAt: '2026-10-23T00:00:00.000Z' }, 'EXPIRED_OR_INVALID_TIME'],
      [{ permissionCode: 'bo:admin' }, 'PERMISSION_UNAPPROVED'],
      [{ controlVersion: 0 }, 'INVALID_VERSION'],
      [{ authorityVersion: 0 }, 'INVALID_VERSION'],
      [{ tenantId: 'other' }, 'INVALID_SCOPE_OR_IDENTITY'],
    ] as const) {
      const r = assessShadowOperatorProposal({ ...valid(), ...change });
      expect(r.acceptedForReview).toBe(false);
      expect(r.reasons).toContain(reason);
      expect(r.permitsEvaluation).toBe(false);
    }
  });
});
