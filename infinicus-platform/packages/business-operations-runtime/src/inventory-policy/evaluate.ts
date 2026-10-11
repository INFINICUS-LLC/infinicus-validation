/**
 * Pure evaluation of `inventory_reorder_policy_update@1` against the approved rule set (Block B2b).
 *
 * Input: the exact subject (action type, target, FINAL parameters), a consistent snapshot of Business Operations facts, the governed
 * declared currency of the business, and an approved rule set. Output: one result per dimension (CONSTRAINTS, RESOURCE_REQUIREMENTS, COST,
 * EXPECTED_OUTCOME) with one finding per rule. No I/O, no clock, no database, no randomness: the same inputs always give the same output.
 *
 * Result derivation (rule set v1.0.0 section 3): any FAILED => FAILED; else any INDETERMINATE => INDETERMINATE; else PASSED. INFORMATIONAL
 * findings never change a result. A missing, ambiguous, unusable or unit-incompatible fact is INDETERMINATE - never PASSED. An unset rule-set
 * parameter is INDETERMINATE (`PARAMETER_UNSET`). There are no defaults and no invented thresholds. All arithmetic is exact decimal.
 *
 * Expected-outcome formulas (section 6.5; d = average daily demand = SUM / WINDOW_DAYS, so each comparison is multiplied through by WINDOW_DAYS):
 *   stock-out guard  E2:  reorderPoint >= d x LEAD_TIME_DAYS x SAFETY_FACTOR      <=>  reorderPoint x WINDOW >= SUM x LEAD x SAFETY
 *   overstock guard  E3:  reorderPoint + reorderQuantity <= d x MAX_COVER_DAYS     <=>  (rp + rq) x WINDOW <= SUM x MAX_COVER
 * where SUM is the sum of the magnitudes of the qualifying (`issue`) movements in the window (now - WINDOW_DAYS, now], now = database clock.
 */
import type { EvaluationJson, InventoryPolicyFactsSnapshot } from '@infinicus/database';
import { Decimal } from './decimal.js';
import type { InventoryReorderRuleSet } from './ruleSet.js';
import { UNIT_COST_MINIMUM_STORABLE } from '../unitCost.js';

export const SUPPORTED_ACTION = Object.freeze({ code: 'inventory_reorder_policy_update', schemaVersion: '1' });
export const SUPPORTED_TARGET_KIND = 'inventory_item';
export const EVALUATED_DIMENSIONS = ['CONSTRAINTS', 'RESOURCE_REQUIREMENTS', 'COST', 'EXPECTED_OUTCOME'] as const;
export type EvaluatedDimension = (typeof EVALUATED_DIMENSIONS)[number];
export type EvaluationResult = 'PASSED' | 'FAILED' | 'INDETERMINATE';
export type RuleOutcome = EvaluationResult | 'INFORMATIONAL';

export interface Finding {
  rule: string;
  outcome: RuleOutcome;
  reasonCode: string;
  observed: EvaluationJson;
  limit: EvaluationJson;
  [key: string]: EvaluationJson | undefined;
}

export type DeclaredCurrencyFact = { status: 'UNDECLARED' } | { status: 'DECLARED'; currency: string; version: number };

export interface EvaluationSubject {
  actionType: { code: string; schemaVersion: string };
  target: { kind: string; id: string };
  finalParameters: { [key: string]: EvaluationJson };
}

export interface DimensionEvaluation { dimension: EvaluatedDimension; result: EvaluationResult; findings: Finding[] }

export interface PolicyEvaluationOutput {
  /** The balance's warehouse when exactly one balance exists, otherwise null (the evaluation is about the item). */
  warehouseId: string | null;
  dimensions: DimensionEvaluation[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ZERO = Decimal.of(0);
const HUNDRED = Decimal.of(100);
const MIN_COST = Decimal.fromNumber(UNIT_COST_MINIMUM_STORABLE) as Decimal;

const f = (rule: string, outcome: RuleOutcome, reasonCode: string, observed: EvaluationJson = null, limit: EvaluationJson = null): Finding =>
  ({ rule, outcome, reasonCode, observed, limit });

export function deriveResult(findings: readonly Finding[]): EvaluationResult {
  if (findings.some((x) => x.outcome === 'FAILED')) return 'FAILED';
  if (findings.some((x) => x.outcome === 'INDETERMINATE')) return 'INDETERMINATE';
  return 'PASSED';
}

/** Rule-set parameter as an exact decimal, or null when unset (or not a finite number). */
const param = (v: number | undefined): Decimal | null => (v === undefined ? null : Decimal.fromNumber(v));

interface ParsedParameters { reorderPoint: Decimal; reorderQuantity: Decimal }
type ParameterCheck = { ok: true; value: ParsedParameters } | { ok: false; reasonCode: string; observed: EvaluationJson };

/** `finalParameters` must hold exactly `reorderPoint` and `reorderQuantity`, both finite numbers >= 0. */
export function parseFinalParameters(p: { [key: string]: EvaluationJson }): ParameterCheck {
  const keys = Object.keys(p).sort();
  if (keys.length !== 2 || keys[0] !== 'reorderPoint' || keys[1] !== 'reorderQuantity') return { ok: false, reasonCode: 'PARAMETERS_MALFORMED', observed: keys };
  const rp = Decimal.fromNumber(p.reorderPoint); const rq = Decimal.fromNumber(p.reorderQuantity);
  if (rp === null || rq === null) return { ok: false, reasonCode: 'PARAMETER_NOT_FINITE_NUMBER', observed: keys };
  if (rp.isNegative() || rq.isNegative()) return { ok: false, reasonCode: 'PARAMETER_NEGATIVE', observed: { reorderPoint: rp.toString(), reorderQuantity: rq.toString() } };
  return { ok: true, value: { reorderPoint: rp, reorderQuantity: rq } };
}

interface Resolved {
  /** Findings of the target-resolution preconditions T1-T3 (they apply to every dimension). */
  preconditions: Finding[];
  blocked: boolean;
  balance: { reorderPoint: Decimal; reorderQuantity: Decimal; warehouseId: string; id: string } | null;
}

function resolveTarget(subject: EvaluationSubject, snapshot: InventoryPolicyFactsSnapshot): Resolved {
  const out: Finding[] = [];
  let blocked = false;
  if (subject.target.kind !== SUPPORTED_TARGET_KIND) { out.push(f('T1', 'FAILED', 'TARGET_KIND_INVALID', subject.target.kind, SUPPORTED_TARGET_KIND)); blocked = true; }
  else out.push(f('T1', 'PASSED', 'TARGET_KIND_OK', subject.target.kind, SUPPORTED_TARGET_KIND));
  if (!UUID.test(subject.target.id)) { out.push(f('T2', 'FAILED', 'TARGET_ID_NOT_UUID', subject.target.id, 'lowercase uuid')); blocked = true; }
  else if (snapshot.item === null || snapshot.item.id !== subject.target.id) { out.push(f('T2', 'INDETERMINATE', 'TARGET_UNRESOLVED', subject.target.id, null)); blocked = true; }
  else out.push(f('T2', 'PASSED', 'TARGET_RESOLVED', subject.target.id, null));
  let balance: Resolved['balance'] = null;
  if (!blocked) {
    if (snapshot.balances.length === 0) { out.push(f('T3', 'INDETERMINATE', 'NO_BALANCE', 0, 1)); blocked = true; }
    else if (snapshot.balances.length > 1) { out.push(f('T3', 'INDETERMINATE', 'WAREHOUSE_AMBIGUOUS', snapshot.balances.length, 1)); blocked = true; }
    else {
      const b = snapshot.balances[0];
      const rp = Decimal.parse(b.reorderPoint); const rq = Decimal.parse(b.reorderQuantity);
      if (rp === null || rq === null) { out.push(f('T3', 'INDETERMINATE', 'BASELINE_UNREADABLE', [b.reorderPoint, b.reorderQuantity], null)); blocked = true; }
      else { balance = { reorderPoint: rp, reorderQuantity: rq, warehouseId: b.warehouseId, id: b.id }; out.push(f('T3', 'PASSED', 'SINGLE_BALANCE', 1, 1)); }
    }
  }
  return { preconditions: out, blocked, balance };
}

/** Relative change |final - base| / base, in percent, compared with a limit, exactly: |final - base| x 100 <= limit x base. */
function changeRule(rule: string, label: string, final: Decimal, base: Decimal, limitPct: number | undefined): Finding {
  const limit = param(limitPct);
  if (limit === null) return f(rule, 'INDETERMINATE', 'PARAMETER_UNSET', { [label]: final.toString(), baseline: base.toString() }, null);
  const diff = final.sub(base).abs();
  const within = diff.mul(HUNDRED).lte(limit.mul(base));
  const observedPct = diff.mul(HUNDRED).toString();
  return f(rule, within ? 'PASSED' : 'FAILED', within ? 'CHANGE_WITHIN_LIMIT' : 'CHANGE_EXCEEDS_LIMIT',
    { [label]: final.toString(), baseline: base.toString(), absoluteChange: diff.toString(), absoluteChangeTimes100: observedPct }, { maxChangePct: limit.toString(), baseline: base.toString() });
}

function evaluateConstraints(subject: EvaluationSubject, snapshot: InventoryPolicyFactsSnapshot, rs: InventoryReorderRuleSet, r: Resolved, params: ParameterCheck): Finding[] {
  const findings = [...r.preconditions];
  if (r.blocked) return findings;
  const item = snapshot.item as NonNullable<InventoryPolicyFactsSnapshot['item']>;
  findings.push(item.status === 'active' ? f('C1', 'PASSED', 'ITEM_ACTIVE', item.status, 'active') : f('C1', 'FAILED', 'ITEM_NOT_ACTIVE', item.status, 'active'));
  if (!params.ok) { findings.push(f('C2', 'FAILED', params.reasonCode, params.observed, ['reorderPoint', 'reorderQuantity'])); return findings; }
  const { reorderPoint: rp, reorderQuantity: rq } = params.value;
  findings.push(f('C2', 'PASSED', 'PARAMETERS_WELL_FORMED', { reorderPoint: rp.toString(), reorderQuantity: rq.toString() }, null));
  findings.push(rp.gt(ZERO) && rq.isZero() ? f('C3', 'FAILED', 'REORDER_POINT_WITHOUT_QUANTITY', { reorderPoint: rp.toString(), reorderQuantity: '0' }, 'reorderQuantity > 0 when reorderPoint > 0')
    : f('C3', 'PASSED', 'REORDER_QUANTITY_CONSISTENT', { reorderPoint: rp.toString(), reorderQuantity: rq.toString() }, null));
  const base = r.balance as NonNullable<Resolved['balance']>;
  const baselineZero = base.reorderPoint.isZero() || base.reorderQuantity.isZero();
  if (baselineZero && rs.firstConfigurationAllowed !== true) {
    // Q-F1 = no (or unset): an unset (zero) baseline cannot be changed through a governed modification.
    findings.push(f('C4', 'INDETERMINATE', rs.firstConfigurationAllowed === undefined ? 'PARAMETER_UNSET' : 'BASELINE_UNSET_OR_ZERO',
      { reorderPoint: base.reorderPoint.toString(), reorderQuantity: base.reorderQuantity.toString() }, { firstConfigurationAllowed: rs.firstConfigurationAllowed ?? null }));
    return findings;
  }
  findings.push(f('C4', 'PASSED', 'BASELINE_SET', { reorderPoint: base.reorderPoint.toString(), reorderQuantity: base.reorderQuantity.toString() }, null));
  // Q-F1 = yes: a zero baseline has no relative change to bound; the bound is skipped (recorded, never silently).
  findings.push(base.reorderPoint.isZero() ? f('C5', 'INFORMATIONAL', 'FIRST_CONFIGURATION_BOUND_SKIPPED', { reorderPoint: rp.toString(), baseline: '0' }, null)
    : changeRule('C5', 'reorderPoint', rp, base.reorderPoint, rs.maxChangeReorderPointPct));
  findings.push(base.reorderQuantity.isZero() ? f('C6', 'INFORMATIONAL', 'FIRST_CONFIGURATION_BOUND_SKIPPED', { reorderQuantity: rq.toString(), baseline: '0' }, null)
    : changeRule('C6', 'reorderQuantity', rq, base.reorderQuantity, rs.maxChangeReorderQuantityPct));
  void subject;
  return findings;
}

function evaluateResources(snapshot: InventoryPolicyFactsSnapshot, rs: InventoryReorderRuleSet, r: Resolved, params: ParameterCheck): Finding[] {
  const findings = [...r.preconditions];
  if (r.blocked) return findings;
  const item = snapshot.item as NonNullable<InventoryPolicyFactsSnapshot['item']>;
  if (!params.ok) { findings.push(f('R1', 'FAILED', params.reasonCode, params.observed, ['reorderPoint', 'reorderQuantity'])); return findings; }
  if (item.unitOfMeasure.trim().length === 0) { findings.push(f('R1', 'INDETERMINATE', 'UNIT_OF_MEASURE_MISSING', '', null)); return findings; }
  const cap = param(rs.maxImpliedStockUnits);
  if (cap === null) { findings.push(f('R1', 'INDETERMINATE', 'PARAMETER_UNSET', null, null)); return findings; }
  const total = params.value.reorderPoint.add(params.value.reorderQuantity);
  const ok = total.lte(cap);
  // A nominal POLICY CAP in the item's own unit_of_measure. capacity_units is never read and no unit conversion exists.
  findings.push({ ...f('R1', ok ? 'PASSED' : 'FAILED', ok ? 'WITHIN_POLICY_CAP' : 'EXCEEDS_POLICY_CAP', total.toString(), cap.toString()), basis: 'POLICY_CAP', unitOfMeasure: item.unitOfMeasure });
  return findings;
}

type CostBasis = { ok: true; cost: Decimal; currency: string; declared: string } | { ok: false; reasonCode: string };

function costFindings(snapshot: InventoryPolicyFactsSnapshot, declared: DeclaredCurrencyFact, rs: InventoryReorderRuleSet): { findings: Finding[]; basis: CostBasis } {
  const out: Finding[] = [];
  const rc = snapshot.latestReceipt;
  let cost: Decimal | null = null;
  let costReason: string | null = null;
  if (rc === null) { costReason = 'NO_RECEIPT'; out.push(f('K1', 'INDETERMINATE', 'NO_RECEIPT', null, null)); }
  else if (rc.unitCost === null) { costReason = 'UNIT_COST_MISSING'; out.push(f('K1', 'INDETERMINATE', 'UNIT_COST_MISSING', { movementId: rc.movementId }, null)); }
  else {
    const parsed = Decimal.parse(rc.unitCost); // 'NaN' and anything non-decimal parse to null
    // MIN_COST (0.0001) is the smallest storable positive amount, so this one comparison also rejects zero and negative costs.
    if (parsed === null || parsed.cmp(MIN_COST) < 0) {
      costReason = 'UNIT_COST_INVALID'; out.push(f('K1', 'INDETERMINATE', 'UNIT_COST_INVALID', { movementId: rc.movementId, unitCost: rc.unitCost }, { minimum: MIN_COST.toString() }));
    } else { cost = parsed; out.push(f('K1', 'PASSED', 'UNIT_COST_USABLE', { movementId: rc.movementId, unitCost: parsed.toString() }, { minimum: MIN_COST.toString() })); }
  }
  let currencyReason: string | null = null;
  if (declared.status !== 'DECLARED') { currencyReason = 'DECLARED_CURRENCY_MISSING'; out.push(f('K2', 'INDETERMINATE', 'DECLARED_CURRENCY_MISSING', null, null)); }
  else if (cost === null) { out.push(f('K2', 'INDETERMINATE', costReason ?? 'UNIT_COST_INVALID', { declaredCurrency: declared.currency }, null)); currencyReason = costReason; }
  else if (rc === null || rc.unitCostCurrency === null) { currencyReason = 'COST_CURRENCY_MISSING'; out.push(f('K2', 'INDETERMINATE', 'COST_CURRENCY_MISSING', { declaredCurrency: declared.currency }, null)); }
  else if (rc.unitCostCurrency !== declared.currency) { currencyReason = 'COST_CURRENCY_MISMATCH'; out.push(f('K2', 'INDETERMINATE', 'COST_CURRENCY_MISMATCH', { costCurrency: rc.unitCostCurrency }, { declaredCurrency: declared.currency })); }
  else out.push(f('K2', 'PASSED', 'COST_CURRENCY_MATCHES_DECLARED', { costCurrency: rc.unitCostCurrency }, { declaredCurrency: declared.currency }));
  // The v1 order-value cap is denominated in one currency only; no conversion exists.
  let capReason: string | null = null;
  if (declared.status !== 'DECLARED') { capReason = 'DECLARED_CURRENCY_MISSING'; out.push(f('K2b', 'INDETERMINATE', 'DECLARED_CURRENCY_MISSING', null, rs.orderValueCapCurrency ?? null)); }
  else if (rs.orderValueCapCurrency === undefined) { capReason = 'PARAMETER_UNSET'; out.push(f('K2b', 'INDETERMINATE', 'PARAMETER_UNSET', declared.currency, null)); }
  else if (declared.currency !== rs.orderValueCapCurrency) { capReason = 'CAP_CURRENCY_MISMATCH'; out.push(f('K2b', 'INDETERMINATE', 'CAP_CURRENCY_MISMATCH', declared.currency, rs.orderValueCapCurrency)); }
  else out.push(f('K2b', 'PASSED', 'DECLARED_CURRENCY_IS_CAP_CURRENCY', declared.currency, rs.orderValueCapCurrency));
  const blocking = costReason ?? currencyReason ?? capReason;
  const basis: CostBasis = blocking !== null || cost === null || declared.status !== 'DECLARED'
    ? { ok: false, reasonCode: blocking ?? 'COST_UNAVAILABLE' }
    : { ok: true, cost, currency: declared.currency, declared: declared.currency };
  return { findings: out, basis };
}

function evaluateCost(snapshot: InventoryPolicyFactsSnapshot, declared: DeclaredCurrencyFact, rs: InventoryReorderRuleSet, r: Resolved, params: ParameterCheck): Finding[] {
  const findings = [...r.preconditions];
  if (r.blocked) return findings;
  if (!params.ok) { findings.push(f('K0', 'FAILED', params.reasonCode, params.observed, ['reorderPoint', 'reorderQuantity'])); return findings; }
  const { findings: cf, basis } = costFindings(snapshot, declared, rs);
  findings.push(...cf);
  const base = r.balance as NonNullable<Resolved['balance']>;
  const cap = param(rs.orderValueCap);
  // K3: implied order value <= ORDER_VALUE_CAP (USD).
  if (!basis.ok) findings.push(f('K3', 'INDETERMINATE', basis.reasonCode, null, cap === null ? null : cap.toString()));
  else if (cap === null) findings.push(f('K3', 'INDETERMINATE', 'PARAMETER_UNSET', null, null));
  else {
    const implied = params.value.reorderQuantity.mul(basis.cost);
    const ok = implied.lte(cap);
    findings.push(f('K3', ok ? 'PASSED' : 'FAILED', ok ? 'ORDER_VALUE_WITHIN_CAP' : 'ORDER_VALUE_EXCEEDS_CAP', { impliedOrderValue: implied.toString(), currency: basis.currency }, { orderValueCap: cap.toString(), currency: rs.orderValueCapCurrency ?? null }));
  }
  // K4: the increase over the baseline order value <= MAX_CHANGE_ORDER_VALUE % of ORDER_VALUE_CAP.
  const pct = param(rs.maxChangeOrderValuePctOfCap);
  if (!basis.ok) findings.push(f('K4', 'INDETERMINATE', basis.reasonCode, null, null));
  else if (cap === null || pct === null) findings.push(f('K4', 'INDETERMINATE', 'PARAMETER_UNSET', null, null));
  else if (base.reorderQuantity.isZero()) findings.push(f('K4', 'INDETERMINATE', 'BASELINE_QUANTITY_ZERO', { baselineReorderQuantity: '0' }, null));
  else {
    const implied = params.value.reorderQuantity.mul(basis.cost);
    const baseline = base.reorderQuantity.mul(basis.cost);
    const increase = implied.sub(baseline).gt(ZERO) ? implied.sub(baseline) : ZERO;
    const ok = increase.mul(HUNDRED).lte(cap.mul(pct)); // increase <= cap x pct / 100
    findings.push(f('K4', ok ? 'PASSED' : 'FAILED', ok ? 'ORDER_VALUE_INCREASE_WITHIN_LIMIT' : 'ORDER_VALUE_INCREASE_EXCEEDS_LIMIT',
      { impliedOrderValue: implied.toString(), baselineOrderValue: baseline.toString(), increase: increase.toString(), currency: basis.currency },
      { maxIncrease: cap.mul(pct).mul(Decimal.parse('0.01') as Decimal).toString(), maxChangeOrderValuePctOfCap: pct.toString() }));
  }
  // No item-to-supplier link exists, so no supplier cap is applied and none is invented.
  findings.push(f('K5', 'INFORMATIONAL', 'SUPPLIER_CAP_NOT_RESOLVABLE', null, null));
  return findings;
}

function evaluateExpectedOutcome(snapshot: InventoryPolicyFactsSnapshot, rs: InventoryReorderRuleSet, r: Resolved, params: ParameterCheck): Finding[] {
  const findings = [...r.preconditions];
  if (r.blocked) return findings;
  if (!params.ok) { findings.push(f('E0', 'FAILED', params.reasonCode, params.observed, ['reorderPoint', 'reorderQuantity'])); return findings; }
  const { reorderPoint: rp, reorderQuantity: rq } = params.value;
  const count = snapshot.demand.count;
  const sum = Decimal.parse(snapshot.demand.sumOfMagnitudes);
  const window = { startsExclusive: snapshot.windowStartsAt, endsInclusive: snapshot.capturedAt, days: snapshot.windowDays };
  if (count < rs.minDemandObservations) {
    findings.push(f('E1', 'INDETERMINATE', 'INSUFFICIENT_HISTORY', { observations: count, window }, { minDemandObservations: rs.minDemandObservations }));
    findings.push(f('E2', 'INDETERMINATE', 'INSUFFICIENT_HISTORY', null, null));
    findings.push(f('E3', 'INDETERMINATE', 'INSUFFICIENT_HISTORY', null, null));
    return findings;
  }
  findings.push(f('E1', 'PASSED', 'SUFFICIENT_HISTORY', { observations: count, window }, { minDemandObservations: rs.minDemandObservations }));
  if (sum === null || sum.cmp(ZERO) <= 0) {
    // History exists but yields no usable demand figure: never treated as zero demand and never passed.
    findings.push(f('E2', 'INDETERMINATE', 'NO_USABLE_DEMAND', snapshot.demand.sumOfMagnitudes, null));
    findings.push(f('E3', 'INDETERMINATE', 'NO_USABLE_DEMAND', snapshot.demand.sumOfMagnitudes, null));
    return findings;
  }
  const windowDays = Decimal.of(snapshot.windowDays);
  const lead = param(rs.leadTimeDays); const safety = param(rs.safetyFactor); const cover = param(rs.maxCoverDays);
  if (lead === null || safety === null) findings.push(f('E2', 'INDETERMINATE', 'PARAMETER_UNSET', null, null));
  else {
    const required = sum.mul(lead).mul(safety); // compared with reorderPoint x WINDOW
    const ok = rp.mul(windowDays).gte(required);
    findings.push(f('E2', ok ? 'PASSED' : 'FAILED', ok ? 'REORDER_POINT_COVERS_LEAD_TIME_DEMAND' : 'REORDER_POINT_BELOW_STOCKOUT_REQUIREMENT',
      { reorderPointTimesWindow: rp.mul(windowDays).toString(), demandSum: sum.toString() },
      { requiredTimesWindow: required.toString(), leadTimeDays: lead.toString(), safetyFactor: safety.toString() }));
  }
  if (cover === null) findings.push(f('E3', 'INDETERMINATE', 'PARAMETER_UNSET', null, null));
  else {
    const total = rp.add(rq).mul(windowDays);
    const limit = sum.mul(cover);
    const ok = total.lte(limit);
    findings.push(f('E3', ok ? 'PASSED' : 'FAILED', ok ? 'STOCK_POLICY_WITHIN_COVER_LIMIT' : 'STOCK_POLICY_EXCEEDS_COVER_LIMIT',
      { stockPolicyTimesWindow: total.toString(), demandSum: sum.toString() }, { limitTimesWindow: limit.toString(), maxCoverDays: cover.toString() }));
  }
  return findings;
}

/** Evaluates all four authorized dimensions. Pure and deterministic. */
export function evaluateInventoryReorderPolicy(input: {
  subject: EvaluationSubject;
  snapshot: InventoryPolicyFactsSnapshot;
  declaredCurrency: DeclaredCurrencyFact;
  ruleSet: InventoryReorderRuleSet;
}): PolicyEvaluationOutput {
  const { subject, snapshot, declaredCurrency, ruleSet } = input;
  const resolved = resolveTarget(subject, snapshot);
  const params = parseFinalParameters(subject.finalParameters);
  const per: Record<EvaluatedDimension, Finding[]> = {
    CONSTRAINTS: evaluateConstraints(subject, snapshot, ruleSet, resolved, params),
    RESOURCE_REQUIREMENTS: evaluateResources(snapshot, ruleSet, resolved, params),
    COST: evaluateCost(snapshot, declaredCurrency, ruleSet, resolved, params),
    EXPECTED_OUTCOME: evaluateExpectedOutcome(snapshot, ruleSet, resolved, params),
  };
  return {
    warehouseId: resolved.balance === null ? null : resolved.balance.warehouseId,
    dimensions: EVALUATED_DIMENSIONS.map((dimension) => ({ dimension, result: deriveResult(per[dimension]), findings: per[dimension] })),
  };
}
