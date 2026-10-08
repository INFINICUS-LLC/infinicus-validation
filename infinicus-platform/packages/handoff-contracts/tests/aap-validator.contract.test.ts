import { describe, expect, it } from 'vitest';
import {
  AuthorizedActionPackageInvalidError, computePackageDigest, computePackageExpiry, sealAuthorizedActionPackage,
  validateAuthorizedActionPackage, validatePackageBody, GOVERNANCE_DIMENSIONS,
} from '../src';
import type { AapErrorCode, AapValidationResult } from '../src';
import { ADJUST_PRICE, approvedBody, clone, ID, modifiedBody, na, registry, T, val } from './aap-fixtures';

const opts = (now?: string) => ({ actionTypes: registry(), ...(now ? { now } : {}) });
const codes = (r: AapValidationResult): AapErrorCode[] => r.errors.map((e) => e.code);
const has = (r: AapValidationResult, code: AapErrorCode, pathFragment = ''): boolean => r.errors.some((e) => e.code === code && e.path.includes(pathFragment));
const body = () => approvedBody() as unknown as Record<string, any>;
const mbody = () => modifiedBody() as unknown as Record<string, any>;

describe('valid packages', () => {
  it('an approved package validates and seals', () => {
    expect(validatePackageBody(approvedBody(), opts(T.nowOk))).toEqual({ valid: true, errors: [] });
    const sealed = sealAuthorizedActionPackage(approvedBody(), opts(T.nowOk));
    expect(sealed.integrity).toEqual({ canonicalVersion: 'aap-canonical/1', algorithm: 'sha256', digest: computePackageDigest(approvedBody()) });
    expect(validateAuthorizedActionPackage(sealed, opts(T.nowOk))).toEqual({ valid: true, errors: [] });
  });

  it('an approve_with_modifications package with structured delta and fresh evaluation validates and seals', () => {
    expect(validatePackageBody(modifiedBody(), opts(T.nowOk))).toEqual({ valid: true, errors: [] });
    expect(validateAuthorizedActionPackage(sealAuthorizedActionPackage(modifiedBody(), opts()), opts())).toEqual({ valid: true, errors: [] });
  });

  it('validates without a supplied time (time-dependent rules are then not applied)', () => {
    expect(validatePackageBody(approvedBody(), opts()).valid).toBe(true);
  });
});

describe('required UNAVAILABLE fields are refused (R-4)', () => {
  const unavailable = (source: string) => ({ state: 'UNAVAILABLE', source });
  it.each([
    ['accountable owner', (b: any) => { b.accountableOwner = unavailable('owner assignment'); }, '$.accountableOwner'],
    ['owner identity', (b: any) => { b.accountableOwner.identity.userId = unavailable('identity'); }, '$.accountableOwner.identity.userId'],
    ['exact parameters', (b: any) => { b.action.parameters = unavailable('parameter authoring'); }, '$.action.parameters'],
    ['automation level', (b: any) => { b.action.automationLevel = unavailable('ABA automation policy'); }, '$.action.automationLevel'],
    ['automation policy ref', (b: any) => { b.action.automationLevel.policy = unavailable('policy'); }, '$.action.automationLevel.policy'],
    ['approver', (b: any) => { b.authorization.approver = unavailable('assignment'); }, '$.authorization.approver'],
    ['permission used', (b: any) => { b.authorization.permissionUsed = unavailable('audit'); }, '$.authorization.permissionUsed'],
    ['risk class', (b: any) => { b.authorization.risk.riskClass = unavailable('risk'); }, '$.authorization.risk.riskClass'],
    ['recommendation lineage', (b: any) => { b.lineage.recommendation = unavailable('lineage'); }, '$.lineage.recommendation'],
    ['action type', (b: any) => { b.action.type = unavailable('vocabulary'); }, '$.action.type'],
    ['correlation id', (b: any) => { b.trace.correlationId = unavailable('request'); }, '$.trace.correlationId'],
    ['an UNAVAILABLE governed state (instead of VALUE / NOT_APPLICABLE)', (b: any) => { b.action.budget = unavailable('budget source'); }, '$.action.budget'],
    ['a nested array element', (b: any) => { b.action.monitoring.value.metrics[0] = unavailable('metrics'); }, '$.action.monitoring.value.metrics[0]'],
  ])('%s', (_n, mutate, path) => {
    const b = body();
    mutate(b);
    const r = validatePackageBody(b, opts());
    expect(r.valid).toBe(false);
    expect(has(r, 'REQUIRED_FIELD_UNAVAILABLE', path)).toBe(true);
    expect(() => sealAuthorizedActionPackage(b, opts())).toThrow(AuthorizedActionPackageInvalidError);
  });

  it('refuses to seal and reports every unavailable field, never issuing a knowingly non-executable package', () => {
    const b = body();
    b.accountableOwner = unavailable('owner');
    b.action.automationLevel = unavailable('policy');
    try {
      sealAuthorizedActionPackage(b, opts());
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AuthorizedActionPackageInvalidError);
      expect((e as AuthorizedActionPackageInvalidError).errors.filter((x) => x.code === 'REQUIRED_FIELD_UNAVAILABLE')).toHaveLength(2);
    }
  });
});

describe('governed NOT_APPLICABLE (D-6)', () => {
  it('is accepted where the action type allows it', () => {
    const b = body();
    b.action.executionWindow = na('NO_WINDOW');
    b.action.preconditions = na('NO_PRECONDITIONS');
    b.action.monitoring = na('NO_MONITORING_POLICY');
    // Without a window end the only bound is the decision valid_until.
    b.validity.expiryBounds = [{ source: 'DECISION_VALID_UNTIL', at: T.validUntil }];
    b.validity.expiresAt = val(T.validUntil);
    expect(validatePackageBody(b, opts(T.nowOk))).toEqual({ valid: true, errors: [] });
  });

  it('is refused where the action type requires the field (rollback is not listed, so it is REQUIRED)', () => {
    const b = body();
    b.action.rollback = na('IRREVERSIBLE', 'cannot be rolled back');
    const r = validatePackageBody(b, opts());
    expect(has(r, 'NOT_APPLICABLE_NOT_PERMITTED', '$.action.rollback')).toBe(true);
  });

  it('requires a governed reason (code and statement)', () => {
    const b = body();
    b.action.budget = { state: 'NOT_APPLICABLE', reason: { code: 'lower', statement: '' } };
    const r = validatePackageBody(b, opts());
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.path.startsWith('$.action.budget.reason'))).toBe(true);
  });

  it('rejects an unknown applicability state and extra fields on a governed field', () => {
    const b = body();
    b.action.budget = { state: 'MAYBE' };
    expect(has(validatePackageBody(b, opts()), 'INVALID_VALUE', '$.action.budget.state')).toBe(true);
    const c = body();
    c.action.budget = { state: 'NOT_APPLICABLE', reason: { code: 'NO_SPEND', statement: 's' }, value: { amount: '1', currency: 'USD' } };
    expect(has(validatePackageBody(c, opts()), 'UNKNOWN_FIELD', '$.action.budget.value')).toBe(true);
  });

  it('a VALUE governed field must hold a valid value', () => {
    const b = body();
    b.action.budget = val({ amount: '-5', currency: 'usd' });
    const r = validatePackageBody(b, opts());
    expect(has(r, 'INVALID_FORMAT', '$.action.budget.value.amount')).toBe(true);
    expect(has(r, 'INVALID_FORMAT', '$.action.budget.value.currency')).toBe(true);
  });
});

describe('contract versioning (forward-compatible)', () => {
  it('rejects an unsupported contract version without interpreting the rest', () => {
    for (const v of ['aap/2', 'aap/1.1', '', 'AAP/1']) {
      const b = body();
      b.contractVersion = v;
      const r = validatePackageBody(b, opts());
      expect(codes(r)).toEqual(['UNSUPPORTED_CONTRACT_VERSION']);
    }
    const missing = body();
    delete missing.contractVersion;
    expect(codes(validatePackageBody(missing, opts()))).toEqual(['UNSUPPORTED_CONTRACT_VERSION']);
  });

  it('rejects an unsupported canonical version and digest algorithm on a sealed package', () => {
    const sealed: any = clone(sealAuthorizedActionPackage(approvedBody(), opts()));
    sealed.integrity.canonicalVersion = 'aap-canonical/2';
    expect(has(validateAuthorizedActionPackage(sealed, opts()), 'UNSUPPORTED_CANONICAL_VERSION')).toBe(true);
    const other: any = clone(sealAuthorizedActionPackage(approvedBody(), opts()));
    other.integrity.algorithm = 'sha512';
    expect(has(validateAuthorizedActionPackage(other, opts()), 'UNSUPPORTED_DIGEST_ALGORITHM')).toBe(true);
  });

  it('rejects unknown fields at every level (an unsigned extension cannot be smuggled in)', () => {
    // Inside the authorization / owner / trace blocks structural errors are reported under the domain code.
    for (const [mutate, code] of [
      [(b: any) => { b.extra = 1; }, 'UNKNOWN_FIELD'],
      [(b: any) => { b.action.extra = 1; }, 'UNKNOWN_FIELD'],
      [(b: any) => { b.validity.freshness.extra = 1; }, 'UNKNOWN_FIELD'],
      [(b: any) => { b.authorization.risk.extra = 1; }, 'PROVENANCE_INVALID'],
      [(b: any) => { b.accountableOwner.extra = 1; }, 'OWNER_INVALID'],
      [(b: any) => { b.integrity = { canonicalVersion: 'aap-canonical/1', algorithm: 'sha256', digest: 'sha256:' + '0'.repeat(64) }; }, 'UNKNOWN_FIELD'],
    ] as Array<[(b: any) => void, AapErrorCode]>) {
      const b = body();
      mutate(b);
      const r = validatePackageBody(b, opts());
      expect(r.valid).toBe(false);
      expect(has(r, code)).toBe(true);
    }
  });

  it('is single-use in v1: any other consumption mode is unsupported', () => {
    const b = body();
    b.consumption.mode = 'MULTI_USE';
    expect(has(validatePackageBody(b, opts()), 'UNSUPPORTED_CONSUMPTION_MODE')).toBe(true);
  });
});

describe('action type and parameters (R-1)', () => {
  it('rejects an unknown action type and an unknown schema version', () => {
    const b = body();
    b.action.type.code = 'launch_rocket';
    expect(has(validatePackageBody(b, opts()), 'ACTION_TYPE_UNKNOWN')).toBe(true);
    const c = body();
    c.action.type.schemaVersion = '2';
    expect(has(validatePackageBody(c, opts()), 'ACTION_TYPE_UNKNOWN')).toBe(true);
  });

  it('rejects undeclared, missing and malformed parameters and a wrong target kind', () => {
    const undeclared = body();
    undeclared.action.parameters.surprise = 1;
    expect(has(validatePackageBody(undeclared, opts()), 'ACTION_PARAMETER_UNKNOWN', 'surprise')).toBe(true);
    const missing = body();
    delete missing.action.parameters.sku;
    expect(has(validatePackageBody(missing, opts()), 'ACTION_PARAMETER_MISSING', 'sku')).toBe(true);
    const bad = body();
    bad.action.parameters.newPrice = 10;
    expect(has(validatePackageBody(bad, opts()), 'ACTION_PARAMETER_INVALID', 'newPrice')).toBe(true);
    const target = body();
    target.action.target.kind = 'warehouse';
    expect(has(validatePackageBody(target, opts()), 'ACTION_TARGET_KIND_INVALID')).toBe(true);
  });

  it('rejects credential-like and dangerous keys inside parameters', () => {
    const cred = body();
    cred.action.parameters.apiKey = 'x';
    expect(has(validatePackageBody(cred, opts()), 'FORBIDDEN_VALUE', 'apiKey')).toBe(true);
    const danger = JSON.parse('{"__proto__": {"x": 1}}');
    const b = body();
    b.action.parameters = danger;
    expect(has(validatePackageBody(b, opts()), 'FORBIDDEN_VALUE')).toBe(true);
  });

  it('rejects values outside the canonical JSON domain', () => {
    const b = body();
    b.action.parameters.note = undefined;
    expect(has(validatePackageBody(b, opts()), 'FORBIDDEN_VALUE')).toBe(true);
    const c = body();
    c.action.parameters.note = new Date();
    expect(has(validatePackageBody(c, opts()), 'FORBIDDEN_VALUE')).toBe(true);
  });
});

describe('owner and provenance shape', () => {
  it.each([
    ['owner user id not a uuid', (b: any) => { b.accountableOwner.identity.userId = 'not-a-uuid'; }],
    ['owner membership missing', (b: any) => { delete b.accountableOwner.identity.membershipId; }],
    ['owner unknown field', (b: any) => { b.accountableOwner.nickname = 'x'; }],
    ['owner assignment timestamp malformed', (b: any) => { b.accountableOwner.assignment.assignedAt = '2026-10-08'; }],
    ['owner role empty', (b: any) => { b.accountableOwner.roleCode = ' '; }],
  ])('%s is rejected as OWNER_INVALID', (_n, mutate) => {
    const b = body();
    mutate(b);
    expect(has(validatePackageBody(b, opts()), 'OWNER_INVALID', '$.accountableOwner')).toBe(true);
  });

  it.each([
    ['approver user id malformed', (b: any) => { b.authorization.approver.userId = 'x'; }],
    ['authority provenance missing', (b: any) => { delete b.authorization.authorityProvenance; }],
    ['permission malformed', (b: any) => { b.authorization.permissionUsed = 'ABA WRITE'; }],
    ['decision status unknown', (b: any) => { b.authorization.decisionStatus = 'rejected'; }],
    ['approval audit event id missing', (b: any) => { delete b.authorization.approvalAuditEventId; }],
    ['correlation id empty', (b: any) => { b.trace.correlationId = ''; }],
  ])('%s is rejected as PROVENANCE_INVALID', (_n, mutate) => {
    const b = body();
    mutate(b);
    expect(has(validatePackageBody(b, opts()), 'PROVENANCE_INVALID')).toBe(true);
  });

  it('rejects an inconsistent risk record', () => {
    const b = body();
    b.authorization.risk = { riskClass: 'low', basis: 'UNCLASSIFIED_FAIL_CLOSED_HIGH', requiredApproverTier: 3, approverTier: 3 };
    expect(has(validatePackageBody(b, opts()), 'RISK_INCONSISTENT')).toBe(true);
    const c = body();
    c.authorization.risk.approverTier = 1;
    expect(has(validatePackageBody(c, opts()), 'RISK_INCONSISTENT')).toBe(true);
    const ok = body();
    ok.authorization.risk = { riskClass: 'high', basis: 'UNCLASSIFIED_FAIL_CLOSED_HIGH', requiredApproverTier: 3, approverTier: 3 };
    expect(validatePackageBody(ok, opts()).valid).toBe(true);
  });
});

describe('modification lineage (D-2, R-7)', () => {
  it('a plain approval must not carry a modification or evaluation, and must authorize exactly the proposal', () => {
    const withMod = body();
    withMod.lineage.modification = modifiedBody().lineage.modification;
    expect(has(validatePackageBody(withMod, opts()), 'MODIFICATION_NOT_ALLOWED')).toBe(true);
    const drift = body();
    drift.action.parameters.newPrice = '99.00';
    expect(has(validatePackageBody(drift, opts()), 'MODIFICATION_LINEAGE_INCONSISTENT', '$.action.parameters')).toBe(true);
  });

  it('a plain approval with no ADI proposal is valid (ABA authored the whole set)', () => {
    const b = body();
    b.lineage.proposedParameters = na('NO_ADI_PROPOSAL', 'ADI supplied no governed parameters');
    expect(validatePackageBody(b, opts()).valid).toBe(true);
  });

  it('approve_with_modifications requires a structured modification and the original set', () => {
    const noMod = mbody();
    noMod.lineage.modification = na('NONE');
    expect(has(validatePackageBody(noMod, opts()), 'MODIFICATION_REQUIRED')).toBe(true);
    const noOriginal = mbody();
    noOriginal.lineage.proposedParameters = na('NO_ADI_PROPOSAL');
    expect(has(validatePackageBody(noOriginal, opts()), 'MODIFICATION_LINEAGE_INCONSISTENT', 'proposedParameters')).toBe(true);
  });

  it('the effective parameters must be exactly the original with the recorded delta applied', () => {
    const sneaky = mbody();
    sneaky.action.parameters.newPrice = '1.00';
    expect(has(validatePackageBody(sneaky, opts()), 'MODIFICATION_LINEAGE_INCONSISTENT', '$.action.parameters')).toBe(true);
    const extra = mbody();
    extra.action.parameters.note = 'unrecorded change';
    expect(has(validatePackageBody(extra, opts()), 'MODIFICATION_LINEAGE_INCONSISTENT', '$.action.parameters')).toBe(true);
  });

  it.each([
    ['SET with a wrong `before`', (b: any) => { b.lineage.modification.value.changes[0].before = '11.00'; }],
    ['SET that changes nothing', (b: any) => { b.lineage.modification.value.changes[0].after = '10.00'; b.action.parameters.newPrice = '10.00'; }],
    ['SET without `after`', (b: any) => { delete b.lineage.modification.value.changes[0].after; }],
    ['ADD of an existing parameter', (b: any) => { b.lineage.modification.value.changes[0] = { parameter: 'newPrice', operation: 'ADD', after: '9.50' }; }],
    ['REMOVE with an `after`', (b: any) => { b.lineage.modification.value.changes[0] = { parameter: 'newPrice', operation: 'REMOVE', before: '10.00', after: '1' }; }],
    ['the same parameter changed twice', (b: any) => { b.lineage.modification.value.changes.push({ parameter: 'newPrice', operation: 'SET', before: '10.00', after: '9.50' }); }],
  ])('%s is inconsistent', (_n, mutate) => {
    const b = mbody();
    mutate(b);
    expect(has(validatePackageBody(b, opts()), 'MODIFICATION_LINEAGE_INCONSISTENT')).toBe(true);
  });

  it('supports ADD and REMOVE operations that reproduce the final set', () => {
    const b = mbody();
    b.lineage.proposedParameters.value.parameters = { sku: 'SKU-100', newPrice: '10.00', note: 'old' };
    b.lineage.modification.value.changes = [
      { parameter: 'newPrice', operation: 'SET', before: '10.00', after: '9.50' },
      { parameter: 'note', operation: 'REMOVE', before: 'old' },
    ];
    // `note` has a declared empty impact; `newPrice` needs COST/RISK/EXPECTED_OUTCOME (already evidenced).
    expect(validatePackageBody(b, opts()).valid).toBe(true);
    const c = mbody();
    c.action.parameters.note = 'new';
    c.lineage.modification.value.changes.push({ parameter: 'note', operation: 'ADD', after: 'new' });
    expect(validatePackageBody(c, opts()).valid).toBe(true);
  });

  it('requires fresh evaluation for the declared impact dimensions of the changed parameters', () => {
    const missing = mbody();
    missing.lineage.modificationEvaluation = na('NONE');
    expect(has(validatePackageBody(missing, opts()), 'MODIFICATION_EVALUATION_MISSING')).toBe(true);
    const partial = mbody();
    partial.lineage.modificationEvaluation.value.evidence = partial.lineage.modificationEvaluation.value.evidence.slice(0, 2);
    const r = validatePackageBody(partial, opts());
    expect(has(r, 'MODIFICATION_EVALUATION_MISSING', 'evidence')).toBe(true);
  });

  it('treats a parameter with undeclared impact conservatively: every dimension must be re-evaluated', () => {
    const b = mbody();
    b.lineage.proposedParameters.value.parameters = { sku: 'SKU-100', newPrice: '10.00' };
    b.action.parameters = { sku: 'SKU-200', newPrice: '10.00' };
    b.action.target.id = 'SKU-200';
    b.lineage.modification.value.changes = [{ parameter: 'sku', operation: 'SET', before: 'SKU-100', after: 'SKU-200' }];
    // basis says DECLARED_IMPACT with 3 dimensions; `sku` is unmapped so the rule demands CONSERVATIVE_FULL and all dimensions.
    const wrong = validatePackageBody(b, opts());
    expect(has(wrong, 'MODIFICATION_EVALUATION_INVALID', 'basis')).toBe(true);
    expect(has(wrong, 'MODIFICATION_EVALUATION_MISSING')).toBe(true);
    b.lineage.modificationEvaluation = val({
      basis: 'CONSERVATIVE_FULL',
      evidence: GOVERNANCE_DIMENSIONS.map((dimension) => ({ dimension, evaluatedAt: T.evaluated, result: 'PASSED', evidenceRef: { kind: 'evaluation', id: ID.evidence } })),
    });
    expect(validatePackageBody(b, opts()).valid).toBe(true);
  });

  it('a modification touching only a parameter with a declared EMPTY impact needs no evaluation', () => {
    const b = mbody();
    b.lineage.proposedParameters.value.parameters = { sku: 'SKU-100', newPrice: '9.50', note: 'a' };
    b.action.parameters = { sku: 'SKU-100', newPrice: '9.50', note: 'b' };
    b.lineage.modification.value.changes = [{ parameter: 'note', operation: 'SET', before: 'a', after: 'b' }];
    b.lineage.modificationEvaluation = na('NO_GOVERNED_IMPACT', 'declared impact is empty');
    expect(validatePackageBody(b, opts()).valid).toBe(true);
  });

  it('an evaluation that predates the modification is not fresh; one after issuance is invalid; duplicates are invalid', () => {
    const stale = mbody();
    stale.lineage.modificationEvaluation.value.evidence[0].evaluatedAt = '2026-10-08T08:00:00.000Z';
    expect(has(validatePackageBody(stale, opts()), 'MODIFICATION_EVALUATION_INVALID', 'evidence[0]')).toBe(true);
    const late = mbody();
    late.lineage.modificationEvaluation.value.evidence[0].evaluatedAt = '2026-10-08T10:30:00.000Z';
    expect(has(validatePackageBody(late, opts()), 'MODIFICATION_EVALUATION_INVALID', 'evidence[0]')).toBe(true);
    const dup = mbody();
    dup.lineage.modificationEvaluation.value.evidence.push(clone(dup.lineage.modificationEvaluation.value.evidence[0]));
    expect(has(validatePackageBody(dup, opts()), 'MODIFICATION_EVALUATION_INVALID', 'evidence[3]')).toBe(true);
  });
});

describe('validity and expiry (R-6)', () => {
  it('computes the earliest applicable bound', () => {
    expect(computePackageExpiry([])).toBeNull();
    expect(computePackageExpiry([{ source: 'DECISION_VALID_UNTIL', at: T.validUntil }, { source: 'EXECUTION_WINDOW_END', at: T.windowEnd }])).toBe(T.windowEnd);
    expect(computePackageExpiry([{ source: 'EXPLICIT_PACKAGE_EXPIRY', at: '2026-10-08T11:00:00.000Z' }, { source: 'EXECUTION_WINDOW_END', at: T.windowEnd }])).toBe('2026-10-08T11:00:00.000Z');
  });

  it('expiresAt must be the earliest bound; bounds must match their sources', () => {
    const wrongMin = body();
    wrongMin.validity.expiresAt = val(T.validUntil);
    expect(has(validatePackageBody(wrongMin, opts()), 'EXPIRY_MISMATCH', 'expiresAt')).toBe(true);
    const phantom = body();
    phantom.validity.expiryBounds.push({ source: 'EXPLICIT_PACKAGE_EXPIRY', at: '2026-10-08T10:30:00.000Z' });
    expect(has(validatePackageBody(phantom, opts()), 'EXPIRY_MISMATCH', 'expiresAt')).toBe(true);
    const dropped = body();
    dropped.validity.expiryBounds = [dropped.validity.expiryBounds[1]];
    expect(has(validatePackageBody(dropped, opts()), 'EXPIRY_MISMATCH', 'expiryBounds')).toBe(true);
    const dupe = body();
    dupe.validity.expiryBounds.push(clone(dupe.validity.expiryBounds[0]));
    expect(has(validatePackageBody(dupe, opts()), 'EXPIRY_MISMATCH', 'expiryBounds[2]')).toBe(true);
  });

  it('an explicit earlier package expiry is honoured', () => {
    const b = body();
    b.validity.expiryBounds.push({ source: 'EXPLICIT_PACKAGE_EXPIRY', at: '2026-10-08T11:00:00.000Z' });
    b.validity.expiresAt = val('2026-10-08T11:00:00.000Z');
    expect(validatePackageBody(b, opts(T.nowOk)).valid).toBe(true);
  });

  it('with no applicable bound expiresAt is NOT_APPLICABLE (and only then)', () => {
    const b = body();
    b.validity.isTimeSensitive = false;
    b.validity.decisionValidUntil = na('NOT_TIME_SENSITIVE');
    b.action.executionWindow = val({ startsAt: T.windowStart, endsAt: null });
    b.validity.expiryBounds = [];
    // 'no source found' is never a basis: without an authoritative applicability basis the claim is refused.
    b.validity.expiresAt = na('NO_VALIDITY_BOUND');
    expect(has(validatePackageBody(b, opts(T.nowOk)), 'NOT_APPLICABLE_NOT_PERMITTED', 'expiresAt')).toBe(true);
    b.validity.expiresAt = val(T.windowEnd);
    expect(has(validatePackageBody(b, opts()), 'EXPIRY_MISMATCH', 'expiresAt')).toBe(true);
  });

  it('a time-sensitive decision must carry valid_until; a Twin reference must be assessed fresh', () => {
    const b = body();
    b.validity.decisionValidUntil = na('NONE');
    expect(has(validatePackageBody(b, opts()), 'VALIDITY_INCONSISTENT', 'decisionValidUntil')).toBe(true);
    const twin = body();
    twin.validity.freshness.twin = 'NOT_APPLICABLE';
    expect(has(validatePackageBody(twin, opts()), 'VALIDITY_INCONSISTENT', 'freshness.twin')).toBe(true);
    const noTwin = body();
    noTwin.lineage.twinSnapshotId = na('NO_TWIN');
    expect(has(validatePackageBody(noTwin, opts()), 'VALIDITY_INCONSISTENT', 'freshness.twin')).toBe(true);
  });

  it('rejects an expired package when a validation time is supplied (database time), and one issued in the future', () => {
    const b = approvedBody();
    expect(has(validatePackageBody(b, opts(T.windowEnd)), 'PACKAGE_EXPIRED')).toBe(true);
    expect(has(validatePackageBody(b, opts('2026-10-09T00:00:00.000Z')), 'PACKAGE_EXPIRED')).toBe(true);
    expect(validatePackageBody(b, opts('2026-10-08T11:59:59.999Z')).valid).toBe(true);
    expect(has(validatePackageBody(b, opts('2026-10-08T09:00:00.000Z')), 'ISSUED_IN_FUTURE')).toBe(true);
  });

  it('refuses to seal a package that would already be expired at issuance', () => {
    const b = body();
    b.validity.expiryBounds = [{ source: 'EXPLICIT_PACKAGE_EXPIRY', at: '2026-10-08T09:30:00.000Z' }, ...b.validity.expiryBounds];
    b.validity.expiresAt = val('2026-10-08T09:30:00.000Z');
    expect(has(validatePackageBody(b, opts()), 'PACKAGE_EXPIRED', 'expiresAt')).toBe(true);
  });

  it('rejects a malformed supplied time and impossible windows and timelines', () => {
    expect(has(validatePackageBody(approvedBody(), opts('2026-10-08')), 'CONTEXT_INVALID')).toBe(true);
    const win = body();
    win.action.executionWindow = val({ startsAt: T.windowEnd, endsAt: T.windowStart });
    expect(has(validatePackageBody(win, opts()), 'WINDOW_INVALID')).toBe(true);
    const timeline = body();
    timeline.authorization.decidedAt = '2026-10-08T11:00:00.000Z';
    expect(has(validatePackageBody(timeline, opts()), 'TIMELINE_INCONSISTENT', 'decidedAt')).toBe(true);
  });

  it('timestamps must be in the single canonical UTC millisecond form', () => {
    for (const bad of ['2026-10-08T10:00:00Z', '2026-10-08T10:00:00.000+00:00', '2026-10-08 10:00:00.000', '2026-02-30T10:00:00.000Z']) {
      const b = body();
      b.issuance.issuedAt = bad;
      expect(has(validatePackageBody(b, opts()), 'INVALID_FORMAT', 'issuedAt')).toBe(true);
    }
  });
});

describe('integrity: a caller cannot substitute package fields after the digest is generated', () => {
  const sealed = () => clone(sealAuthorizedActionPackage(approvedBody(), opts())) as unknown as Record<string, any>;

  it('any post-seal field change is a DIGEST_MISMATCH', () => {
    for (const mutate of [
      (p: any) => { p.action.parameters.newPrice = '0.01'; },
      (p: any) => { p.scope.businessId = ID.otherTenant; },
      (p: any) => { p.accountableOwner.identity.userId = ID.approver; },
      (p: any) => { p.authorization.approver.userId = ID.owner; },
      (p: any) => { p.authorization.risk.riskClass = 'low'; },
      (p: any) => { p.action.budget = val({ amount: '1000000', currency: 'USD' }); },
      (p: any) => { p.lineage.decision.decisionId = ID.recommendation; },
      (p: any) => { p.validity.expiresAt = val('2026-10-08T12:30:00.000Z'); },
      (p: any) => { p.identity.packageVersion = 2; },
      (p: any) => { p.trace.correlationId = 'forged'; },
    ]) {
      const p = sealed();
      mutate(p);
      const r = validateAuthorizedActionPackage(p, opts());
      expect(codes(r).includes('DIGEST_MISMATCH') || !r.valid, 'tampered package must not validate').toBe(true);
      expect(r.valid).toBe(false);
    }
  });

  it('a structurally valid substitution is caught by the digest specifically', () => {
    const p = sealed();
    p.action.parameters.newPrice = '0.01';
    p.lineage.proposedParameters.value.parameters.newPrice = '0.01';
    const r = validateAuthorizedActionPackage(p, opts());
    expect(codes(r)).toEqual(['DIGEST_MISMATCH']);
  });

  it('swapping in another package\'s digest does not help', () => {
    const a = sealed();
    const other = clone(sealAuthorizedActionPackage((() => { const b = body(); b.identity.packageId = ID.otherPackage; return b; })(), opts())) as unknown as Record<string, any>;
    a.integrity.digest = other.integrity.digest;
    expect(codes(validateAuthorizedActionPackage(a, opts()))).toEqual(['DIGEST_MISMATCH']);
  });

  it('rejects a missing or malformed integrity block', () => {
    const none = sealed();
    delete none.integrity;
    expect(has(validateAuthorizedActionPackage(none, opts()), 'MISSING_FIELD', '$.integrity')).toBe(true);
    for (const digest of ['sha256:abc', 'SHA256:' + '0'.repeat(64), 'sha256:' + 'G'.repeat(64), '', 5]) {
      const p = sealed();
      p.integrity.digest = digest;
      expect(codes(validateAuthorizedActionPackage(p, opts())).some((c) => c === 'DIGEST_MALFORMED' || c === 'INVALID_TYPE')).toBe(true);
    }
  });

  it('a digest cannot launder an otherwise invalid package', () => {
    const b = body();
    b.action.type.code = 'launch_rocket';
    const forged = { ...clone(b), integrity: { canonicalVersion: 'aap-canonical/1', algorithm: 'sha256', digest: computePackageDigest(b as any) } };
    const r = validateAuthorizedActionPackage(forged, opts());
    expect(r.valid).toBe(false);
    expect(has(r, 'ACTION_TYPE_UNKNOWN')).toBe(true);
  });

  it('non-object input is rejected', () => {
    for (const bad of [null, undefined, 5, 'x', []]) {
      expect(validateAuthorizedActionPackage(bad, opts()).valid).toBe(false);
      expect(validatePackageBody(bad, opts()).valid).toBe(false);
    }
  });
});

describe('the action-type contract fixture itself', () => {
  it('is a well-formed contract', () => {
    expect(() => registry()).not.toThrow();
    expect(ADJUST_PRICE.code).toBe('adjust_price');
  });
});
