import { describe, expect, it } from 'vitest';
import { APPROVAL_AUDIT_SCHEMA, auditEventTypeFor, buildApprovalAuditDetail, type ApprovalAuditInput } from '../src/approvalAudit.js';

const base: ApprovalAuditInput = {
  eventType: 'approval.approved',
  businessId: 'b1',
  reviewPackageId: 'rp1',
  decisionId: 'd1',
  decisionVersionId: 'dv1',
  approverUserId: 'u1',
  assignment: { id: 'a1', code: 'business-owner-approver', roleCode: 'business-owner' },
  requestedOutcome: 'approve',
  priorState: 'draft',
  newState: 'approved',
  reason: 'Looks right',
  reasonCodes: [],
  permissionUsed: 'aba:write',
  correlationId: 'c1',
  facts: {
    reviewVersionId: 'rv1', sourceRecommendationVersionId: 'srv1', riskClass: 'high',
    isTimeSensitive: true, validUntil: new Date('2026-12-01T00:00:00Z'), twinSnapshotId: 'tw1',
  },
};

describe('approval audit contract (locked ABA §25)', () => {
  it('carries every §25 field that the data model can supply', () => {
    const d = buildApprovalAuditDetail(base) as Record<string, any>;
    expect(d.schema).toBe(APPROVAL_AUDIT_SCHEMA);
    expect(d).toMatchObject({
      decisionId: 'd1', approvalType: 'approve', priorState: 'draft', newState: 'approved', reason: 'Looks right',
      permissionUsed: 'aba:write', correlationId: 'c1', reviewPackageId: 'rp1',
      approver: { userId: 'u1', assignmentId: 'a1', assignmentCode: 'business-owner-approver', roleCode: 'business-owner' },
      facts: { riskClass: 'high', isTimeSensitive: true, validUntil: '2026-12-01T00:00:00.000Z', twinSnapshotId: 'tw1' },
    });
  });

  it('records what the data model cannot supply as null AND names it, instead of inventing a value', () => {
    const d = buildApprovalAuditDetail(base) as Record<string, any>;
    for (const key of ['actionId', 'modifiedParameters', 'simulationRunId', 'modelVersion']) {
      expect(d[key]).toBeNull();
      expect(d.unavailable).toContain(key);
    }
  });

  it('keeps reason codes for refusals and tolerates a missing assignment or facts', () => {
    const d = buildApprovalAuditDetail({
      ...base, eventType: 'approval.denied', decisionId: null, decisionVersionId: null, assignment: null, facts: null,
      reasonCodes: ['AUTHORITY_NOT_ESTABLISHED'], priorState: null, newState: null,
    }) as Record<string, any>;
    expect(d.reasonCodes).toEqual(['AUTHORITY_NOT_ESTABLISHED']);
    expect(d.approver).toMatchObject({ userId: 'u1', assignmentId: null, assignmentCode: null, roleCode: null });
    expect(d.facts).toBeNull();
    expect(d.decisionId).toBeNull();
  });

  it('cleans control characters and bounds the free-text reason', () => {
    const d = buildApprovalAuditDetail({ ...base, reason: `bad\u0000\u001b[31m${'x'.repeat(5000)}` }) as Record<string, any>;
    expect(d.reason).not.toMatch(/[\u0000-\u001f]/);
    expect(d.reason.length).toBeLessThanOrEqual(2001);
    expect(buildApprovalAuditDetail({ ...base, reason: null })).toMatchObject({ reason: null });
  });

  it('is JSON-serialisable and maps each outcome to its own event type', () => {
    expect(() => JSON.stringify(buildApprovalAuditDetail(base))).not.toThrow();
    expect(auditEventTypeFor('approve')).toBe('approval.approved');
    expect(auditEventTypeFor('approve_with_modifications')).toBe('approval.approved_with_modifications');
    expect(auditEventTypeFor('reject')).toBe('approval.rejected');
  });
});
