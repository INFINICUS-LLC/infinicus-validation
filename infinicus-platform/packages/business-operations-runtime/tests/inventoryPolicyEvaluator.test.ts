/**
 * Block B2b - deterministic unit tests for the pure evaluator (rule set inventory-reorder-policy/v1.0.0). No database, no clock.
 * Demand fixture: SUM 900 over 90 days => stock-out requirement rp x 90 >= 900 x 14 x 1.25 (= 15750) i.e. rp >= 175; cover limit
 * (rp+rq) x 90 <= 900 x 90 i.e. rp+rq <= 900.
 */
import { describe, expect, it } from 'vitest';
import { INVENTORY_REORDER_POLICY_V1_0_0 as RS, type InventoryReorderRuleSet } from '../src/inventory-policy/ruleSet.js';
import { evaluateInventoryReorderPolicy, deriveResult, type Finding, type EvaluatedDimension } from '../src/inventory-policy/evaluate.js';
import { DECLARED_USD, UNDECLARED, subject, snapshot } from './helpers/policyFixture.js';

type Over = { params?: Record<string, unknown>; snap?: Parameters<typeof snapshot>[0]; declared?: typeof DECLARED_USD | typeof UNDECLARED; rs?: Partial<InventoryReorderRuleSet>; subj?: Parameters<typeof subject>[1] };
const run = (o: Over = {}) => evaluateInventoryReorderPolicy({
  subject: subject(o.params ?? { reorderPoint: 120, reorderQuantity: 220 }, o.subj), snapshot: snapshot(o.snap), declaredCurrency: o.declared ?? DECLARED_USD, ruleSet: { ...RS, ...(o.rs ?? {}) },
});
const dim = (out: ReturnType<typeof run>, d: EvaluatedDimension) => out.dimensions.find((x) => x.dimension === d)!;
const rule = (out: ReturnType<typeof run>, d: EvaluatedDimension, r: string): Finding => dim(out, d).findings.find((x) => x.rule === r)!;
/** Parameters that satisfy every rule on the healthy fixture. */
const GOOD = { reorderPoint: 120, reorderQuantity: 220 };

describe('B2b evaluator - shape and derivation', () => {
  it('returns exactly the four authorized dimensions (never REVERSIBILITY) in a fixed order', () => {
    expect(run({ params: { reorderPoint: 180, reorderQuantity: 220 } }).dimensions.map((d) => d.dimension)).toEqual(['CONSTRAINTS', 'RESOURCE_REQUIREMENTS', 'COST', 'EXPECTED_OUTCOME']);
  });
  it('derives FAILED > INDETERMINATE > PASSED and ignores INFORMATIONAL', () => {
    const mk = (outcome: Finding['outcome']): Finding => ({ rule: 'x', outcome, reasonCode: 'c', observed: null, limit: null });
    expect(deriveResult([mk('PASSED'), mk('INDETERMINATE'), mk('FAILED')])).toBe('FAILED');
    expect(deriveResult([mk('PASSED'), mk('INDETERMINATE')])).toBe('INDETERMINATE');
    expect(deriveResult([mk('PASSED'), mk('INFORMATIONAL')])).toBe('PASSED');
    expect(deriveResult([mk('INFORMATIONAL')])).toBe('PASSED');
  });
  it('is deterministic: identical inputs give identical output', () => {
    expect(JSON.stringify(run({ params: GOOD }))).toBe(JSON.stringify(run({ params: GOOD })));
  });
  it('PASSES every dimension when every rule is satisfied', () => {
    const out = run({ params: { reorderPoint: 180, reorderQuantity: 200 }, snap: { balances: [{ id: 'b', warehouseId: 'w', reorderPoint: '150', reorderQuantity: '180' }] } });
    expect(out.dimensions.map((d) => d.result)).toEqual(['PASSED', 'PASSED', 'PASSED', 'PASSED']);
    expect(out.warehouseId).toBe('w');
  });
});

describe('B2b evaluator - target preconditions T1-T3', () => {
  it('wrong target kind FAILS every dimension', () => {
    const out = run({ subj: { target: { kind: 'warehouse', id: '11111111-1111-4111-8111-111111111111' } } });
    for (const d of out.dimensions) expect(d.result).toBe('FAILED');
  });
  it('non-uuid id FAILS', () => { expect(dim(run({ subj: { target: { kind: 'inventory_item', id: 'sku-123' } } }), 'CONSTRAINTS').result).toBe('FAILED'); });
  it('unresolved item is INDETERMINATE (TARGET_UNRESOLVED)', () => {
    const out = run({ snap: { item: null } });
    for (const d of out.dimensions) expect(d.result).toBe('INDETERMINATE');
    expect(rule(out, 'COST', 'T2').reasonCode).toBe('TARGET_UNRESOLVED');
  });
  it('no balance and several balances are INDETERMINATE, never guessed', () => {
    expect(rule(run({ snap: { balances: [] } }), 'CONSTRAINTS', 'T3').reasonCode).toBe('NO_BALANCE');
    const two = [{ id: 'a', warehouseId: 'w1', reorderPoint: '1', reorderQuantity: '1' }, { id: 'b', warehouseId: 'w2', reorderPoint: '1', reorderQuantity: '1' }];
    const out = run({ snap: { balances: two } });
    expect(rule(out, 'EXPECTED_OUTCOME', 'T3').reasonCode).toBe('WAREHOUSE_AMBIGUOUS');
    expect(out.warehouseId).toBeNull();
  });
  it('an unreadable stored baseline is INDETERMINATE', () => {
    expect(rule(run({ snap: { balances: [{ id: 'a', warehouseId: 'w', reorderPoint: 'NaN', reorderQuantity: '1' }] } }), 'CONSTRAINTS', 'T3').reasonCode).toBe('BASELINE_UNREADABLE');
  });
});

describe('B2b evaluator - CONSTRAINTS C1-C6', () => {
  it('C1 inactive item FAILS', () => { expect(rule(run({ snap: { item: { id: '11111111-1111-4111-8111-111111111111', status: 'archived', unitOfMeasure: 'unit' } } }), 'CONSTRAINTS', 'C1').outcome).toBe('FAILED'); });
  it.each([
    ['extra key', { reorderPoint: 1, reorderQuantity: 1, x: 1 }, 'PARAMETERS_MALFORMED'],
    ['missing key', { reorderPoint: 1 }, 'PARAMETERS_MALFORMED'],
    ['string value', { reorderPoint: '1', reorderQuantity: 1 }, 'PARAMETER_NOT_FINITE_NUMBER'],
    ['NaN', { reorderPoint: Number.NaN, reorderQuantity: 1 }, 'PARAMETER_NOT_FINITE_NUMBER'],
    ['Infinity', { reorderPoint: 1, reorderQuantity: Infinity }, 'PARAMETER_NOT_FINITE_NUMBER'],
    ['negative', { reorderPoint: -1, reorderQuantity: 1 }, 'PARAMETER_NEGATIVE'],
  ])('C2 malformed parameters (%s) FAIL', (_n, params, reason) => {
    const out = run({ params });
    expect(rule(out, 'CONSTRAINTS', 'C2')).toMatchObject({ outcome: 'FAILED', reasonCode: reason });
    expect(dim(out, 'EXPECTED_OUTCOME').result).toBe('FAILED');
  });
  it('C3 reorderPoint>0 with reorderQuantity=0 FAILS; both zero passes C3', () => {
    expect(rule(run({ params: { reorderPoint: 5, reorderQuantity: 0 } }), 'CONSTRAINTS', 'C3').outcome).toBe('FAILED');
    expect(rule(run({ params: { reorderPoint: 0, reorderQuantity: 0 } }), 'CONSTRAINTS', 'C3').outcome).toBe('PASSED');
  });
  it('C4 zero baseline is INDETERMINATE under FIRST_CONFIGURATION=NO and under an unset flag', () => {
    const zero = { balances: [{ id: 'a', warehouseId: 'w', reorderPoint: '0', reorderQuantity: '0' }] };
    expect(rule(run({ snap: zero }), 'CONSTRAINTS', 'C4')).toMatchObject({ outcome: 'INDETERMINATE', reasonCode: 'BASELINE_UNSET_OR_ZERO' });
    expect(rule(run({ snap: zero, rs: { firstConfigurationAllowed: undefined } }), 'CONSTRAINTS', 'C4')).toMatchObject({ outcome: 'INDETERMINATE', reasonCode: 'PARAMETER_UNSET' });
    expect(dim(run({ snap: zero }), 'CONSTRAINTS').result).toBe('INDETERMINATE');
  });
  it('C4 zero baseline with FIRST_CONFIGURATION=YES skips the relative bound visibly (INFORMATIONAL)', () => {
    const out = run({ snap: { balances: [{ id: 'a', warehouseId: 'w', reorderPoint: '0', reorderQuantity: '0' }] }, rs: { firstConfigurationAllowed: true } });
    expect(rule(out, 'CONSTRAINTS', 'C5')).toMatchObject({ outcome: 'INFORMATIONAL', reasonCode: 'FIRST_CONFIGURATION_BOUND_SKIPPED' });
  });
  it.each([
    [125, 'PASSED'], [75, 'PASSED'], [125.0001, 'FAILED'], [74.9999, 'FAILED'], [100, 'PASSED'],
  ])('C5 reorderPoint %s vs baseline 100 (limit 25%%) => %s (boundary exact)', (rp, expected) => {
    expect(rule(run({ params: { reorderPoint: rp, reorderQuantity: 200 } }), 'CONSTRAINTS', 'C5').outcome).toBe(expected);
  });
  it.each([[250, 'PASSED'], [150, 'PASSED'], [250.01, 'FAILED'], [149.99, 'FAILED']])('C6 reorderQuantity %s vs baseline 200 => %s', (rq, expected) => {
    expect(rule(run({ params: { reorderPoint: 100, reorderQuantity: rq } }), 'CONSTRAINTS', 'C6').outcome).toBe(expected);
  });
  it('C5/C6 unset limit is INDETERMINATE PARAMETER_UNSET (no default)', () => {
    const out = run({ rs: { maxChangeReorderPointPct: undefined, maxChangeReorderQuantityPct: undefined } });
    expect(rule(out, 'CONSTRAINTS', 'C5')).toMatchObject({ outcome: 'INDETERMINATE', reasonCode: 'PARAMETER_UNSET' });
    expect(rule(out, 'CONSTRAINTS', 'C6')).toMatchObject({ outcome: 'INDETERMINATE', reasonCode: 'PARAMETER_UNSET' });
  });
});

describe('B2b evaluator - RESOURCE_REQUIREMENTS R1 (nominal policy cap, not physical capacity)', () => {
  it.each([[250, 250, 'PASSED'], [250.1, 249.9, 'PASSED'], [250, 250.0001, 'FAILED'], [500, 1, 'FAILED']])('rp %s + rq %s vs cap 500 => %s (exact decimal)', (rp, rq, expected) => {
    const out = run({ params: { reorderPoint: rp, reorderQuantity: rq } });
    expect(rule(out, 'RESOURCE_REQUIREMENTS', 'R1').outcome).toBe(expected);
  });
  it('compares exactly: 0.1 + 0.2 against a cap of 0.3 passes (binary floating point would fail it)', () => {
    expect(rule(run({ params: { reorderPoint: 0.1, reorderQuantity: 0.2 }, rs: { maxImpliedStockUnits: 0.3 } }), 'RESOURCE_REQUIREMENTS', 'R1').outcome).toBe('PASSED');
  });
  it('records the basis POLICY_CAP and the item unit; never reads capacity', () => {
    const f = rule(run(), 'RESOURCE_REQUIREMENTS', 'R1');
    expect(f).toMatchObject({ basis: 'POLICY_CAP', unitOfMeasure: 'unit' });
  });
  it('blank unit_of_measure and unset cap are INDETERMINATE', () => {
    const blank = run({ snap: { item: { id: '11111111-1111-4111-8111-111111111111', status: 'active', unitOfMeasure: ' ' } } });
    expect(rule(blank, 'RESOURCE_REQUIREMENTS', 'R1')).toMatchObject({ outcome: 'INDETERMINATE', reasonCode: 'UNIT_OF_MEASURE_MISSING' });
    expect(dim(blank, 'RESOURCE_REQUIREMENTS').result).toBe('INDETERMINATE');
    const unset = run({ rs: { maxImpliedStockUnits: undefined } });
    expect(rule(unset, 'RESOURCE_REQUIREMENTS', 'R1')).toMatchObject({ outcome: 'INDETERMINATE', reasonCode: 'PARAMETER_UNSET' });
    expect(dim(unset, 'RESOURCE_REQUIREMENTS').result).toBe('INDETERMINATE');
  });
});

describe('B2b evaluator - COST K1-K5', () => {
  const rcpt = (over: Record<string, unknown>) => ({ latestReceipt: { movementId: 'm', occurredAt: '2026-10-01T00:00:00.000Z', unitCost: '10', unitCostCurrency: 'USD', ...over } as never });
  it.each([
    ['no receipt', { latestReceipt: null }, 'NO_RECEIPT'],
    ['null cost', rcpt({ unitCost: null }), 'UNIT_COST_MISSING'],
    ['zero cost', rcpt({ unitCost: '0' }), 'UNIT_COST_INVALID'],
    ['zero (0.0000)', rcpt({ unitCost: '0.0000' }), 'UNIT_COST_INVALID'],
    ['negative cost', rcpt({ unitCost: '-1' }), 'UNIT_COST_INVALID'],
    ['NaN cost', rcpt({ unitCost: 'NaN' }), 'UNIT_COST_INVALID'],
    ['garbage cost', rcpt({ unitCost: 'abc' }), 'UNIT_COST_INVALID'],
    ['sub-minimum cost', rcpt({ unitCost: '0.00001' }), 'UNIT_COST_INVALID'],
  ])('K1 %s is INDETERMINATE (%s), never repaired', (_n, snap, reason) => {
    const out = run({ snap: snap as never });
    expect(rule(out, 'COST', 'K1')).toMatchObject({ outcome: 'INDETERMINATE', reasonCode: reason });
    expect(dim(out, 'COST').result).toBe('INDETERMINATE');
    expect(rule(out, 'COST', 'K3').outcome).toBe('INDETERMINATE');
  });
  it('accepts the smallest storable positive cost', () => { expect(rule(run({ snap: rcpt({ unitCost: '0.0001' }) }), 'COST', 'K1').outcome).toBe('PASSED'); });
  it('K2 undeclared currency, missing cost currency and mismatch are INDETERMINATE (no FX)', () => {
    expect(rule(run({ declared: UNDECLARED }), 'COST', 'K2').reasonCode).toBe('DECLARED_CURRENCY_MISSING');
    expect(rule(run({ snap: rcpt({ unitCostCurrency: null }) }), 'COST', 'K2').reasonCode).toBe('COST_CURRENCY_MISSING');
    const mis = run({ snap: rcpt({ unitCostCurrency: 'EUR' }) });
    expect(rule(mis, 'COST', 'K2')).toMatchObject({ outcome: 'INDETERMINATE', reasonCode: 'COST_CURRENCY_MISMATCH' });
    expect(rule(mis, 'COST', 'K3').outcome).toBe('INDETERMINATE');
  });
  it('K2b a declared currency different from the cap currency is INDETERMINATE (CAP_CURRENCY_MISMATCH)', () => {
    const out = run({ declared: { status: 'DECLARED', currency: 'EUR', version: 1 }, snap: rcpt({ unitCostCurrency: 'EUR' }) });
    expect(rule(out, 'COST', 'K2b').reasonCode).toBe('CAP_CURRENCY_MISMATCH');
    expect(dim(out, 'COST').result).toBe('INDETERMINATE');
  });
  it.each([[500, 'PASSED'], [500.0001, 'FAILED'], [100, 'PASSED']])('K3 reorderQuantity %s x unit cost 10 vs cap 5000 => %s', (rq, expected) => {
    const out = run({ params: { reorderPoint: 120, reorderQuantity: rq } });
    expect(rule(out, 'COST', 'K3').outcome).toBe(rq * 10 <= 5000 ? 'PASSED' : 'FAILED');
    expect(rule(out, 'COST', 'K3').outcome).toBe(expected);
  });
  it('K3 uses exact decimals (cost 0.1 x 3)', () => {
    expect(rule(run({ snap: rcpt({ unitCost: '0.1' }), params: { reorderPoint: 120, reorderQuantity: 3 } }), 'COST', 'K3').observed).toMatchObject({ impliedOrderValue: '0.3' });
  });
  it.each([[325, 'PASSED'], [325.0001, 'FAILED'], [150, 'PASSED']])('K4 increase vs baseline value: rq %s, baseline 200 x 10 => %s (max increase 1250 = 125 units)', (rq, expected) => {
    expect(rule(run({ params: { reorderPoint: 120, reorderQuantity: rq } }), 'COST', 'K4').outcome).toBe(expected);
  });
  it('K4 never goes negative for a decrease; zero baseline quantity is INDETERMINATE', () => {
    expect(rule(run({ params: { reorderPoint: 120, reorderQuantity: 1 } }), 'COST', 'K4')).toMatchObject({ outcome: 'PASSED', observed: { increase: '0' } });
    const out = run({ snap: { balances: [{ id: 'a', warehouseId: 'w', reorderPoint: '5', reorderQuantity: '0' }] }, rs: { firstConfigurationAllowed: true } });
    expect(rule(out, 'COST', 'K4')).toMatchObject({ outcome: 'INDETERMINATE', reasonCode: 'BASELINE_QUANTITY_ZERO' });
  });
  it('unset cap / pct parameters are INDETERMINATE', () => {
    expect(rule(run({ rs: { orderValueCap: undefined } }), 'COST', 'K3').reasonCode).toBe('PARAMETER_UNSET');
    expect(rule(run({ rs: { maxChangeOrderValuePctOfCap: undefined } }), 'COST', 'K4').reasonCode).toBe('PARAMETER_UNSET');
    expect(rule(run({ rs: { orderValueCapCurrency: undefined } }), 'COST', 'K2b').reasonCode).toBe('PARAMETER_UNSET');
  });
  it('K5 supplier cap is informational only and never decides', () => {
    expect(rule(run(), 'COST', 'K5')).toMatchObject({ outcome: 'INFORMATIONAL', reasonCode: 'SUPPLIER_CAP_NOT_RESOLVABLE' });
  });
  it('only the LATEST receipt in the snapshot is used (a historical invalid cost is not consulted)', () => {
    // the repository returns the latest receipt; a good latest receipt passes regardless of older bad history
    expect(rule(run({ snap: rcpt({ unitCost: '12.5' }) }), 'COST', 'K1')).toMatchObject({ outcome: 'PASSED', observed: { unitCost: '12.5' } });
  });
});

describe('B2b evaluator - EXPECTED_OUTCOME E1-E3', () => {
  it('E1 fewer than MIN_DEMAND_OBSERVATIONS is INDETERMINATE for all of E1-E3', () => {
    const out = run({ snap: { demand: { count: 9, sumOfMagnitudes: '900' } } });
    expect(['E1', 'E2', 'E3'].map((r) => rule(out, 'EXPECTED_OUTCOME', r).reasonCode)).toEqual(['INSUFFICIENT_HISTORY', 'INSUFFICIENT_HISTORY', 'INSUFFICIENT_HISTORY']);
    expect(dim(out, 'EXPECTED_OUTCOME').result).toBe('INDETERMINATE');
  });
  it('exactly 10 observations is sufficient (boundary)', () => { expect(rule(run({ snap: { demand: { count: 10, sumOfMagnitudes: '900' } } }), 'EXPECTED_OUTCOME', 'E1').outcome).toBe('PASSED'); });
  it('no history at all is never PASSED and never treated as zero demand', () => {
    const out = run({ snap: { demand: { count: 0, sumOfMagnitudes: '0' } } });
    expect(dim(out, 'EXPECTED_OUTCOME').result).toBe('INDETERMINATE');
  });
  it('history that sums to 0 or is unreadable is INDETERMINATE NO_USABLE_DEMAND', () => {
    for (const sumOfMagnitudes of ['0', 'NaN', '-5']) {
      const out = run({ snap: { demand: { count: 12, sumOfMagnitudes } } });
      expect(rule(out, 'EXPECTED_OUTCOME', 'E2').reasonCode).toBe('NO_USABLE_DEMAND');
      expect(dim(out, 'EXPECTED_OUTCOME').result).toBe('INDETERMINATE');
    }
  });
  it.each([[175, 'PASSED'], [174.9999, 'FAILED'], [400, 'PASSED']])('E2 stock-out guard: reorderPoint %s (needs >= 175) => %s', (rp, expected) => {
    expect(rule(run({ params: { reorderPoint: rp, reorderQuantity: 200 } }), 'EXPECTED_OUTCOME', 'E2').outcome).toBe(expected);
  });
  it.each([[700, 200, 'PASSED'], [700, 200.0001, 'FAILED'], [400, 600, 'FAILED']])('E3 overstock guard: rp %s + rq %s (limit 900) => %s', (rp, rq, expected) => {
    expect(rule(run({ params: { reorderPoint: rp, reorderQuantity: rq } }), 'EXPECTED_OUTCOME', 'E3').outcome).toBe(expected);
  });
  it('unset lead time / safety / cover are INDETERMINATE', () => {
    expect(rule(run({ rs: { leadTimeDays: undefined } }), 'EXPECTED_OUTCOME', 'E2').reasonCode).toBe('PARAMETER_UNSET');
    expect(rule(run({ rs: { safetyFactor: undefined } }), 'EXPECTED_OUTCOME', 'E2').reasonCode).toBe('PARAMETER_UNSET');
    expect(rule(run({ rs: { maxCoverDays: undefined } }), 'EXPECTED_OUTCOME', 'E3').reasonCode).toBe('PARAMETER_UNSET');
  });
  it('the window used is the one in the snapshot and is recorded in E1', () => {
    expect(rule(run(), 'EXPECTED_OUTCOME', 'E1').observed).toMatchObject({ window: { startsExclusive: '2026-07-13T12:00:00.000Z', endsInclusive: '2026-10-11T12:00:00.000Z', days: 90 } });
  });
});
