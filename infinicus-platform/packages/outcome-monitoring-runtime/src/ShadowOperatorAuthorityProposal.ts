/**
 * CL-ACT-06 — Pure preparatory assessment of an externally verified operator
 * authority snapshot. NOT an authentication provider, audit writer, or grant.
 * Only a future trusted composition may obtain canonical signed records and
 * append audits; no result of this function activates production shadow mode.
 */
export interface ShadowAuthorityProposal {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly businessId: string;
  readonly operatorId: string;
  readonly approverId: string;
  readonly assignmentId: string;
  readonly permissionCode: string;
  readonly controlVersion: number;
  readonly authorityVersion: number;
  readonly active: boolean;
  readonly revoked: boolean;
  readonly expiresAt: string;
  readonly evaluatedAt: string;
}
export interface ShadowAuthorityAssessment {
  readonly acceptedForReview: boolean;
  readonly mode: 'PROPOSAL_ONLY';
  readonly permitsEvaluation: false;
  readonly permitsLearning: false;
  readonly permitsMutation: false;
  readonly reasons: readonly string[];
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERMISSION = 'cl:shadow:evaluate';
const fail = (reasons: string[]): ShadowAuthorityAssessment => Object.freeze({
  acceptedForReview: reasons.length === 0, mode: 'PROPOSAL_ONLY',
  permitsEvaluation: false, permitsLearning: false, permitsMutation: false,
  reasons: Object.freeze([...reasons]),
});
/** Preflight for a trusted reviewer; never interprets caller claims as actual authority. */
export function assessShadowOperatorProposal(input: ShadowAuthorityProposal): ShadowAuthorityAssessment {
  const reasons: string[] = [];
  if (!input || typeof input !== 'object') return fail(['INVALID_PROPOSAL']);
  const ids = [input.tenantId, input.workspaceId, input.businessId, input.operatorId, input.approverId, input.assignmentId];
  if (!ids.every(id => typeof id === 'string' && UUID.test(id))) reasons.push('INVALID_SCOPE_OR_IDENTITY');
  if (input.operatorId === input.approverId) reasons.push('SELF_APPROVAL');
  if (input.permissionCode !== PERMISSION) reasons.push('PERMISSION_UNAPPROVED');
  if (!Number.isSafeInteger(input.controlVersion) || input.controlVersion <= 0 ||
      !Number.isSafeInteger(input.authorityVersion) || input.authorityVersion <= 0) reasons.push('INVALID_VERSION');
  if (input.active !== true || input.revoked !== false) reasons.push('INACTIVE_OR_REVOKED');
  const expiry = Date.parse(input.expiresAt);
  const evaluated = Date.parse(input.evaluatedAt);
  if (!Number.isFinite(expiry) || !Number.isFinite(evaluated) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input.expiresAt) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input.evaluatedAt) ||
      expiry <= evaluated) reasons.push('EXPIRED_OR_INVALID_TIME');
  return fail(reasons);
}
