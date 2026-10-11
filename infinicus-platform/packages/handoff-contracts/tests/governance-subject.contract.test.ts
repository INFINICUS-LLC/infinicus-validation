import { describe, expect, it } from 'vitest';
import { GOVERNANCE_SUBJECT_CANONICAL_VERSION, canonicalGovernanceSubject, computeGovernanceSubjectDigest } from '../src/authorized-action-package';
import type { GovernanceSubject } from '../src/authorized-action-package';

const subject = (over: Partial<GovernanceSubject> = {}): GovernanceSubject => ({
  actionType: { code: 'inventory_reorder_policy_update', schemaVersion: '1' },
  target: { kind: 'inventory_item', id: 'sku-1' },
  finalParameters: { reorderPoint: 15, reorderQuantity: 60 },
  ...over,
});

describe('governance subject digest (evidence is bound to exact values)', () => {
  it('is sha256:<64 hex>, deterministic, and versioned', () => {
    const d = computeGovernanceSubjectDigest(subject());
    expect(d).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(computeGovernanceSubjectDigest(subject())).toBe(d);
    expect(GOVERNANCE_SUBJECT_CANONICAL_VERSION).toBe('governance-subject/1');
  });

  it('does not depend on property order', () => {
    const reordered: GovernanceSubject = {
      finalParameters: { reorderQuantity: 60, reorderPoint: 15 },
      target: { id: 'sku-1', kind: 'inventory_item' },
      actionType: { schemaVersion: '1', code: 'inventory_reorder_policy_update' },
    };
    expect(computeGovernanceSubjectDigest(reordered)).toBe(computeGovernanceSubjectDigest(subject()));
  });

  it('differs for different final parameters, target, action type or schema version', () => {
    const base = computeGovernanceSubjectDigest(subject());
    const variants: GovernanceSubject[] = [
      subject({ finalParameters: { reorderPoint: 16, reorderQuantity: 60 } }),
      subject({ finalParameters: { reorderPoint: 15, reorderQuantity: 61 } }),
      subject({ finalParameters: { reorderPoint: 15 } }),
      subject({ target: { kind: 'inventory_item', id: 'sku-2' } }),
      subject({ target: { kind: 'other_item', id: 'sku-1' } }),
      subject({ actionType: { code: 'inventory_reorder_policy_update', schemaVersion: '2' } }),
      subject({ actionType: { code: 'other_action', schemaVersion: '1' } }),
    ];
    const digests = new Set([base, ...variants.map(computeGovernanceSubjectDigest)]);
    expect(digests.size).toBe(variants.length + 1);
  });

  it('ignores properties outside the subject, so identity and time can never change what an evaluation is about', () => {
    const polluted = { ...subject(), actionId: 'x', tenantId: 'y', evaluatedAt: 'z' } as unknown as GovernanceSubject;
    expect(computeGovernanceSubjectDigest(polluted)).toBe(computeGovernanceSubjectDigest(subject()));
    expect(Object.keys(canonicalGovernanceSubject(polluted)).sort()).toEqual(['actionType', 'finalParameters', 'target']);
  });
});
