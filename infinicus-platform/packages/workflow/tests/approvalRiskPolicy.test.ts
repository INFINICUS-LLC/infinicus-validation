import { describe, expect, it } from 'vitest';
import {
  APPROVER_ROLE_TIER, DEFAULT_APPROVAL_RISK_POLICY, RISK_CLASSES, UNCLASSIFIED_RISK_FALLBACK,
  approverTier, evaluateApproval, requirementFor,
} from '../src/approvalRiskPolicy.js';

const approve = (riskClass: unknown, roleCode: string | null) => evaluateApproval({ riskClass, roleCode, outcome: 'approve' });

describe('action-risk approval policy (pure)', () => {
  it('low risk: any tiered approver may approve', () => {
    for (const role of ['cashier', 'manager', 'approver', 'business-owner']) expect(approve('low', role).allowed).toBe(true);
  });

  it('medium risk: cashier is denied, manager and owner are allowed', () => {
    expect(approve('medium', 'cashier').allowed).toBe(false);
    expect(approve('medium', 'manager').allowed).toBe(true);
    expect(approve('medium', 'approver').allowed).toBe(true);
    expect(approve('medium', 'business-owner').allowed).toBe(true);
  });

  it('high and critical risk: only the business owner tier may approve', () => {
    for (const risk of ['high', 'critical']) {
      for (const role of ['cashier', 'manager', 'approver']) expect(approve(risk, role).allowed).toBe(false);
      expect(approve(risk, 'business-owner').allowed).toBe(true);
    }
  });

  it('the low-risk and high-risk paths differ for the same approver', () => {
    expect(approve('low', 'manager').allowed).toBe(true);
    expect(approve('high', 'manager').allowed).toBe(false);
  });

  it('approve_with_modifications is gated exactly like approve', () => {
    expect(evaluateApproval({ riskClass: 'high', roleCode: 'manager', outcome: 'approve_with_modifications' }).allowed).toBe(false);
    expect(evaluateApproval({ riskClass: 'high', roleCode: 'business-owner', outcome: 'approve_with_modifications' }).allowed).toBe(true);
  });

  it('reject is always allowed, even for the lowest or an unknown role and the highest risk', () => {
    for (const role of ['cashier', 'nonsense', null]) {
      expect(evaluateApproval({ riskClass: 'critical', roleCode: role, outcome: 'reject' }).allowed).toBe(true);
    }
  });

  it('fails closed: missing, unknown or non-string risk resolves to the fallback and is flagged unclassified', () => {
    expect(UNCLASSIFIED_RISK_FALLBACK).toBe('high');
    for (const risk of [undefined, null, '', 'LOW', 'trivial', 0, {}]) {
      const req = requirementFor(risk);
      expect(req.riskClass).toBe('high');
      expect(req.unclassified).toBe(true);
      expect(approve(risk, 'manager').allowed).toBe(false);
      expect(approve(risk, 'business-owner').allowed).toBe(true);
    }
  });

  it('fails closed: unknown, null and prototype-key roles have tier 0 and cannot approve anything', () => {
    for (const role of ['nonsense', '', null, undefined, 'toString', '__proto__', 'constructor']) {
      expect(approverTier(role as string | null | undefined)).toBe(0);
      expect(approve('low', role as string | null).allowed).toBe(false);
    }
  });

  it('fails closed: a malformed policy never silently allows approval', () => {
    const broken = { minimumApproverTier: { low: Number.NaN, medium: 0, high: -1, critical: undefined } } as never;
    for (const risk of RISK_CLASSES) {
      expect(evaluateApproval({ riskClass: risk, roleCode: 'business-owner', outcome: 'approve', policy: broken }).allowed).toBe(false);
    }
  });

  it('default policy is complete and tiers are ordered', () => {
    for (const risk of RISK_CLASSES) expect(DEFAULT_APPROVAL_RISK_POLICY.minimumApproverTier[risk]).toBeGreaterThanOrEqual(1);
    expect(APPROVER_ROLE_TIER['business-owner']).toBeGreaterThan(APPROVER_ROLE_TIER.manager);
    expect(APPROVER_ROLE_TIER.manager).toBeGreaterThan(APPROVER_ROLE_TIER.cashier);
  });
});
