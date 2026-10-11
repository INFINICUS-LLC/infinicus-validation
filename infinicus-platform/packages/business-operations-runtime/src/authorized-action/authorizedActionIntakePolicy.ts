/**
 * Pre-claim assessment of an AuthorizedActionPackage (P0-5 Block 3e). Pure: no database, no I/O, no clock of its own.
 *
 * It composes the shared contract's validators with the ABA-owned authoritative status answer and returns two separate facts:
 *   - `identityVerified`: the package is structurally valid, its digest verifies, its scope is the scope BO runs in, and the
 *     authoritative status is about THIS package (id, version, digest) and fresh. Only then may BO store a receipt - an
 *     unverified delivery can never occupy a package identity.
 *   - `refusalCodes`: everything that makes the package non-executable right now (revoked, superseded, expired, consumed, window not
 *     open, authority not current, capability absent, ...). A package is claimable only when this list is empty.
 */
import {
  isValidTimestamp, validateAuthorizedActionPackage, validateForExecution, PACKAGE_LIFECYCLE_STATES,
} from '@infinicus/handoff-contracts';
import type {
  ActionCapabilityRegistry, ActionTypeRegistry, AuthoritativeStatusAnswer, PackageEnablementPolicy, PackageScope,
} from '@infinicus/handoff-contracts';

export type IntakeRefusalCode =
  | 'MALFORMED_PACKAGE' | 'PAYLOAD_COLLISION' | 'STATUS_UNAVAILABLE'
  | 'AUTHORITY_REVOKED' | 'AUTHORITY_UNVERIFIABLE'
  | (string & {});

export interface IntakeAssessmentInput {
  document: unknown;
  /** The scope BO runs under (its own authenticated context, never read from the package). */
  scope: PackageScope;
  actionTypes: ActionTypeRegistry;
  capabilities: ActionCapabilityRegistry;
  enablement?: PackageEnablementPolicy;
  /** The ABA authoritative status answer; null/undefined = unobtainable. */
  answer: AuthoritativeStatusAnswer | null | undefined;
  /** Database time (millisecond UTC) at which the assessment runs. */
  now: string;
  /** How old the status and authority answers may be. Required: no default is invented. */
  statusMaxAgeMs: number;
}

export interface IntakeAssessment {
  identityVerified: boolean;
  refusalCodes: string[];
  /** ABA time of the status answer used (falls back to `now` when there is none). */
  statusVerifiedAt: string;
}

const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const unique = (codes: string[]): string[] => [...new Set(codes)];

/** Status well-formedness, identity and freshness. Returns refusal codes; empty = the answer is about this package and fresh. */
function statusProblems(document: Record<string, unknown>, answer: AuthoritativeStatusAnswer | null | undefined, nowMs: number, maxAgeMs: number): string[] {
  if (!isRec(answer) || !isRec(answer.status)) return ['STATUS_UNVERIFIED'];
  const s = answer.status as unknown as Record<string, unknown>;
  const ok = typeof s.packageId === 'string' && Number.isSafeInteger(s.packageVersion) && typeof s.digest === 'string' && DIGEST.test(s.digest) &&
    typeof s.lifecycle === 'string' && (PACKAGE_LIFECYCLE_STATES as readonly string[]).includes(s.lifecycle) &&
    Number.isSafeInteger(s.latestPackageVersion) && isValidTimestamp(s.verifiedAt);
  if (!ok) return ['STATUS_UNVERIFIED'];
  const identity = document.identity as Record<string, unknown>;
  const integrity = document.integrity as Record<string, unknown>;
  if (s.packageId !== identity.packageId || s.packageVersion !== identity.packageVersion || s.digest !== integrity.digest) return ['STATUS_UNVERIFIED'];
  const verifiedMs = Date.parse(s.verifiedAt as string);
  if (verifiedMs > nowMs || nowMs - verifiedMs > maxAgeMs) return ['STATUS_UNVERIFIED'];
  if ((s.latestPackageVersion as number) < (identity.packageVersion as number)) return ['STATUS_UNVERIFIED'];
  return [];
}

function authorityProblems(answer: AuthoritativeStatusAnswer | null | undefined, nowMs: number, maxAgeMs: number): string[] {
  const a = isRec(answer) && isRec(answer.authority) ? (answer.authority as unknown as Record<string, unknown>) : null;
  if (!a || !isValidTimestamp(a.verifiedAt) || (a.state !== 'CURRENT' && a.state !== 'REVOKED' && a.state !== 'UNVERIFIABLE')) return ['AUTHORITY_UNVERIFIABLE'];
  const verifiedMs = Date.parse(a.verifiedAt as string);
  if (verifiedMs > nowMs || nowMs - verifiedMs > maxAgeMs) return ['AUTHORITY_UNVERIFIABLE'];
  if (a.state === 'REVOKED') return ['AUTHORITY_REVOKED'];
  if (a.state === 'UNVERIFIABLE') return ['AUTHORITY_UNVERIFIABLE'];
  return [];
}

export function assessIntake(i: IntakeAssessmentInput): IntakeAssessment {
  const statusVerifiedAt = isRec(i.answer) && isRec(i.answer.status) && isValidTimestamp((i.answer.status as unknown as Record<string, unknown>).verifiedAt)
    ? ((i.answer.status as unknown as Record<string, unknown>).verifiedAt as string) : i.now;
  const nowMs = Date.parse(i.now);
  const validation = { actionTypes: i.actionTypes, ...(i.enablement ? { enablement: i.enablement } : {}) };

  // 1. Static facts: structure, digest, supported versions (no clock), so an expired package is still IDENTIFIABLE.
  const structural = validateAuthorizedActionPackage(i.document, validation);
  if (!structural.valid || !isRec(i.document)) {
    return { identityVerified: false, refusalCodes: unique(structural.errors.map((e) => e.code)), statusVerifiedAt };
  }
  const doc = i.document;
  const scope = doc.scope as Record<string, unknown>;
  const scopeCodes: string[] = [];
  if (scope.tenantId !== i.scope.tenantId || scope.workspaceId !== i.scope.workspaceId || scope.businessId !== i.scope.businessId) scopeCodes.push('SCOPE_MISMATCH');
  if (scopeCodes.length > 0) return { identityVerified: false, refusalCodes: scopeCodes, statusVerifiedAt };

  // 2. Identity: the authoritative status must be about exactly this package and be fresh.
  const identity = statusProblems(doc, i.answer, nowMs, i.statusMaxAgeMs);
  if (identity.length > 0) return { identityVerified: false, refusalCodes: identity, statusVerifiedAt };

  // 3. Executability: the contract's pre-execution evaluation + current authority.
  const refusals: string[] = [];
  const executable = validateForExecution(i.document, {
    actionTypes: i.actionTypes, capabilities: i.capabilities, now: i.now, scope: i.scope,
    status: (i.answer as AuthoritativeStatusAnswer).status, statusMaxAgeMs: i.statusMaxAgeMs, ...(i.enablement ? { enablement: i.enablement } : {}),
  });
  for (const e of executable.errors) refusals.push(e.code);
  refusals.push(...authorityProblems(i.answer, nowMs, i.statusMaxAgeMs));
  return { identityVerified: true, refusalCodes: unique(refusals), statusVerifiedAt };
}
