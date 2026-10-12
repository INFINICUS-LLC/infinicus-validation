/**
 * P0-6a (owner ruling O-5): validateForExecutionAfterClaim - the final pre-execution check made AFTER Business Operations' own claim.
 * Identical rules and codes to validateForExecution, except lifecycle CONSUMED is acceptable for exactly the claim's own receipt.
 */
import { describe, expect, it } from 'vitest';
import { sealAuthorizedActionPackage, validateForExecution, validateForExecutionAfterClaim } from '../src';
import type { ActionCapabilityRegistry, AapErrorCode, AapValidationResult, AfterClaimExecutionContext, AuthoritativePackageStatus, AuthorizedActionPackageV1 } from '../src';
import { approvedBody, registry } from './aap-fixtures';

const codes = (r: AapValidationResult): AapErrorCode[] => r.errors.map((e) => e.code);
const sealed = (): AuthorizedActionPackageV1 => sealAuthorizedActionPackage(approvedBody(), { actionTypes: registry() });
const NOW = '2026-10-08T10:10:00.000Z';
const RECEIPT = '6a6a6a6a-0000-4000-8000-000000000001';
const OTHER_RECEIPT = '6a6a6a6a-0000-4000-8000-000000000002';
const all: ActionCapabilityRegistry = { supports: () => true };

const status = (pkg: AuthorizedActionPackageV1, over: Partial<AuthoritativePackageStatus> = {}): AuthoritativePackageStatus => ({
  packageId: pkg.identity.packageId, packageVersion: pkg.identity.packageVersion, digest: pkg.integrity.digest, lifecycle: 'CONSUMED',
  latestPackageVersion: pkg.identity.packageVersion, verifiedAt: '2026-10-08T10:09:59.000Z', consumptionReceiptId: RECEIPT, ...over,
});
const ctx = (pkg: AuthorizedActionPackageV1, over: Partial<AfterClaimExecutionContext> = {}): AfterClaimExecutionContext => ({
  actionTypes: registry(), capabilities: all, now: NOW, scope: { ...pkg.scope }, status: status(pkg), statusMaxAgeMs: 5000, consumptionReceiptId: RECEIPT, ...over,
});

describe('validateForExecutionAfterClaim', () => {
  it('accepts CONSUMED for this claim\'s own receipt', () => {
    const p = sealed();
    expect(validateForExecutionAfterClaim(p, ctx(p))).toEqual({ valid: true, errors: [] });
  });

  it('still accepts ISSUED (the mirror may lag the claim; BO\'s claim is canonical)', () => {
    const p = sealed();
    expect(validateForExecutionAfterClaim(p, ctx(p, { status: status(p, { lifecycle: 'ISSUED', consumptionReceiptId: null }) })).valid).toBe(true);
  });

  it('refuses CONSUMED for another receipt, without a receipt, or with a malformed one', () => {
    const p = sealed();
    for (const receipt of [OTHER_RECEIPT, null, undefined]) {
      const r = validateForExecutionAfterClaim(p, ctx(p, { status: status(p, { consumptionReceiptId: receipt as string | null }) }));
      expect(codes(r)).toEqual(['PACKAGE_ALREADY_CONSUMED']);
    }
  });

  it('refuses a missing or malformed claim receipt id in the context', () => {
    const p = sealed();
    for (const bad of ['', 'not-a-uuid', undefined as unknown as string]) {
      expect(codes(validateForExecutionAfterClaim(p, ctx(p, { consumptionReceiptId: bad })))).toEqual(['CONTEXT_INVALID']);
    }
  });

  it('keeps every other check: revoked, superseded, expired, wrong digest, stale answer, other scope, unsupported type, missing status', () => {
    const p = sealed();
    expect(codes(validateForExecutionAfterClaim(p, ctx(p, { status: status(p, { lifecycle: 'REVOKED', consumptionReceiptId: null }) })))).toEqual(['PACKAGE_REVOKED']);
    expect(codes(validateForExecutionAfterClaim(p, ctx(p, { status: status(p, { lifecycle: 'SUPERSEDED', consumptionReceiptId: null }) })))).toEqual(['PACKAGE_SUPERSEDED']);
    expect(codes(validateForExecutionAfterClaim(p, ctx(p, { status: status(p, { lifecycle: 'EXPIRED', consumptionReceiptId: null }) })))).toEqual(['PACKAGE_EXPIRED']);
    expect(codes(validateForExecutionAfterClaim(p, ctx(p, { status: status(p, { digest: `sha256:${'0'.repeat(64)}` }) })))).toEqual(['STATUS_UNVERIFIED']);
    expect(codes(validateForExecutionAfterClaim(p, ctx(p, { status: status(p, { verifiedAt: '2026-10-08T10:09:00.000Z' }) })))).toEqual(['STATUS_UNVERIFIED']);
    expect(codes(validateForExecutionAfterClaim(p, ctx(p, { status: status(p, { verifiedAt: '2026-10-08T10:11:00.000Z' }) })))).toEqual(['STATUS_UNVERIFIED']);
    expect(codes(validateForExecutionAfterClaim(p, ctx(p, { status: null })))).toEqual(['STATUS_UNVERIFIED']);
    expect(codes(validateForExecutionAfterClaim(p, ctx(p, { scope: { ...p.scope, businessId: '6a6a6a6a-0000-4000-8000-0000000000ff' } })))).toEqual(['SCOPE_MISMATCH']);
    expect(codes(validateForExecutionAfterClaim(p, ctx(p, { capabilities: { supports: () => false } })))).toEqual(['ACTION_TYPE_UNSUPPORTED_BY_EXECUTOR']);
  });

  it('refuses a newer version even when this one is ISSUED (not the current version)', () => {
    const p = sealed();
    const r = validateForExecutionAfterClaim(p, ctx(p, { status: status(p, { lifecycle: 'ISSUED', consumptionReceiptId: null, latestPackageVersion: p.identity.packageVersion + 1 }) }));
    expect(codes(r)).toEqual(['PACKAGE_NOT_CURRENT_VERSION']);
  });

  it('the pre-claim validator is unchanged: CONSUMED is refused even with a receipt', () => {
    const p = sealed();
    expect(codes(validateForExecution(p, ctx(p)))).toEqual(['PACKAGE_ALREADY_CONSUMED']);
  });

  it('a tampered package is refused before the status is consulted', () => {
    const p: any = JSON.parse(JSON.stringify(sealed()));
    p.action.parameters.newPrice = '0.01';
    p.lineage.proposedParameters.value.parameters.newPrice = '0.01';
    expect(codes(validateForExecutionAfterClaim(p, ctx(p)))).toEqual(['DIGEST_MISMATCH']);
  });
});
