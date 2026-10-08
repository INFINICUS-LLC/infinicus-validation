import { describe, expect, it } from 'vitest';
import {
  checkParameterValue, InMemoryActionTypeRegistry, requiredGovernanceDimensions, sealAuthorizedActionPackage,
  validateActionTypeContract, validateForExecution, GOVERNANCE_DIMENSIONS,
} from '../src';
import type { ActionCapabilityRegistry, AapErrorCode, AapValidationResult, AuthoritativePackageStatus, AuthorizedActionPackageV1, ExecutionContext } from '../src';
import { ADJUST_PRICE, approvedBody, clone, ID, registry, T } from './aap-fixtures';

const codes = (r: AapValidationResult): AapErrorCode[] => r.errors.map((e) => e.code);
const sealed = (): AuthorizedActionPackageV1 => sealAuthorizedActionPackage(approvedBody(), { actionTypes: registry() });

const NOW = '2026-10-08T10:10:00.000Z';
const capabilitiesAll: ActionCapabilityRegistry = { supports: () => true };

function statusFor(pkg: AuthorizedActionPackageV1, over: Partial<AuthoritativePackageStatus> = {}): AuthoritativePackageStatus {
  return {
    packageId: pkg.identity.packageId, packageVersion: pkg.identity.packageVersion, digest: pkg.integrity.digest,
    lifecycle: 'ISSUED', latestPackageVersion: pkg.identity.packageVersion, verifiedAt: '2026-10-08T10:09:59.000Z', ...over,
  };
}

function ctx(pkg: AuthorizedActionPackageV1, over: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    actionTypes: registry(), capabilities: capabilitiesAll, now: NOW,
    scope: { ...pkg.scope }, status: statusFor(pkg), statusMaxAgeMs: 5000, ...over,
  };
}

describe('validateForExecution (BO side, owner ruling R-10: authoritative pull, fail closed)', () => {
  it('an ISSUED, current, in-window, in-scope, supported, verified package is executable', () => {
    const p = sealed();
    expect(validateForExecution(p, ctx(p))).toEqual({ valid: true, errors: [] });
  });

  it('a tampered package is refused before anything else is trusted', () => {
    const p: any = clone(sealed());
    p.action.parameters.newPrice = '0.01';
    p.lineage.proposedParameters.value.parameters.newPrice = '0.01';
    expect(codes(validateForExecution(p, ctx(p as AuthorizedActionPackageV1)))).toEqual(['DIGEST_MISMATCH']);
  });

  it('refuses a package from another tenant, workspace or business (scope comes from BO\'s own context, never the package)', () => {
    const p = sealed();
    for (const key of ['tenantId', 'workspaceId', 'businessId'] as const) {
      const r = validateForExecution(p, ctx(p, { scope: { ...p.scope, [key]: ID.otherTenant } }));
      expect(codes(r)).toEqual(['SCOPE_MISMATCH']);
      expect(r.errors[0].path).toBe(`$.scope.${key}`);
    }
  });

  it('refuses an action type the executor cannot run (BO capability registry), even though ABA authorized it', () => {
    const p = sealed();
    const none: ActionCapabilityRegistry = { supports: () => false };
    expect(codes(validateForExecution(p, ctx(p, { capabilities: none })))).toEqual(['ACTION_TYPE_UNSUPPORTED_BY_EXECUTOR']);
    const versionOnly: ActionCapabilityRegistry = { supports: (c, v) => c === 'adjust_price' && v === '2' };
    expect(codes(validateForExecution(p, ctx(p, { capabilities: versionOnly })))).toEqual(['ACTION_TYPE_UNSUPPORTED_BY_EXECUTOR']);
  });

  it('enforces the execution window on database time', () => {
    const p = sealed();
    expect(codes(validateForExecution(p, ctx(p, { now: '2026-10-08T10:01:00.000Z', status: statusFor(p, { verifiedAt: '2026-10-08T10:00:59.000Z' }) })))).toEqual(['EXECUTION_WINDOW_NOT_OPEN']);
    const lateCtx = ctx(p, { now: T.windowEnd, status: statusFor(p, { verifiedAt: '2026-10-08T11:59:59.000Z' }) });
    // The window end is an expiry bound, so a closed window is an expired package.
    expect(codes(validateForExecution(p, lateCtx))).toEqual(['PACKAGE_EXPIRED']);
  });

  describe('authoritative status', () => {
    it.each([null, undefined])('fails closed when the status cannot be obtained (%s)', (status) => {
      const p = sealed();
      expect(codes(validateForExecution(p, ctx(p, { status })))).toEqual(['STATUS_UNVERIFIED']);
    });

    it('fails closed on a malformed status answer', () => {
      const p = sealed();
      for (const bad of [{}, { ...statusFor(p), lifecycle: 'EXECUTED' }, { ...statusFor(p), verifiedAt: 'yesterday' }, { ...statusFor(p), digest: 'nope' }, { ...statusFor(p), latestPackageVersion: 'x' }]) {
        expect(codes(validateForExecution(p, ctx(p, { status: bad as unknown as AuthoritativePackageStatus })))).toEqual(['STATUS_UNVERIFIED']);
      }
    });

    it('fails closed when the answer is about a different package, version or digest', () => {
      const p = sealed();
      for (const over of [{ packageId: ID.otherPackage }, { packageVersion: 2 }, { digest: 'sha256:' + '1'.repeat(64) }]) {
        expect(codes(validateForExecution(p, ctx(p, { status: statusFor(p, over) })))).toEqual(['STATUS_UNVERIFIED']);
      }
    });

    it('fails closed when the answer is too old, from the future, or not larger than the package version', () => {
      const p = sealed();
      expect(codes(validateForExecution(p, ctx(p, { status: statusFor(p, { verifiedAt: '2026-10-08T10:09:00.000Z' }) })))).toEqual(['STATUS_UNVERIFIED']);
      expect(codes(validateForExecution(p, ctx(p, { status: statusFor(p, { verifiedAt: '2026-10-08T10:10:01.000Z' }) })))).toEqual(['STATUS_UNVERIFIED']);
      expect(codes(validateForExecution(p, ctx(p, { status: statusFor(p, { latestPackageVersion: 0 }) })))).toEqual(['STATUS_UNVERIFIED']);
    });

    it.each([
      ['REVOKED', 'PACKAGE_REVOKED'],
      ['SUPERSEDED', 'PACKAGE_SUPERSEDED'],
      ['EXPIRED', 'PACKAGE_EXPIRED'],
      ['CONSUMED', 'PACKAGE_ALREADY_CONSUMED'],
    ] as const)('refuses a %s package (single-use: CONSUMED means BO already claimed it)', (lifecycle, code) => {
      const p = sealed();
      expect(codes(validateForExecution(p, ctx(p, { status: statusFor(p, { lifecycle }) })))).toEqual([code]);
    });

    it('refuses an ISSUED package when a newer version exists', () => {
      const p = sealed();
      expect(codes(validateForExecution(p, ctx(p, { status: statusFor(p, { latestPackageVersion: 2 }) })))).toEqual(['PACKAGE_NOT_CURRENT_VERSION']);
    });

    it('does not accept the status from the package itself: a caller-supplied status object that is a lie about the digest fails', () => {
      const p = sealed();
      const liar = statusFor(p, { digest: 'sha256:' + '2'.repeat(64) });
      expect(codes(validateForExecution(p, ctx(p, { status: liar })))).toEqual(['STATUS_UNVERIFIED']);
    });
  });

  it('rejects an invalid execution context rather than guessing', () => {
    const p = sealed();
    expect(codes(validateForExecution(p, ctx(p, { now: 'now' })))).toEqual(['CONTEXT_INVALID']);
    expect(codes(validateForExecution(p, ctx(p, { statusMaxAgeMs: -1 })))).toEqual(['CONTEXT_INVALID']);
    expect(codes(validateForExecution(p, ctx(p, { statusMaxAgeMs: Number.NaN })))).toEqual(['CONTEXT_INVALID']);
    expect(codes(validateForExecution(p, ctx(p, { scope: { tenantId: 'x', workspaceId: 'y', businessId: 'z' } })))).toEqual(['CONTEXT_INVALID']);
  });

  it('never trusts a package that is structurally invalid, whatever the status says', () => {
    const p: any = clone(sealed());
    delete p.accountableOwner;
    expect(validateForExecution(p, ctx(p as AuthorizedActionPackageV1)).valid).toBe(false);
  });
});

describe('action-type contract interface', () => {
  it('accepts a well-formed contract and rejects malformed ones', () => {
    expect(validateActionTypeContract(ADJUST_PRICE)).toEqual([]);
    expect(validateActionTypeContract({ ...ADJUST_PRICE, code: 'Bad Code' }).length).toBeGreaterThan(0);
    expect(validateActionTypeContract({ ...ADJUST_PRICE, schemaVersion: 'v1' }).length).toBeGreaterThan(0);
    expect(validateActionTypeContract({ ...ADJUST_PRICE, targetKinds: [] }).length).toBeGreaterThan(0);
    expect(validateActionTypeContract({ ...ADJUST_PRICE, governanceImpact: { ghost: ['COST'] } }).join()).toMatch(/undeclared parameter ghost/);
    expect(validateActionTypeContract({ ...ADJUST_PRICE, governanceImpact: { newPrice: ['VIBES' as never] } }).join()).toMatch(/unknown governance dimension/);
    expect(validateActionTypeContract({ ...ADJUST_PRICE, applicability: { budget: 'MAYBE' as never } }).join()).toMatch(/applicability rule/);
    expect(validateActionTypeContract({ ...ADJUST_PRICE, parameters: { x: { type: 'integer', required: true, min: 5, max: 1 } } }).join()).toMatch(/range/);
  });

  it('the in-memory registry refuses duplicates and invalid contracts, and resolves by (code, schemaVersion)', () => {
    const r = new InMemoryActionTypeRegistry([ADJUST_PRICE]);
    expect(r.resolve('adjust_price', '1')).toBe(ADJUST_PRICE);
    expect(r.resolve('adjust_price', '2')).toBeNull();
    expect(r.supports('adjust_price', '1')).toBe(true);
    expect(r.supports('adjust_price', '2')).toBe(false);
    expect(() => r.register(ADJUST_PRICE)).toThrow(/duplicate/);
    expect(() => r.register({ ...ADJUST_PRICE, code: 'BAD' })).toThrow(/invalid action type contract/);
  });

  it.each([
    [{ type: 'string', required: true, maxLength: 3 }, 'abc', 'abcd'],
    [{ type: 'integer', required: true, min: 1, max: 3 }, 2, 4],
    [{ type: 'number', required: true, min: 0 }, 0.5, -1],
    [{ type: 'decimal_string', required: true }, '-12.50', '12,50'],
    [{ type: 'boolean', required: true }, true, 'true'],
    [{ type: 'enum', required: true, values: ['a', 'b'] }, 'a', 'c'],
    [{ type: 'identifier', required: true }, 'SKU-1.a:b', 'has space'],
  ] as const)('checks %j', (spec, good, bad) => {
    expect(checkParameterValue(spec as never, good as never)).toEqual([]);
    expect(checkParameterValue(spec as never, bad as never).length).toBeGreaterThan(0);
  });

  it('derives required governance dimensions: declared impact, explicit empty impact, and conservative full for unknown (R-7)', () => {
    expect(requiredGovernanceDimensions(ADJUST_PRICE, ['newPrice'])).toEqual({ dimensions: ['RISK', 'COST', 'EXPECTED_OUTCOME'].sort((a, b) => GOVERNANCE_DIMENSIONS.indexOf(a as never) - GOVERNANCE_DIMENSIONS.indexOf(b as never)), basis: 'DECLARED_IMPACT' });
    expect(requiredGovernanceDimensions(ADJUST_PRICE, ['note'])).toEqual({ dimensions: [], basis: 'DECLARED_IMPACT' });
    expect(requiredGovernanceDimensions(ADJUST_PRICE, ['sku'])).toEqual({ dimensions: [...GOVERNANCE_DIMENSIONS], basis: 'CONSERVATIVE_FULL' });
    expect(requiredGovernanceDimensions(ADJUST_PRICE, ['newPrice', 'sku']).basis).toBe('CONSERVATIVE_FULL');
    expect(requiredGovernanceDimensions(ADJUST_PRICE, ['toString'])).toEqual({ dimensions: [...GOVERNANCE_DIMENSIONS], basis: 'CONSERVATIVE_FULL' });
  });
});
