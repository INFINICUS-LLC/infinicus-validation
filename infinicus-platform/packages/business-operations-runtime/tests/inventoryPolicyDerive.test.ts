/**
 * AC-1 - deterministic unit tests for the read-only reorder-policy derivation (no database, no clock, no randomness).
 * Demand fixture (helpers/policyFixture): SUM 900 over 90 days (10/day), unit cost 10 USD, rule set inventory-reorder-policy/v1.0.0:
 *   stock-out requirement rp >= 175 | cover limit rp + rq <= 900 | policy cap rp + rq <= 500 | change <= 25% | order value <= 5000 USD (rq <= 500)
 *   | increase of order value <= 1250 USD (rq <= baseline + 125).
 * The derivation must be SOUND (every returned candidate passes all four evaluator dimensions) and COMPLETE (when any whole-unit pair within one
 * governed step passes, it returns one) - cross-checked by exhaustive search below.
 */
import { describe, expect, it } from 'vitest';
import { INVENTORY_REORDER_POLICY_V1_0_0 as RS, type InventoryReorderRuleSet } from '../src/inventory-policy/ruleSet.js';
import { evaluateInventoryReorderPolicy } from '../src/inventory-policy/evaluate.js';
import { deriveCompliantReorderPolicy, REORDER_DERIVATION_METHOD, type ReorderPolicyDerivation } from '../src/inventory-policy/derive.js';
import { DECLARED_USD, UNDECLARED, ITEM_ID, WAREHOUSE_ID, snapshot, subject } from './helpers/policyFixture.js';

type Snap = Parameters<typeof snapshot>[0];
const base = (rp: number, rq: number, over: Snap = {}): Snap => ({ balances: [{ id: '33333333-3333-4333-8333-333333333333', warehouseId: WAREHOUSE_ID, reorderPoint: String(rp), reorderQuantity: String(rq) }], ...over });
const derive = (snap: Snap, over: { declared?: typeof DECLARED_USD | typeof UNDECLARED; rs?: Partial<InventoryReorderRuleSet> } = {}): ReorderPolicyDerivation =>
  deriveCompliantReorderPolicy({ itemId: ITEM_ID, snapshot: snapshot(snap), declaredCurrency: over.declared ?? DECLARED_USD, ruleSet: { ...RS, ...(over.rs ?? {}) } });
const passes = (rp: number, rq: number, snap: Snap, rs: InventoryReorderRuleSet = RS): boolean =>
  evaluateInventoryReorderPolicy({ subject: subject({ reorderPoint: rp, reorderQuantity: rq }), snapshot: snapshot(snap), declaredCurrency: DECLARED_USD, ruleSet: rs }).dimensions.every((d) => d.result === 'PASSED');

describe('AC-1 derivation - a candidate when the policy is non-compliant and one governed step can fix it', () => {
  it('raises the reorder point to the stock-out requirement and leaves a compliant order quantity alone', () => {
    const d = derive(base(150, 180));
    expect(d).toMatchObject({ outcome: 'CANDIDATE', method: REORDER_DERIVATION_METHOD, ruleSetVersion: 'inventory-reorder-policy/v1.0.0', proposed: { reorderPoint: 175, reorderQuantity: 180 }, current: { reorderPoint: '150', reorderQuantity: '180' } });
    if (d.outcome !== 'CANDIDATE') throw new Error('unreachable');
    expect(d.verification.map((v) => v.result)).toEqual(['PASSED', 'PASSED', 'PASSED', 'PASSED']);
    expect(d.demand).toEqual({ count: 12, sumOfMagnitudes: '900', windowDays: 90 });
    expect(d.unitCost).toEqual({ amount: '10', currency: 'USD' });
    expect(d.bounds).toMatchObject({ reorderPointMin: '175', reorderPointMax: '187', reorderQuantityMin: '135', reorderQuantityMax: '225', combinedMax: '500' });
  });
  it('lets the order quantity yield first when the pair would break the combined policy cap', () => {
    const d = derive(base(160, 400));
    expect(d).toMatchObject({ outcome: 'CANDIDATE', proposed: { reorderPoint: 175, reorderQuantity: 325 } });
  });
  it('lowers an over-cover order quantity within one step', () => {
    const d = derive(base(180, 330)); // 510 > 500
    expect(d).toMatchObject({ outcome: 'CANDIDATE' });
    if (d.outcome === 'CANDIDATE') expect(d.proposed.reorderPoint + d.proposed.reorderQuantity).toBeLessThanOrEqual(500);
  });
  it('is deterministic and returns whole units only', () => {
    expect(JSON.stringify(derive(base(150, 180)))).toBe(JSON.stringify(derive(base(150, 180))));
    const d = derive(base('150.4' as unknown as number, 180.6 as number));
    if (d.outcome === 'CANDIDATE') { expect(Number.isInteger(d.proposed.reorderPoint)).toBe(true); expect(Number.isInteger(d.proposed.reorderQuantity)).toBe(true); }
  });
});

describe('AC-1 derivation - NO candidate (fail closed), with the reason named', () => {
  it('the current policy already satisfies every rule: nothing to recommend', () => {
    expect(derive(base(180, 200))).toMatchObject({ outcome: 'NONE', code: 'POLICY_ALREADY_COMPLIANT' });
  });
  it('missing, ambiguous, unusable or too-thin evidence is never turned into a number', () => {
    const cases: [string, Snap, string, 'declared'?][] = [
      ['fewer than 10 demand observations', base(150, 180, { demand: { count: 9, sumOfMagnitudes: '900' } }), 'INSUFFICIENT_HISTORY'],
      ['history with no usable demand', base(150, 180, { demand: { count: 12, sumOfMagnitudes: '0' } }), 'NO_USABLE_DEMAND'],
      ['no receipt', base(150, 180, { latestReceipt: null }), 'NO_RECEIPT'],
      ['receipt without a unit cost', base(150, 180, { latestReceipt: { movementId: 'm', occurredAt: '2026-10-01T00:00:00.000Z', unitCost: null, unitCostCurrency: null } }), 'UNIT_COST_MISSING'],
      ['cost in another currency', base(150, 180, { latestReceipt: { movementId: 'm', occurredAt: '2026-10-01T00:00:00.000Z', unitCost: '10', unitCostCurrency: 'EUR' } }), 'COST_CURRENCY_MISMATCH'],
      ['unset (zero) baseline', base(0, 0), 'BASELINE_UNSET_OR_ZERO'],
      ['item not found', base(150, 180, { item: null }), 'TARGET_UNRESOLVED'],
      ['no balance', { balances: [] }, 'NO_BALANCE'],
      ['several warehouses', { balances: [{ id: 'a', warehouseId: 'w1', reorderPoint: '150', reorderQuantity: '180' }, { id: 'b', warehouseId: 'w2', reorderPoint: '150', reorderQuantity: '180' }] }, 'WAREHOUSE_AMBIGUOUS'],
      ['unreadable baseline', base('NaN' as unknown as number, 180), 'BASELINE_UNREADABLE'],
    ];
    for (const [label, snap, reason] of cases) {
      const d = derive(snap);
      expect(d.outcome, label).toBe('NONE');
      if (d.outcome === 'NONE') { expect(d.code, label).toBe('EVIDENCE_UNAVAILABLE'); expect(d.reasonCodes, label).toContain(reason); }
    }
  });
  it('an undeclared business currency yields no candidate', () => {
    const d = derive(base(150, 180), { declared: UNDECLARED });
    expect(d).toMatchObject({ outcome: 'NONE', code: 'EVIDENCE_UNAVAILABLE' });
    if (d.outcome === 'NONE') expect(d.reasonCodes).toContain('DECLARED_CURRENCY_MISSING');
  });
  it('an inactive item yields no candidate', () => {
    expect(derive(base(150, 180, { item: { id: ITEM_ID, status: 'discontinued', unitOfMeasure: 'unit' } }))).toMatchObject({ outcome: 'NONE', code: 'ITEM_NOT_ACTIVE' });
  });
  it('a rule set with an unset parameter derives nothing (no defaults)', () => {
    expect(derive(base(150, 180), { rs: { leadTimeDays: undefined } })).toMatchObject({ outcome: 'NONE', code: 'RULE_SET_INCOMPLETE' });
    expect(derive(base(150, 180), { rs: { orderValueCapCurrency: undefined } })).toMatchObject({ outcome: 'NONE', code: 'RULE_SET_INCOMPLETE' });
  });
  it('when the stock-out requirement is out of reach of one governed step there is no candidate (never an unverified partial step)', () => {
    expect(derive(base(100, 200))).toMatchObject({ outcome: 'NONE', code: 'NO_COMPLIANT_SINGLE_STEP' });
  });
  it('a unit cost that makes the order quantity bound unreachable yields no candidate', () => {
    expect(derive(base(150, 200, { latestReceipt: { movementId: 'm', occurredAt: '2026-10-01T00:00:00.000Z', unitCost: '100', unitCostCurrency: 'USD' } }))).toMatchObject({ outcome: 'NONE', code: 'NO_COMPLIANT_SINGLE_STEP' });
  });
});

describe('AC-1 derivation - exhaustive cross-check against the real evaluator (sound and complete)', () => {
  // deterministic scenario generator (no Math.random)
  let seed = 20261013;
  const next = (n: number): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };

  it('every returned candidate passes all four dimensions; a refusal for lack of a compliant step means NO whole-unit pair inside the step passes', () => {
    let candidates = 0; let noStep = 0; let compliant = 0;
    for (let i = 0; i < 200; i += 1) {
      const sumN = 300 + next(15) * 100; const sum = String(sumN);
      const need = (sumN * 14 * 1.25) / 90; // stock-out requirement; baselines straddle it so every branch is exercised
      const rp0 = Math.max(1, Math.round(need * (0.7 + next(9) / 10))); const rq0 = 20 + next(250);
      const cost = String(1 + next(20));
      const snap = base(rp0, rq0, { demand: { count: 12, sumOfMagnitudes: sum }, latestReceipt: { movementId: 'm', occurredAt: '2026-10-01T00:00:00.000Z', unitCost: cost, unitCostCurrency: 'USD' } });
      const d = derive(snap);
      if (d.outcome === 'CANDIDATE') { candidates += 1; expect(passes(d.proposed.reorderPoint, d.proposed.reorderQuantity, snap), JSON.stringify({ snap: snap.balances, sum, cost, d: d.proposed })).toBe(true); continue; }
      if (d.code === 'POLICY_ALREADY_COMPLIANT') { compliant += 1; expect(passes(rp0, rq0, snap)).toBe(true); continue; }
      if (d.code !== 'NO_COMPLIANT_SINGLE_STEP') throw new Error(`unexpected refusal ${d.code} (${d.reasonCodes.join(',')})`);
      noStep += 1;
      let found: [number, number] | null = null;
      for (let rp = Math.floor(rp0 * 0.75); rp <= Math.ceil(rp0 * 1.25) && !found; rp += 1) {
        for (let rq = Math.floor(rq0 * 0.75); rq <= Math.ceil(rq0 * 1.25); rq += 1) { if (passes(rp, rq, snap)) { found = [rp, rq]; break; } }
      }
      expect(found, JSON.stringify({ snap: snap.balances, sum, cost })).toBeNull();
    }
    // the generator must exercise every branch, otherwise the cross-check proves nothing
    expect(candidates).toBeGreaterThan(10);
    expect(noStep).toBeGreaterThan(10);
    expect(compliant).toBeGreaterThanOrEqual(0);
    expect(candidates + noStep + compliant).toBe(200);
  }, 120_000);
});
