/** P0-6a: the shared authority-currentness rule used by BOTH the issuer and the execution-time status provider (pure, no database). */
import { describe, expect, it } from 'vitest';
import type { IssuanceAssignment } from '@infinicus/database';
import { evaluateApproverAuthority, evaluateExecutionAuthority, policyCoversActionType, type ExecutionAuthorityFacts } from '../src/executionAuthority.js';

const DECIDED = '2026-10-01T10:00:00.000Z';
const BEFORE = '2026-10-01T09:00:00.000Z';
const AFTER = '2026-10-01T11:00:00.000Z';
const grant = { action: 'grant', state: 'active' };
const revoke = { action: 'revoke', state: 'revoked' };

const assignment = (over: Partial<IssuanceAssignment> = {}): IssuanceAssignment => ({
  assignmentId: 'a', userId: 'u', assignmentCode: 'c', status: 'active',
  versionAtDecision: { id: 'v1', versionNumber: 1, roleCode: 'business-owner' },
  provenance: [{ scopeId: 's1', createdAt: BEFORE, entry: grant }], ...over,
});
const audit = (eventType = 'approval.approved', occurredAt = DECIDED) => ({ id: 'e1', eventType, occurredAt, detail: {} });
const facts = (over: Partial<ExecutionAuthorityFacts> = {}): ExecutionAuthorityFacts => ({
  decisionStatus: 'approved', approvalAudit: [audit()], assignment: assignment(), level2PolicyCoversActionType: true, ...over,
});

describe('evaluateApproverAuthority', () => {
  it('finds the active grant in force at the decision instant', () => {
    expect(evaluateApproverAuthority(assignment(), DECIDED)).toMatchObject({ grantScopeId: 's1', revokedSince: false });
  });
  it('a grant made only after the decision does not establish authority at the decision', () => {
    const a = assignment({ provenance: [{ scopeId: 's2', createdAt: AFTER, entry: grant }] });
    expect(evaluateApproverAuthority(a, DECIDED).grantScopeId).toBeNull();
  });
  it('a revoke before the decision (the last entry up to it) means no active grant; a revoke after it means revoked since', () => {
    const before = assignment({ provenance: [{ scopeId: 's1', createdAt: BEFORE, entry: grant }, { scopeId: 's2', createdAt: BEFORE, entry: revoke }] });
    expect(evaluateApproverAuthority(before, DECIDED).grantScopeId).toBeNull();
    const after = assignment({ provenance: [{ scopeId: 's1', createdAt: BEFORE, entry: grant }, { scopeId: 's2', createdAt: AFTER, entry: revoke }] });
    expect(evaluateApproverAuthority(after, DECIDED)).toMatchObject({ grantScopeId: 's1', revokedSince: true });
  });
  it('an inactive assignment is revoked since even without a revoke entry', () => {
    expect(evaluateApproverAuthority(assignment({ status: 'revoked' }), DECIDED).revokedSince).toBe(true);
  });
  it('only an ACTIVE grant counts: a grant entry in another state establishes nothing', () => {
    const a = assignment({ provenance: [{ scopeId: 's1', createdAt: BEFORE, entry: { action: 'grant', state: 'suspended' } }] });
    expect(evaluateApproverAuthority(a, DECIDED).grantScopeId).toBeNull();
  });
  it('a missing assignment establishes nothing', () => {
    expect(evaluateApproverAuthority(null, DECIDED)).toEqual({ versionAtDecision: null, grantScopeId: null, revokedSince: false });
  });
});

describe('evaluateExecutionAuthority', () => {
  it('CURRENT only on positive proof of every fact (both approval kinds)', () => {
    expect(evaluateExecutionAuthority(facts())).toEqual({ state: 'CURRENT', reasons: [] });
    expect(evaluateExecutionAuthority(facts({ decisionStatus: 'approved_with_modifications', approvalAudit: [audit('approval.approved_with_modifications')] })).state).toBe('CURRENT');
  });

  it('REVOKED: approver authority revoked after the decision', () => {
    const a = assignment({ provenance: [{ scopeId: 's1', createdAt: BEFORE, entry: grant }, { scopeId: 's2', createdAt: AFTER, entry: revoke }], status: 'revoked' });
    expect(evaluateExecutionAuthority(facts({ assignment: a }))).toEqual({ state: 'REVOKED', reasons: ['APPROVER_AUTHORITY_REVOKED'] });
  });

  it('REVOKED: decision no longer approved', () => {
    const r = evaluateExecutionAuthority(facts({ decisionStatus: 'rejected', approvalAudit: [audit('approval.rejected')] }));
    expect(r.state).toBe('REVOKED');
    expect(r.reasons).toContain('DECISION_NOT_APPROVED');
  });

  it('REVOKED (ruling O-7): the enabled Level 2 policy was disabled, or no longer covers the action type', () => {
    expect(evaluateExecutionAuthority(facts({ level2PolicyCoversActionType: null }))).toEqual({ state: 'REVOKED', reasons: ['LEVEL2_POLICY_NOT_ENABLED'] });
    expect(evaluateExecutionAuthority(facts({ level2PolicyCoversActionType: false }))).toEqual({ state: 'REVOKED', reasons: ['LEVEL2_POLICY_DOES_NOT_COVER_ACTION_TYPE'] });
  });

  it('UNVERIFIABLE: missing, ambiguous or mismatched approval audit', () => {
    expect(evaluateExecutionAuthority(facts({ approvalAudit: [] })).reasons).toContain('APPROVAL_AUDIT_MISSING');
    expect(evaluateExecutionAuthority(facts({ approvalAudit: [audit(), audit()] })).reasons).toContain('APPROVAL_AUDIT_AMBIGUOUS');
    const mismatch = evaluateExecutionAuthority(facts({ approvalAudit: [audit('approval.rejected')] }));
    expect(mismatch).toEqual({ state: 'UNVERIFIABLE', reasons: ['APPROVAL_AUDIT_MISMATCH'] });
  });

  it('UNVERIFIABLE: no assignment, no assignment version, or no active grant at the decision', () => {
    expect(evaluateExecutionAuthority(facts({ assignment: null })).state).toBe('UNVERIFIABLE');
    expect(evaluateExecutionAuthority(facts({ assignment: assignment({ versionAtDecision: null }) })).reasons).toEqual(['NO_ASSIGNMENT_VERSION_AT_DECISION']);
    expect(evaluateExecutionAuthority(facts({ assignment: assignment({ provenance: [] }) })).reasons).toEqual(['NO_ACTIVE_GRANT_AT_DECISION']);
  });

  it('REVOKED outranks UNVERIFIABLE (a known withdrawal is never reported as merely unverifiable)', () => {
    const r = evaluateExecutionAuthority(facts({ approvalAudit: [], level2PolicyCoversActionType: null }));
    expect(r.state).toBe('REVOKED');
    expect(r.reasons).toEqual(['LEVEL2_POLICY_NOT_ENABLED', 'APPROVAL_AUDIT_MISSING']);
  });

  it('an inactive assignment is REVOKED even when the audit cannot be read', () => {
    expect(evaluateExecutionAuthority(facts({ approvalAudit: [], assignment: assignment({ status: 'revoked' }) })).state).toBe('REVOKED');
  });
});

describe('policyCoversActionType', () => {
  const spec = { actionTypes: [{ code: 'inventory_reorder_policy_update', schemaVersion: '1' }, 'junk', null] };
  it('matches code and schema version exactly', () => {
    expect(policyCoversActionType(spec, 'actionTypes', 'inventory_reorder_policy_update', '1')).toBe(true);
    expect(policyCoversActionType(spec, 'actionTypes', 'inventory_reorder_policy_update', '2')).toBe(false);
    expect(policyCoversActionType(spec, 'actionTypes', 'other', '1')).toBe(false);
    expect(policyCoversActionType({}, 'actionTypes', 'inventory_reorder_policy_update', '1')).toBe(false);
    expect(policyCoversActionType({ actionTypes: 'x' }, 'actionTypes', 'inventory_reorder_policy_update', '1')).toBe(false);
  });
});
