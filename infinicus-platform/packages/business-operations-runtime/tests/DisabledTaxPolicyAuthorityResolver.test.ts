import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  TAX_POLICY_ACTIVATION_ENABLED, resolveDisabledTaxPolicy,
  type TaxPolicyResolutionInput, type TaxPolicyFixture, type TaxClassificationFixture,
} from '../src/commerce/DisabledTaxPolicyAuthorityResolver.js';

const scope = { tenantId: 'tenant-a', workspaceId: 'workspace-a', businessId: 'business-a' };
const start = '2026-10-01T00:00:00.000Z';
const end = '2026-11-01T00:00:00.000Z';
const digest = `sha256:${'a'.repeat(64)}`;
const policy: TaxPolicyFixture = { ...scope, id: 'policy-a', version: 1, state: 'active', effectiveFrom: start,
  effectiveUntil: end, jurisdictionId: 'synthetic-jurisdiction', currencyCode: 'USD', currencyExponent: 2,
  authorityReference: 'synthetic-approval', provenanceDigest: digest };
const classification: TaxClassificationFixture = { ...scope, id: 'class-a', version: 1, state: 'active',
  sellableKind: 'BO_PRODUCT', sellableId: 'product-a', policyId: policy.id, policyVersion: policy.version,
  effectiveFrom: start, effectiveUntil: end, taxClass: 'TAXABLE', priceTreatment: 'EXCLUSIVE', provenanceDigest: digest };
const input = (): TaxPolicyResolutionInput => ({ ...scope, trustedBoAt: start, currencyCode: 'USD',
  policyReference: { id: policy.id, version: policy.version },
  classificationReference: { id: classification.id, version: classification.version },
  sellableKind: 'BO_PRODUCT', sellableId: 'product-a', policies: [{ ...policy }], classifications: [{ ...classification }] });
const reasons = (fixture: TaxPolicyResolutionInput) => resolveDisabledTaxPolicy(fixture).reasons;

describe('disabled synthetic BO tax-policy authority resolver', () => {
  it('resolves exact half-open effective boundaries without granting authority', () => {
    const atStart = resolveDisabledTaxPolicy(input());
    expect(atStart).toMatchObject({ authoritative: false, activationAllowed: false, status: 'CANDIDATE',
      reasons: ['AUTHORIZATION_DISABLED'], candidate: { policy: { id: 'policy-a', version: 1, currencyExponent: 2 },
        classification: { taxClass: 'TAXABLE', priceTreatment: 'EXCLUSIVE' } } });
    expect(TAX_POLICY_ACTIVATION_ENABLED).toBe(false);
    expect(reasons({ ...input(), trustedBoAt: '2026-10-31T23:59:59.999Z' })).toEqual(['AUTHORIZATION_DISABLED']);
    expect(reasons({ ...input(), trustedBoAt: end })).toContain('POLICY_EXPIRED');
    expect(reasons({ ...input(), trustedBoAt: '2026-09-30T23:59:59.999Z' })).toContain('POLICY_MISSING');
  });

  it('rejects missing, overlapping, revoked, expired and stale policy versions', () => {
    expect(reasons({ ...input(), policies: [] })).toContain('POLICY_MISSING');
    expect(reasons({ ...input(), policies: [policy, { ...policy, id: 'policy-b', version: 2 }] })).toContain('POLICY_OVERLAP');
    expect(reasons({ ...input(), policies: [policy, { ...policy, effectiveFrom: '2026-11-01T00:00:00.000Z', effectiveUntil: null }] }))
      .toContain('POLICY_VERSION_CONFLICT');
    expect(reasons({ ...input(), policies: [{ ...policy, state: 'revoked' }] })).toContain('POLICY_REVOKED');
    expect(reasons({ ...input(), policyReference: { id: 'old-policy', version: 1 } })).toContain('POLICY_REFERENCE_STALE');
    expect(reasons({ ...input(), trustedBoAt: 'not-a-date' })).toContain('INVALID_INPUT');
  });

  it('rejects foreign tenant, workspace or business fixtures', () => {
    for (const field of ['tenantId', 'workspaceId', 'businessId'] as const) {
      const foreign = { ...policy, [field]: 'foreign' };
      expect(reasons({ ...input(), policies: [foreign] })).toContain('FOREIGN_SCOPE');
      expect(reasons({ ...input(), classifications: [{ ...classification, [field]: 'foreign' }] })).toContain('FOREIGN_SCOPE');
    }
  });

  it('resolves inclusive/exclusive, exempt/zero-rated separately and refuses unknown classes', () => {
    for (const taxClass of ['EXEMPT', 'ZERO_RATED'] as const) {
      for (const priceTreatment of ['INCLUSIVE', 'EXCLUSIVE'] as const) {
        const result = resolveDisabledTaxPolicy({ ...input(), classifications: [{ ...classification, taxClass, priceTreatment }] });
        expect(result.candidate?.classification).toMatchObject({ taxClass, priceTreatment });
        expect(result.activationAllowed).toBe(false);
      }
    }
    expect(reasons({ ...input(), classifications: [{ ...classification, taxClass: 'UNKNOWN' as never }] })).toContain('UNKNOWN_CLASSIFICATION');
    expect(reasons({ ...input(), classifications: [{ ...classification, priceTreatment: 'UNKNOWN' as never }] })).toContain('UNKNOWN_TREATMENT');
    expect(reasons({ ...input(), classifications: [] })).toContain('CLASSIFICATION_MISSING');
    expect(reasons({ ...input(), classifications: [{ ...classification, state: 'revoked' }] })).toContain('CLASSIFICATION_REVOKED');
    expect(reasons({ ...input(), classificationReference: { id: 'old-class', version: 1 } })).toContain('CLASSIFICATION_REFERENCE_STALE');
  });

  it('rejects overlapping/expired classification and stale policy binding', () => {
    expect(reasons({ ...input(), classifications: [classification, { ...classification, id: 'class-b', version: 2 }] }))
      .toContain('CLASSIFICATION_OVERLAP');
    expect(reasons({ ...input(), classifications: [classification, { ...classification, effectiveFrom: end, effectiveUntil: null }] }))
      .toContain('CLASSIFICATION_VERSION_CONFLICT');
    expect(reasons({ ...input(), classifications: [{ ...classification, effectiveUntil: start }] })).toContain('INVALID_INPUT');
    expect(reasons({ ...input(), classifications: [{ ...classification, effectiveUntil: '2026-10-02T00:00:00.000Z' }],
      trustedBoAt: '2026-10-03T00:00:00.000Z' })).toContain('CLASSIFICATION_EXPIRED');
    expect(reasons({ ...input(), classifications: [{ ...classification, policyVersion: 2 }] })).toContain('CLASSIFICATION_REFERENCE_STALE');
  });

  it('rejects unsupported or mismatched currency precision and invalid provenance', () => {
    expect(reasons({ ...input(), currencyCode: 'ZZZ' })).toContain('CURRENCY_PRECISION_UNSUPPORTED');
    expect(reasons({ ...input(), policies: [{ ...policy, currencyExponent: 3 }] })).toContain('CURRENCY_PRECISION_UNSUPPORTED');
    expect(reasons({ ...input(), policies: [{ ...policy, provenanceDigest: 'bad' }] })).toContain('PROVENANCE_INVALID');
    expect(reasons({ ...input(), classifications: [{ ...classification, provenanceDigest: 'bad' }] })).toContain('PROVENANCE_INVALID');
  });

  it('is deterministic under repeated calls and input mutations change only candidate/refusal results', () => {
    const fixture = input();
    expect(resolveDisabledTaxPolicy(fixture)).toEqual(resolveDisabledTaxPolicy(fixture));
    const mutated = resolveDisabledTaxPolicy({ ...fixture, policies: [{ ...policy, state: 'revoked' }] });
    expect(mutated.status).toBe('REFUSED');
    expect(mutated.activationAllowed).toBe(false);
  });

  it('has no production POS call site', () => {
    for (const path of [
      '../../database/src/repositories/bo/OrderRepository.ts',
      '../../database/src/repositories/bo/OfflineSaleRepository.ts',
      '../../../apps/api/src/routes/orders.ts',
      '../../../apps/api/src/routes/offlineSales.ts',
    ]) {
      expect(readFileSync(new URL(path, import.meta.url), 'utf8')).not.toContain('resolveDisabledTaxPolicy');
    }
  });
});
