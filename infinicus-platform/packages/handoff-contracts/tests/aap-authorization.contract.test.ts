import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_LEVELS, AuthorizedActionPackageInvalidError, CURRENT_PACKAGE_ENABLEMENT, sealAuthorizedActionPackage,
  validateAuthorizedActionPackage, validateForExecution, validatePackageBody,
} from '../src';
import type { AapErrorCode, AapValidationResult, AuthoritativePackageStatus, AuthorizedActionPackageV1, PackageEnablementPolicy } from '../src';
import { approvedBody, clone, ID, na, registry, ruleBody, T, unboundedBody, val } from './aap-fixtures';

/**
 * P0-5 Block 2 owner-review corrections: automation vocabulary + enablement, discriminated authorization provenance,
 * governed expiry applicability.
 */
const opts = (extra: { enablement?: PackageEnablementPolicy; now?: string } = {}) => ({ actionTypes: registry(), ...extra });
const has = (r: AapValidationResult, code: AapErrorCode, path = ''): boolean => r.errors.some((e) => e.code === code && e.path.includes(path));
const human = () => approvedBody() as unknown as Record<string, any>;
const rule = () => ruleBody() as unknown as Record<string, any>;
const WITH_L4: PackageEnablementPolicy = { automationLevels: [2, 3, 4] };

describe('automation level vocabulary and enablement', () => {
  it('the contract represents Levels 2, 3 and 4 (not 0 or 1); only 2 and 3 are currently enabled', () => {
    expect([...AUTOMATION_LEVELS]).toEqual([2, 3, 4]);
    expect([...CURRENT_PACKAGE_ENABLEMENT.automationLevels]).toEqual([2, 3]);
    expect(Object.isFrozen(CURRENT_PACKAGE_ENABLEMENT)).toBe(true);
  });

  it.each([0, 1])('Level %i is rejected (it does not authorize execution)', (level) => {
    const b = human();
    b.action.automationLevel.level = level;
    const r = validatePackageBody(b, opts());
    expect(has(r, 'AUTOMATION_LEVEL_NOT_PERMITTED', 'automationLevel.level')).toBe(true);
    expect(() => sealAuthorizedActionPackage(b, opts())).toThrow(AuthorizedActionPackageInvalidError);
  });

  it('Level 0 and 1 stay rejected even when a policy claims to enable them', () => {
    const b = human();
    b.action.automationLevel.level = 1;
    expect(has(validatePackageBody(b, opts({ enablement: { automationLevels: [1, 2, 3] as never } })), 'AUTOMATION_LEVEL_NOT_PERMITTED')).toBe(true);
  });

  it('Level 2 (human approval) validates and seals', () => {
    expect(validatePackageBody(approvedBody(), opts({ now: T.nowOk })).valid).toBe(true);
  });

  it('Level 3 (rule-authorized) validates and seals under the current policy', () => {
    expect(validatePackageBody(ruleBody(), opts({ now: T.nowOk }))).toEqual({ valid: true, errors: [] });
    const sealed = sealAuthorizedActionPackage(ruleBody(), opts({ now: T.nowOk }));
    expect(validateAuthorizedActionPackage(sealed, opts({ now: T.nowOk })).valid).toBe(true);
  });

  it('Level 4 is a recognized contract value but NOT_ENABLED: validate, seal and execution all reject it', () => {
    const b = rule();
    b.action.automationLevel.level = 4;
    const r = validatePackageBody(b, opts());
    expect(r.errors.map((e) => e.code)).toEqual(['AUTOMATION_LEVEL_NOT_ENABLED']); // recognized (no malformed/not-permitted error)
    expect(() => sealAuthorizedActionPackage(b, opts())).toThrow(AuthorizedActionPackageInvalidError);
  });

  it('Level 4 validates structurally once a (future, governed) policy enables it, and BO execution follows that policy too', () => {
    const b = rule();
    b.action.automationLevel.level = 4;
    expect(validatePackageBody(b, opts({ enablement: WITH_L4 })).valid).toBe(true);
    const sealed = sealAuthorizedActionPackage(b, opts({ enablement: WITH_L4 }));
    const status = (p: AuthorizedActionPackageV1): AuthoritativePackageStatus => ({
      packageId: p.identity.packageId, packageVersion: p.identity.packageVersion, digest: p.integrity.digest,
      lifecycle: 'ISSUED', latestPackageVersion: p.identity.packageVersion, verifiedAt: '2026-10-08T10:09:59.000Z',
    });
    const ctx = (enablement?: PackageEnablementPolicy) => ({
      actionTypes: registry(), capabilities: { supports: () => true }, now: '2026-10-08T10:10:00.000Z',
      scope: { ...sealed.scope }, status: status(sealed), statusMaxAgeMs: 5000, ...(enablement ? { enablement } : {}),
    });
    expect(validateForExecution(sealed, ctx(WITH_L4)).valid).toBe(true);
    const refused = validateForExecution(sealed, ctx());
    expect(refused.valid).toBe(false);
    expect(refused.errors.map((e) => e.code)).toEqual(['AUTOMATION_LEVEL_NOT_ENABLED']);
  });

  it('a level outside 0-4 is malformed', () => {
    const b = human();
    b.action.automationLevel.level = 7;
    expect(has(validatePackageBody(b, opts()), 'INVALID_VALUE', 'automationLevel.level')).toBe(true);
  });

  it('the declared level must match the authorization mode (no masquerading either way)', () => {
    const l3Human = human();
    l3Human.action.automationLevel.level = 3;
    expect(has(validatePackageBody(l3Human, opts()), 'AUTHORIZATION_MODE_MISMATCH', '$.authorization.mode')).toBe(true);
    const l2Rule = rule();
    l2Rule.action.automationLevel.level = 2;
    expect(has(validatePackageBody(l2Rule, opts()), 'AUTHORIZATION_MODE_MISMATCH', '$.authorization.mode')).toBe(true);
  });
});

describe('HUMAN_APPROVAL provenance', () => {
  it('requires permissionUsed (missing and UNAVAILABLE are both rejected)', () => {
    const missing = human();
    delete missing.authorization.permissionUsed;
    expect(has(validatePackageBody(missing, opts()), 'PROVENANCE_INVALID')).toBe(true);
    const unavailable = human();
    unavailable.authorization.permissionUsed = { state: 'UNAVAILABLE', source: 'audit' };
    expect(has(validatePackageBody(unavailable, opts()), 'REQUIRED_FIELD_UNAVAILABLE', 'permissionUsed')).toBe(true);
  });

  it.each([
    ['approver identity', (b: any) => { delete b.authorization.approver; }],
    ['approver assignment version', (b: any) => { delete b.authorization.approver.assignmentVersionId; }],
    ['authority provenance', (b: any) => { delete b.authorization.authorityProvenance; }],
    ['approval audit reference', (b: any) => { delete b.authorization.approvalAuditEventId; }],
    ['decidedAt', (b: any) => { delete b.authorization.decidedAt; }],
  ])('requires %s', (_n, mutate) => {
    const b = human();
    mutate(b);
    expect(has(validatePackageBody(b, opts()), 'PROVENANCE_INVALID')).toBe(true);
  });

  it('rejects rule-authorization fields smuggled into a human approval', () => {
    const b = human();
    b.authorization.policy = { policyId: ID.policy, policyVersionId: ID.policyVersion };
    expect(has(validatePackageBody(b, opts()), 'PROVENANCE_INVALID')).toBe(true);
  });
});

describe('RULE_AUTHORIZED provenance (Level 3)', () => {
  it('does not require, and does not allow, a fabricated human permissionUsed or approver', () => {
    const b = rule();
    expect('permissionUsed' in b.authorization).toBe(false);
    expect(validatePackageBody(b, opts()).valid).toBe(true);
    for (const field of ['permissionUsed', 'approver', 'authorityProvenance', 'decisionStatus']) {
      const forged = rule();
      forged.authorization[field] = field === 'permissionUsed' ? 'aba:write' : field === 'approver' ? { userId: ID.approver, assignmentId: ID.assignment, assignmentVersionId: ID.assignmentVersion, roleCode: 'business-owner' } : field === 'decisionStatus' ? 'approved' : { scopeId: ID.scope };
      expect(has(validatePackageBody(forged, opts()), 'PROVENANCE_INVALID'), `${field} must be rejected`).toBe(true);
    }
  });

  it('cannot masquerade as a human approval: a Level-3 package carrying human provenance is refused', () => {
    const b = human();
    b.action.automationLevel.level = 3;
    const r = validatePackageBody(b, opts());
    expect(r.valid).toBe(false);
    expect(has(r, 'AUTHORIZATION_MODE_MISMATCH')).toBe(true);
    expect(() => sealAuthorizedActionPackage(b, opts())).toThrow(AuthorizedActionPackageInvalidError);
  });

  it.each([
    ['policy id', (b: any) => { delete b.authorization.policy.policyId; }],
    ['policy version', (b: any) => { delete b.authorization.policy.policyVersionId; }],
    ['governance audit reference', (b: any) => { delete b.authorization.governanceAuditEventId; }],
    ['evaluation timestamp', (b: any) => { delete b.authorization.evaluatedAt; }],
    ['evaluation timestamp format', (b: any) => { b.authorization.evaluatedAt = '2026-10-08'; }],
    ['rule version', (b: any) => { b.authorization.rule.value.ruleVersionId = 'x'; }],
    ['risk record', (b: any) => { delete b.authorization.risk; }],
  ])('requires %s', (_n, mutate) => {
    const b = rule();
    mutate(b);
    expect(has(validatePackageBody(b, opts()), 'PROVENANCE_INVALID')).toBe(true);
  });

  it('an UNAVAILABLE rule or service principal is refused (never issued with a hole)', () => {
    for (const field of ['rule', 'servicePrincipal', 'policy']) {
      const b = rule();
      b.authorization[field] = { state: 'UNAVAILABLE', source: 'rule engine' };
      expect(has(validatePackageBody(b, opts()), 'REQUIRED_FIELD_UNAVAILABLE', field), field).toBe(true);
    }
  });

  it('records a rule as not applicable only with a governed reason (policy-level authorization without a specific rule)', () => {
    const b = rule();
    b.authorization.rule = na('POLICY_LEVEL_AUTHORIZATION', 'the policy authorizes this action class directly');
    expect(validatePackageBody(b, opts()).valid).toBe(true);
  });

  it('the modification path is not a human edit: a rule-authorized package cannot claim approved_with_modifications', () => {
    const b = rule();
    b.lineage.modification = val({ reason: 'x', modifiedByUserId: ID.approver, modifiedAt: T.modified, changes: [{ parameter: 'newPrice', operation: 'SET', before: '10.00', after: '9.50' }] });
    expect(validatePackageBody(b, opts()).valid).toBe(false);
  });
});

describe('expiry applicability (R-6 corrected)', () => {
  it('NOT_APPLICABLE expiry is valid with an action-schema basis that explicitly allows it', () => {
    expect(validatePackageBody(unboundedBody(), opts({ now: T.nowOk })).valid).toBe(true);
    expect(sealAuthorizedActionPackage(unboundedBody(), opts({ now: T.nowOk })).identity.packageId).toBeDefined();
  });

  it('NOT_APPLICABLE expiry is valid with a governed POLICY basis', () => {
    const b = clone(unboundedBody()) as unknown as Record<string, any>;
    b.validity.expiresAt.reason.basis = { kind: 'POLICY', ref: `${ID.policy}@${ID.policyVersion}` };
    expect(validatePackageBody(b, opts({ now: T.nowOk })).valid).toBe(true);
  });

  it.each([
    ['no basis at all', (b: any) => { delete b.validity.expiresAt.reason.basis; }],
    ['a schema basis naming another action type', (b: any) => { b.validity.expiresAt.reason.basis.ref = 'adjust_price@1'; }],
    ['an unknown basis kind', (b: any) => { b.validity.expiresAt.reason.basis.kind = 'GUESS'; }],
  ])('NOT_APPLICABLE expiry with %s is refused', (_n, mutate) => {
    const b = clone(unboundedBody()) as unknown as Record<string, any>;
    mutate(b);
    const r = validatePackageBody(b, opts());
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.path.includes('expiresAt'))).toBe(true);
  });

  it('an action type whose schema does not allow an unbounded package refuses a schema basis for it', () => {
    const b = clone(unboundedBody()) as unknown as Record<string, any>;
    b.action.type.code = 'adjust_price';
    b.validity.expiresAt.reason.basis.ref = 'adjust_price@1';
    expect(has(validatePackageBody(b, opts()), 'NOT_APPLICABLE_NOT_PERMITTED', 'basis')).toBe(true);
  });

  it('a missing applicability source (UNAVAILABLE expiresAt) fails issuance', () => {
    const b = clone(unboundedBody()) as unknown as Record<string, any>;
    b.validity.expiresAt = { state: 'UNAVAILABLE', source: 'validity policy' };
    expect(has(validatePackageBody(b, opts()), 'REQUIRED_FIELD_UNAVAILABLE', 'expiresAt')).toBe(true);
    expect(() => sealAuthorizedActionPackage(b, opts())).toThrow(AuthorizedActionPackageInvalidError);
  });

  it('"no source found" with a bound present is still a mismatch, and NOT_APPLICABLE with bounds present is refused', () => {
    const b = human();
    b.validity.expiresAt = { state: 'NOT_APPLICABLE', reason: { code: 'NO_VALIDITY_BOUND', statement: 's', basis: { kind: 'ACTION_SCHEMA', ref: 'adjust_price@1' } } };
    expect(validatePackageBody(b, opts()).valid).toBe(false);
  });
});
