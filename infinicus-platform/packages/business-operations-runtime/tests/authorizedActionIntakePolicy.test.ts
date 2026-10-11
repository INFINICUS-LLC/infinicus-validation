import { describe, expect, it } from 'vitest';
import { canonicalActionTypeRegistry } from '@infinicus/handoff-contracts';
import { AuthorizedActionIntakeService, PRODUCTION_BO_CAPABILITIES, PRODUCTION_SUPPORTED_ACTION_TYPES, assessIntake, explicitCapabilities } from '../src/index.js';
import { MIN, answerFor, sealedPackage, type World } from './helpers/intakeFixture.js';

const world: World = { tenantId: '11111111-0000-4000-8000-000000000001', workspaceId: '11111111-0000-4000-8000-000000000002', businessId: '11111111-0000-4000-8000-000000000003', otherBusinessId: '11111111-0000-4000-8000-000000000004' };
const scope = { tenantId: world.tenantId, workspaceId: world.workspaceId, businessId: world.businessId };
const actionTypes = canonicalActionTypeRegistry();
const capabilities = explicitCapabilities(['inventory_reorder_policy_update@1']);
const base = (pkg = sealedPackage(world), over: Partial<Parameters<typeof assessIntake>[0]> = {}) =>
  assessIntake({ document: pkg, scope, actionTypes, capabilities, answer: answerFor(pkg), now: new Date().toISOString(), statusMaxAgeMs: 10_000, ...over });

describe('assessIntake (pure)', () => {
  it('a valid, current, supported package is verified and has no refusals', () => {
    expect(base()).toMatchObject({ identityVerified: true, refusalCodes: [] });
  });
  it('the production capability registry supports nothing, so the same package is verified but not executable', () => {
    expect([...PRODUCTION_SUPPORTED_ACTION_TYPES]).toEqual([]);
    expect(base(undefined, { capabilities: PRODUCTION_BO_CAPABILITIES })).toMatchObject({ identityVerified: true, refusalCodes: ['ACTION_TYPE_UNSUPPORTED_BY_EXECUTOR'] });
  });
  it('a missing answer fails closed without verifying identity', () => {
    expect(base(undefined, { answer: null })).toMatchObject({ identityVerified: false, refusalCodes: ['STATUS_UNVERIFIED'] });
    expect(base(undefined, { answer: undefined })).toMatchObject({ identityVerified: false });
  });
  it('a zero maximum age leaves no tolerance: the answer is already too old', () => {
    const pkg = sealedPackage(world);
    expect(base(pkg, { statusMaxAgeMs: 0 }).identityVerified).toBe(false);
  });
  it('an expired package is identifiable (receipt-worthy) but never executable', () => {
    const pkg = sealedPackage(world, { issuedOffset: -30 * MIN, windowStartOffset: -20 * MIN, windowEndOffset: -MIN });
    const a = base(pkg);
    expect(a.identityVerified).toBe(true);
    expect(a.refusalCodes).toContain('PACKAGE_EXPIRED');
  });
  it('authority states other than CURRENT refuse, and combine with lifecycle refusals', () => {
    const pkg = sealedPackage(world);
    expect(base(pkg, { answer: answerFor(pkg, { authority: { state: 'REVOKED' } }) }).refusalCodes).toEqual(['AUTHORITY_REVOKED']);
    expect(base(pkg, { answer: answerFor(pkg, { status: { lifecycle: 'REVOKED' }, authority: { state: 'REVOKED' } }) }).refusalCodes.sort()).toEqual(['AUTHORITY_REVOKED', 'PACKAGE_REVOKED']);
  });
  it('a different business scope is a SCOPE_MISMATCH and verifies nothing', () => {
    expect(base(undefined, { scope: { ...scope, businessId: world.otherBusinessId } })).toMatchObject({ identityVerified: false, refusalCodes: ['SCOPE_MISMATCH'] });
  });
});

describe('AuthorizedActionIntakeService construction', () => {
  it('requires an explicit, non-negative status max age (no default is invented)', () => {
    const statusProvider = { getStatus: async () => null };
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, undefined as unknown as number]) {
      expect(() => new AuthorizedActionIntakeService({ statusProvider, statusMaxAgeMs: bad })).toThrow(/statusMaxAgeMs/);
    }
    expect(() => new AuthorizedActionIntakeService({ statusProvider, statusMaxAgeMs: 0 })).not.toThrow();
  });
});
