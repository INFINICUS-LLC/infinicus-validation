/**
 * CL-ACT-06C preparatory contract for a future CL-owned, append-only audit.
 * This is a pure shape check for schema/design review, NOT an audit writer,
 * canonical authentication, permission grant or production authority.
 */
export const SHADOW_AUDIT_CONTRACT_VERSION = 'cl-shadow-audit/1' as const;
export type ShadowAuditEventType = 'REQUESTED' | 'APPROVED' | 'REVOKED' | 'REFUSED' | 'EVALUATED';

export interface ShadowAuditCandidate {
  readonly contractVersion: typeof SHADOW_AUDIT_CONTRACT_VERSION;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly businessId: string;
  readonly operatorId: string;
  readonly approverId: string | null;
  readonly assignmentId: string | null;
  readonly assignmentVersionId: string | null;
  readonly controlId: string;
  readonly controlVersion: number;
  readonly idempotencyKey: string;
  readonly eventType: ShadowAuditEventType;
  readonly sourceDigest: string;
  readonly reasonCodes: readonly string[];
  readonly releaseAuthorized: false;
  readonly learningApplied: false;
  readonly mutationsPermitted: false;
}
export interface ShadowAuditPreflight {
  readonly acceptedForSchemaReview: boolean;
  readonly authorityGranted: false;
  readonly auditPersisted: false;
  readonly reasons: readonly string[];
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const REASON = /^[A-Z][A-Z0-9_]{0,63}$/;
const TYPES: readonly string[] = ['REQUESTED', 'APPROVED', 'REVOKED', 'REFUSED', 'EVALUATED'];
export function preflightShadowAuditCandidate(input: ShadowAuditCandidate): ShadowAuditPreflight {
  const reasons: string[] = [];
  if (!input || typeof input !== 'object') reasons.push('INVALID_CANDIDATE');
  else {
    if (input.contractVersion !== SHADOW_AUDIT_CONTRACT_VERSION) reasons.push('INVALID_VERSION');
    if (![input.tenantId, input.workspaceId, input.businessId, input.operatorId, input.controlId]
      .every(v => typeof v === 'string' && UUID.test(v))) reasons.push('INVALID_SCOPE');
    if (![input.approverId, input.assignmentId, input.assignmentVersionId]
      .every(v => v === null || (typeof v === 'string' && UUID.test(v)))) reasons.push('INVALID_AUTHORITY_REFERENCE');
    if (input.eventType === 'APPROVED' && (
      !input.approverId || !input.assignmentId || !input.assignmentVersionId || input.approverId === input.operatorId
    )) reasons.push('APPROVAL_EVIDENCE_MISSING');
    if (!TYPES.includes(input.eventType)) reasons.push('INVALID_EVENT_TYPE');
    if (!Number.isSafeInteger(input.controlVersion) || input.controlVersion <= 0) reasons.push('INVALID_CONTROL_VERSION');
    if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length < 1 || input.idempotencyKey.length > 128)
      reasons.push('INVALID_IDEMPOTENCY_KEY');
    if (typeof input.sourceDigest !== 'string' || !DIGEST.test(input.sourceDigest)) reasons.push('INVALID_SOURCE_DIGEST');
    if (!Array.isArray(input.reasonCodes) || input.reasonCodes.some(v => typeof v !== 'string' || !REASON.test(v)) ||
        input.reasonCodes.length > 32) reasons.push('INVALID_REASONS');
    if (input.releaseAuthorized !== false || input.learningApplied !== false || input.mutationsPermitted !== false)
      reasons.push('FORBIDDEN_AUTHORITY');
  }
  return Object.freeze({
    acceptedForSchemaReview: reasons.length === 0, authorityGranted: false,
    auditPersisted: false, reasons: Object.freeze(reasons),
  });
}
