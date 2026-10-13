/** Block B2b - exact decimal arithmetic and the closed rule-set registry (incl. drift against the owner approval record). */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Decimal } from '../src/inventory-policy/decimal.js';
import { INVENTORY_REORDER_POLICY_V1_0_0 as RS, INVENTORY_REORDER_POLICY_V1_1_0 as RS11, approvedRuleSetVersions, resolveApprovedRuleSet } from '../src/inventory-policy/ruleSet.js';

describe('Decimal', () => {
  it('is exact where binary floating point is not', () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect((Decimal.fromNumber(0.1) as Decimal).add(Decimal.fromNumber(0.2) as Decimal).cmp(Decimal.fromNumber(0.3) as Decimal)).toBe(0);
    expect((Decimal.fromNumber(250.1) as Decimal).add(Decimal.fromNumber(249.9) as Decimal).toString()).toBe('500');
    expect((Decimal.fromNumber(0.1) as Decimal).mul(Decimal.of(3)).toString()).toBe('0.3');
  });
  it('parses decimal text and exponents, and refuses everything else', () => {
    expect(Decimal.parse('1e-4')?.toString()).toBe('0.0001');
    expect(Decimal.parse('-12.50')?.toString()).toBe('-12.5');
    expect(Decimal.parse('1.5e2')?.toString()).toBe('150');
    for (const bad of ['NaN', 'Infinity', '', 'abc', '1.', '.5', '1,5']) expect(Decimal.parse(bad)).toBeNull();
    for (const bad of [Number.NaN, Infinity, -Infinity, '1', null, undefined]) expect(Decimal.fromNumber(bad)).toBeNull();
  });
  it('compares, signs and zero-tests', () => {
    expect(Decimal.of(2).cmp(Decimal.of(3))).toBe(-1);
    expect((Decimal.parse('2.50') as Decimal).cmp(Decimal.parse('2.5') as Decimal)).toBe(0);
    expect(Decimal.of(0).isZero()).toBe(true);
    expect((Decimal.parse('-0.0') as Decimal).toString()).toBe('0');
    expect(Decimal.of(-3).abs().toString()).toBe('3');
    expect(Decimal.of(-3).isNegative()).toBe(true);
  });
});

describe('rule-set registry', () => {
  it('has exactly the two approved versions and no default', () => {
    expect(approvedRuleSetVersions()).toEqual(['inventory-reorder-policy/v1.0.0', 'inventory-reorder-policy/v1.1.0']);
    expect(() => resolveApprovedRuleSet(undefined)).toThrow(/no default/);
    expect(() => resolveApprovedRuleSet('')).toThrow();
  });
  it.each(['inventory-reorder-policy/v1.0.1', 'inventory-reorder-policy/v2.0.0', 'inventory-reorder-policy/DRAFT-v1.0.0', 'inventory-reorder-policy/v1.0.0-draft', 'rules-test-1', 'latest'])('refuses %s', (v) => {
    expect(() => resolveApprovedRuleSet(v)).toThrow(/not an approved rule-set version/);
  });
  it('the rule set is immutable at runtime', () => {
    expect(Object.isFrozen(RS)).toBe(true);
    expect(() => { (RS as { orderValueCap: number }).orderValueCap = 1; }).toThrow();
  });
  it('every value equals the owner approval record (drift guard against the section 12 table)', () => {
    const doc = readFileSync(resolve(__dirname, '../../../../docs/architecture/reconciliation/P0-5_B2_RULE_SET_inventory-reorder-policy_v1.0.0.md'), 'utf8');
    const record = doc.slice(doc.indexOf('## 12. Owner approval record'));
    const recorded = (name: string): string => {
      const m = new RegExp(`^\\s*${name}\\s*=\\s*(\\S+)`, 'm').exec(record);
      expect(m, `${name} must appear in the section 12 approval record`).not.toBeNull();
      return m![1];
    };
    expect(Number(recorded('MAX_CHANGE_REORDER_POINT_PCT'))).toBe(RS.maxChangeReorderPointPct);
    expect(Number(recorded('MAX_CHANGE_REORDER_QUANTITY_PCT'))).toBe(RS.maxChangeReorderQuantityPct);
    expect(Number(recorded('ORDER_VALUE_CAP'))).toBe(RS.orderValueCap);
    expect(recorded('ORDER_VALUE_CAP_CURRENCY')).toBe(RS.orderValueCapCurrency);
    expect(Number.parseFloat(recorded('MAX_CHANGE_ORDER_VALUE'))).toBe(RS.maxChangeOrderValuePctOfCap);
    expect(Number(recorded('MAX_IMPLIED_STOCK_UNITS'))).toBe(RS.maxImpliedStockUnits);
    expect(Number(recorded('LEAD_TIME_DAYS'))).toBe(RS.leadTimeDays);
    expect(Number(recorded('SAFETY_FACTOR'))).toBe(RS.safetyFactor);
    expect(Number(recorded('MAX_COVER_DAYS'))).toBe(RS.maxCoverDays);
    expect(recorded('FIRST_CONFIGURATION_OPTION')).toBe(RS.firstConfigurationAllowed ? 'YES' : 'NO');
    expect(doc).toContain(`DEMAND_WINDOW_DAYS = ${RS.demandWindowDays}`);
    expect(doc).toContain(`MIN_DEMAND_OBSERVATIONS = ${RS.minDemandObservations}`);
    expect(doc).toContain('DEMAND_MOVEMENT_TYPES = issue');
    expect(RS.demandMovementTypes).toEqual(['issue']);
    expect(RS.firstConfigurationAllowed).toBe(false);
  });
});

describe('rule set v1.1.0 (adds the proposal policy; every v1.0.0 value unchanged)', () => {
  const doc = readFileSync(resolve(__dirname, '../../../../docs/architecture/reconciliation/P0-5_B2_RULE_SET_inventory-reorder-policy_v1.1.0.md'), 'utf8');
  const record = doc.slice(doc.indexOf('## 12. Owner approval record'));
  const recorded = (name: string): string => { const m = new RegExp(`^\\s*${name}\\s*=\\s*(\\S+)`, 'm').exec(record); expect(m, name).not.toBeNull(); return (m as RegExpExecArray)[1]; };
  it('carries every v1.0.0 value unchanged and only adds the version string and the proposal policy', () => {
    const { version: v0, ...rest0 } = RS; const { version: v1, proposal, ...rest1 } = RS11;
    expect(v0).toBe('inventory-reorder-policy/v1.0.0'); expect(v1).toBe('inventory-reorder-policy/v1.1.0');
    expect(rest1).toEqual(rest0);
    expect(RS.proposal).toBeUndefined(); // v1.0.0 defines no proposal policy: nothing may be proposed from it
    expect(proposal).toBeDefined();
  });
  it('the proposal policy equals the owner approval record, field by field, and is immutable', () => {
    expect(String(RS11.proposal?.unit)).toBe(recorded('PROPOSAL_UNIT'));
    expect(String(RS11.proposal?.maxSteps)).toBe(recorded('PROPOSAL_MAX_STEPS'));
    expect(RS11.proposal?.selection).toBe(recorded('PROPOSAL_SELECTION'));
    expect(RS11.proposal?.combinedCapPriority).toBe(recorded('PROPOSAL_COMBINED_CAP_PRIORITY'));
    expect(Object.isFrozen(RS11)).toBe(true); expect(Object.isFrozen(RS11.proposal)).toBe(true);
    expect(resolveApprovedRuleSet('inventory-reorder-policy/v1.1.0')).toBe(RS11);
  });
});
