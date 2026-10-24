import { minorUnitsOf } from '@infinicus/database';

/** Synthetic-fixture resolver only. No caller can turn this into a tax-policy activation. */
export const TAX_POLICY_ACTIVATION_ENABLED = false as const;

type Scope = { tenantId: string; workspaceId: string; businessId: string };
type Reference = { id: string; version: number };
type FixtureState = 'active' | 'draft' | 'revoked';
export type TaxClass = 'TAXABLE' | 'ZERO_RATED' | 'EXEMPT';
export type PriceTreatment = 'INCLUSIVE' | 'EXCLUSIVE';

export interface TaxPolicyFixture extends Scope, Reference {
  state: FixtureState;
  effectiveFrom: string;
  effectiveUntil: string | null;
  jurisdictionId: string;
  currencyCode: string;
  currencyExponent: number;
  authorityReference: string;
  provenanceDigest: string;
}

export interface TaxClassificationFixture extends Scope, Reference {
  state: FixtureState;
  sellableKind: 'BO_PRODUCT' | 'PLATFORM_PRODUCT' | 'PLATFORM_SERVICE' | 'CUSTOM_LINE';
  sellableId: string;
  policyId: string;
  policyVersion: number;
  effectiveFrom: string;
  effectiveUntil: string | null;
  taxClass: TaxClass;
  priceTreatment: PriceTreatment;
  provenanceDigest: string;
}

export interface TaxPolicyResolutionInput extends Scope {
  trustedBoAt: string;
  currencyCode: string;
  policyReference: Reference;
  classificationReference: Reference;
  sellableKind: TaxClassificationFixture['sellableKind'];
  sellableId: string;
  policies: readonly TaxPolicyFixture[];
  classifications: readonly TaxClassificationFixture[];
}

export type TaxPolicyRefusal =
  | 'INVALID_INPUT' | 'FOREIGN_SCOPE' | 'POLICY_MISSING' | 'POLICY_EXPIRED'
  | 'POLICY_REVOKED' | 'POLICY_OVERLAP' | 'POLICY_REFERENCE_STALE'
  | 'POLICY_VERSION_CONFLICT'
  | 'CLASSIFICATION_MISSING' | 'CLASSIFICATION_EXPIRED' | 'CLASSIFICATION_REVOKED'
  | 'CLASSIFICATION_OVERLAP' | 'CLASSIFICATION_REFERENCE_STALE'
  | 'CLASSIFICATION_VERSION_CONFLICT'
  | 'UNKNOWN_CLASSIFICATION' | 'UNKNOWN_TREATMENT' | 'CURRENCY_PRECISION_UNSUPPORTED'
  | 'PROVENANCE_INVALID' | 'AUTHORIZATION_DISABLED';

export interface TaxPolicyCandidate {
  readonly policy: Reference & { jurisdictionId: string; currencyCode: string; currencyExponent: number; provenanceDigest: string; authorityReference: string };
  readonly classification: Reference & { sellableKind: TaxClassificationFixture['sellableKind']; sellableId: string;
    taxClass: TaxClass; priceTreatment: PriceTreatment; provenanceDigest: string };
  readonly trustedBoAt: string;
  readonly scope: Scope;
}

export interface TaxPolicyResolution {
  readonly authoritative: false;
  readonly activationAllowed: false;
  readonly status: 'CANDIDATE' | 'REFUSED';
  readonly candidate: TaxPolicyCandidate | null;
  readonly reasons: readonly TaxPolicyRefusal[];
}

const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const at = (value: string): number | null => {
  if (!UTC.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : null;
};
const sameScope = (a: Scope, b: Scope) => a.tenantId === b.tenantId && a.workspaceId === b.workspaceId && a.businessId === b.businessId;
const validRef = (value: Reference) => !!value.id && Number.isSafeInteger(value.version) && value.version > 0;
const validInterval = (value: { effectiveFrom: string; effectiveUntil: string | null }) => {
  const start = at(value.effectiveFrom);
  const end = value.effectiveUntil === null ? null : at(value.effectiveUntil);
  return start !== null && (value.effectiveUntil === null || (end !== null && end > start));
};
const duplicateVersion = (values: readonly Reference[]) => {
  const seen = new Set<string>();
  for (const value of values) {
    const key = `${value.id}\u0000${value.version}`;
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
};
const covers = (value: { effectiveFrom: string; effectiveUntil: string | null }, instant: number) =>
  at(value.effectiveFrom)! <= instant && (value.effectiveUntil === null || instant < at(value.effectiveUntil)!);

/** Resolve synthetic policy fixtures, never an authoritative BO calculation or permission check. */
export function resolveDisabledTaxPolicy(input: TaxPolicyResolutionInput): TaxPolicyResolution {
  const reasons = new Set<TaxPolicyRefusal>();
  const refuse = (): TaxPolicyResolution => ({ authoritative: false, activationAllowed: false,
    status: 'REFUSED', candidate: null, reasons: [...reasons, 'AUTHORIZATION_DISABLED'] });
  const instant = at(input.trustedBoAt);
  if (instant === null || !input.tenantId || !input.workspaceId || !input.businessId ||
      !input.sellableId || !validRef(input.policyReference) || !validRef(input.classificationReference)) {
    reasons.add('INVALID_INPUT'); return refuse();
  }
  const expectedExponent = minorUnitsOf(input.currencyCode);
  if (expectedExponent === null) reasons.add('CURRENCY_PRECISION_UNSUPPORTED');
  const scopedPolicies = input.policies.filter((p) => sameScope(p, input));
  if (input.policies.some((p) => !sameScope(p, input) && p.id === input.policyReference.id && p.version === input.policyReference.version))
    reasons.add('FOREIGN_SCOPE');
  if (scopedPolicies.some((p) => !validRef(p) || !validInterval(p))) reasons.add('INVALID_INPUT');
  if (duplicateVersion(scopedPolicies)) reasons.add('POLICY_VERSION_CONFLICT');
  if (reasons.has('INVALID_INPUT')) return refuse();
  const currentPolicies = scopedPolicies.filter((p) => p.state === 'active' && covers(p, instant));
  if (currentPolicies.length > 1) reasons.add('POLICY_OVERLAP');
  if (currentPolicies.length === 0) {
    const revoked = scopedPolicies.some((p) => p.id === input.policyReference.id && p.state === 'revoked' && covers(p, instant));
    const expired = scopedPolicies.some((p) => p.id === input.policyReference.id && at(p.effectiveUntil ?? '') !== null && at(p.effectiveUntil!)! <= instant);
    reasons.add(revoked ? 'POLICY_REVOKED' : expired ? 'POLICY_EXPIRED' : 'POLICY_MISSING');
  }
  if (reasons.size > 0) return refuse();
  const policy = currentPolicies[0];
  if (policy.id !== input.policyReference.id || policy.version !== input.policyReference.version)
    reasons.add('POLICY_REFERENCE_STALE');
  if (policy.currencyCode !== input.currencyCode || policy.currencyExponent !== expectedExponent)
    reasons.add('CURRENCY_PRECISION_UNSUPPORTED');
  if (!policy.jurisdictionId || !policy.authorityReference || !DIGEST.test(policy.provenanceDigest))
    reasons.add('PROVENANCE_INVALID');

  const scopedClasses = input.classifications.filter((c) => sameScope(c, input) &&
    c.sellableKind === input.sellableKind && c.sellableId === input.sellableId);
  if (input.classifications.some((c) => !sameScope(c, input) && c.id === input.classificationReference.id && c.version === input.classificationReference.version))
    reasons.add('FOREIGN_SCOPE');
  if (scopedClasses.some((c) => !validRef(c) || !validInterval(c))) reasons.add('INVALID_INPUT');
  if (duplicateVersion(scopedClasses)) reasons.add('CLASSIFICATION_VERSION_CONFLICT');
  if (reasons.has('INVALID_INPUT')) return refuse();
  const currentClasses = scopedClasses.filter((c) => c.state === 'active' && covers(c, instant));
  if (currentClasses.length > 1) reasons.add('CLASSIFICATION_OVERLAP');
  if (currentClasses.length === 0) {
    const revoked = scopedClasses.some((c) => c.id === input.classificationReference.id && c.state === 'revoked' && covers(c, instant));
    const expired = scopedClasses.some((c) => c.id === input.classificationReference.id && at(c.effectiveUntil ?? '') !== null && at(c.effectiveUntil!)! <= instant);
    reasons.add(revoked ? 'CLASSIFICATION_REVOKED' : expired ? 'CLASSIFICATION_EXPIRED' : 'CLASSIFICATION_MISSING');
  }
  if (reasons.size > 0) return refuse();
  const classification = currentClasses[0];
  if (classification.id !== input.classificationReference.id || classification.version !== input.classificationReference.version ||
      classification.policyId !== policy.id || classification.policyVersion !== policy.version)
    reasons.add('CLASSIFICATION_REFERENCE_STALE');
  if (!['TAXABLE', 'ZERO_RATED', 'EXEMPT'].includes(classification.taxClass)) reasons.add('UNKNOWN_CLASSIFICATION');
  if (!['INCLUSIVE', 'EXCLUSIVE'].includes(classification.priceTreatment)) reasons.add('UNKNOWN_TREATMENT');
  if (!DIGEST.test(classification.provenanceDigest)) reasons.add('PROVENANCE_INVALID');
  if (reasons.size > 0) return refuse();
  return { authoritative: false, activationAllowed: false, status: 'CANDIDATE',
    reasons: ['AUTHORIZATION_DISABLED'],
    candidate: { scope: { tenantId: input.tenantId, workspaceId: input.workspaceId, businessId: input.businessId },
      trustedBoAt: input.trustedBoAt,
      policy: { id: policy.id, version: policy.version, jurisdictionId: policy.jurisdictionId,
        currencyCode: policy.currencyCode, currencyExponent: policy.currencyExponent,
        provenanceDigest: policy.provenanceDigest, authorityReference: policy.authorityReference },
      classification: { id: classification.id, version: classification.version, sellableKind: classification.sellableKind,
        sellableId: classification.sellableId, taxClass: classification.taxClass,
        priceTreatment: classification.priceTreatment, provenanceDigest: classification.provenanceDigest } } };
}
