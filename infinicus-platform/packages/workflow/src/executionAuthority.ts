/**
 * ABA shared authority-currentness rule (P0-6a, planning decision 1: "one rule, not two").
 *
 * Pure and database-free. The package issuer (packageIssuancePolicy) and the execution-time status provider (AbaPackageStatusProvider)
 * both judge the approver's authority through THIS module, so the issuance-time and execution-time answers cannot drift apart:
 *   - `evaluateApproverAuthority` : was an active canonical grant in force at the decision instant, and has the assignment been revoked since?
 *   - `evaluateExecutionAuthority`: the execution-time verdict - CURRENT only on positive proof; REVOKED when authority was withdrawn
 *     (assignment revoked, decision no longer approved, enabled Level 2 policy no longer covers the action type - ruling O-7);
 *     UNVERIFIABLE when a required fact cannot be established. REVOKED outranks UNVERIFIABLE. Anything not proven is never CURRENT.
 */
import type { IssuanceAssignment } from '@infinicus/database';

export type AuthorityState = 'CURRENT' | 'REVOKED' | 'UNVERIFIABLE';

export interface ApproverAuthority {
  /** The assignment version in force at the decision instant, or null. */
  versionAtDecision: IssuanceAssignment['versionAtDecision'];
  /** The canonical scope of the active grant in force at the decision instant, or null when none existed. */
  grantScopeId: string | null;
  /** The assignment is no longer active or its latest provenance entry is a revoke. */
  revokedSince: boolean;
}

/** Authority facts of one approver assignment, judged at the decision instant and now. A missing assignment establishes nothing. */
export function evaluateApproverAuthority(assignment: IssuanceAssignment | null, decidedAt: string): ApproverAuthority {
  if (!assignment) return { versionAtDecision: null, grantScopeId: null, revokedSince: false };
  const decidedMs = Date.parse(decidedAt);
  const upToDecision = assignment.provenance.filter((p) => Date.parse(p.createdAt) <= decidedMs);
  const last = upToDecision[upToDecision.length - 1];
  const grantScopeId = last && last.entry.action === 'grant' && last.entry.state === 'active' ? last.scopeId : null;
  const latest = assignment.provenance[assignment.provenance.length - 1];
  const revokedSince = assignment.status !== 'active' || (latest !== undefined && latest.entry.action === 'revoke');
  return { versionAtDecision: assignment.versionAtDecision, grantScopeId, revokedSince };
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Does an enabled Level 2 policy specification name this canonical action type? (The policy convention of packageIssuancePolicy.) */
export function policyCoversActionType(specification: Record<string, unknown>, actionTypesKey: string, code: string, schemaVersion: string): boolean {
  const listed = specification[actionTypesKey];
  return Array.isArray(listed) && listed.some((e) => isObject(e) && e.code === code && e.schemaVersion === schemaVersion);
}

export interface ExecutionAuthorityFacts {
  decisionStatus: string;
  /** The decision's approval audit events as loaded; exactly one is required. */
  approvalAudit: { id: string; eventType: string; occurredAt: string; detail: Record<string, unknown> }[];
  assignment: IssuanceAssignment | null;
  /** True only when the currently enabled Level 2 policy names the package's action type; null = no enabled policy exists. */
  level2PolicyCoversActionType: boolean | null;
}

export interface ExecutionAuthorityVerdict {
  state: AuthorityState;
  /** Stable machine-readable causes (diagnostics for ABA; the contract answer carries only `state`). */
  reasons: string[];
}

export function evaluateExecutionAuthority(f: ExecutionAuthorityFacts): ExecutionAuthorityVerdict {
  const revoked: string[] = [];
  const unverifiable: string[] = [];

  if (f.decisionStatus !== 'approved' && f.decisionStatus !== 'approved_with_modifications') revoked.push('DECISION_NOT_APPROVED');

  const expected = `approval.${f.decisionStatus}`;
  let decidedAt: string | null = null;
  if (f.approvalAudit.length === 0) unverifiable.push('APPROVAL_AUDIT_MISSING');
  else if (f.approvalAudit.length > 1) unverifiable.push('APPROVAL_AUDIT_AMBIGUOUS');
  else if (f.approvalAudit[0].eventType !== expected) unverifiable.push('APPROVAL_AUDIT_MISMATCH');
  else decidedAt = f.approvalAudit[0].occurredAt;

  if (!f.assignment) {
    unverifiable.push('ASSIGNMENT_NOT_FOUND');
  } else if (decidedAt !== null) {
    const authority = evaluateApproverAuthority(f.assignment, decidedAt);
    if (authority.versionAtDecision === null) unverifiable.push('NO_ASSIGNMENT_VERSION_AT_DECISION');
    if (authority.grantScopeId === null) unverifiable.push('NO_ACTIVE_GRANT_AT_DECISION');
    if (authority.revokedSince) revoked.push('APPROVER_AUTHORITY_REVOKED');
  } else if (f.assignment.status !== 'active') {
    revoked.push('APPROVER_AUTHORITY_REVOKED');
  }

  // Ruling O-7: disabling (or narrowing) the applicable Level 2 policy after issuance blocks execution - fail closed.
  if (f.level2PolicyCoversActionType === null) revoked.push('LEVEL2_POLICY_NOT_ENABLED');
  else if (!f.level2PolicyCoversActionType) revoked.push('LEVEL2_POLICY_DOES_NOT_COVER_ACTION_TYPE');

  if (revoked.length > 0) return { state: 'REVOKED', reasons: [...revoked, ...unverifiable] };
  if (unverifiable.length > 0) return { state: 'UNVERIFIABLE', reasons: unverifiable };
  return { state: 'CURRENT', reasons: [] };
}
