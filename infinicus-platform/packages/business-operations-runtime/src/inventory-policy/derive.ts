/**
 * Read-only derivation of a rule-compliant `inventory_reorder_policy_update@1` candidate (AC-1).
 *
 * Purpose: give the ADI recommendation producer a deterministic, owner-governed way to turn authoritative Business Operations facts into a
 * proposed (reorderPoint, reorderQuantity) WITHOUT inventing a business fact or a threshold. Every number used is either a BO fact in the snapshot
 * or a value of the owner-approved rule set `inventory-reorder-policy/v1.0.0`. This module decides nothing for the business: it only says which
 * single-step change, if any, would satisfy the approved rule set. ABA still has to approve it and BO re-checks everything at execution.
 *
 * Method (deterministic; same inputs, same output; no clock, no I/O, no randomness):
 *   1. Evaluate the CURRENT policy (the baseline) with the real evaluator. Missing, ambiguous, stale or inconsistent evidence (any INDETERMINATE
 *      finding) -> NO candidate (`EVIDENCE_UNAVAILABLE`). Inactive item -> NO candidate. Baseline already PASSED on all four dimensions -> NO
 *      candidate (`POLICY_ALREADY_COMPLIANT`): nothing to recommend.
 *   2. Otherwise the policy is non-compliant (a FAILED finding). Derive the smallest whole-unit change that satisfies every rule at once:
 *        E2  reorderPoint >= ceil(D x LEAD x SAFETY / WINDOW)                       (stock-out guard)
 *        E3  reorderPoint + reorderQuantity <= floor(D x COVER / WINDOW)             (overstock guard)
 *        R1  reorderPoint + reorderQuantity <= MAX_IMPLIED_STOCK_UNITS
 *        C5/C6  each value within +/- MAX_CHANGE_% of its baseline                  (one governed step)
 *        K3  reorderQuantity x unitCost <= ORDER_VALUE_CAP
 *        K4  increase of reorderQuantity x unitCost over baseline <= MAX_CHANGE_ORDER_VALUE % of ORDER_VALUE_CAP
 *      Each value is the whole-unit number closest to its baseline inside its feasible interval; when the pair would break the combined cap the
 *      order quantity yields first (down to its lower bound), then the reorder point (down to the stock-out requirement).
 *   3. VERIFY: the candidate is evaluated with the same real evaluator; only a candidate whose four dimensions are all PASSED is returned. If no
 *      single step can satisfy the rules, or the verification fails, the result is NO candidate (`NO_COMPLIANT_SINGLE_STEP` /
 *      `DERIVATION_UNVERIFIED`). Nothing is rounded into compliance without being verified.
 */
import type { InventoryPolicyFactsSnapshot } from '@infinicus/database';
import { Decimal } from './decimal.js';
import {
  SUPPORTED_ACTION, SUPPORTED_TARGET_KIND, evaluateInventoryReorderPolicy, type DeclaredCurrencyFact, type EvaluationResult, type EvaluationSubject, type Finding,
} from './evaluate.js';
import type { InventoryReorderRuleSet } from './ruleSet.js';

export const REORDER_DERIVATION_METHOD = 'inventory-reorder-policy-minimal-compliant-step/1' as const;

export type DerivationRefusalCode =
  | 'EVIDENCE_UNAVAILABLE'
  | 'ITEM_NOT_ACTIVE'
  | 'POLICY_ALREADY_COMPLIANT'
  | 'NO_COMPLIANT_SINGLE_STEP'
  | 'DERIVATION_UNVERIFIED'
  | 'RULE_SET_INCOMPLETE';

export interface DerivationCandidate {
  outcome: 'CANDIDATE';
  ruleSetVersion: string;
  itemId: string;
  balanceId: string;
  warehouseId: string;
  current: { reorderPoint: string; reorderQuantity: string };
  proposed: { reorderPoint: number; reorderQuantity: number };
  /** The exact interval bounds the proposal was chosen within (whole units, as decimal text). */
  bounds: { reorderPointMin: string; reorderPointMax: string; reorderQuantityMin: string; reorderQuantityMax: string; combinedMax: string };
  /** Verification by the real evaluator: always four PASSED dimensions on a returned candidate. */
  verification: { dimension: string; result: EvaluationResult }[];
  demand: { count: number; sumOfMagnitudes: string; windowDays: number };
  unitCost: { amount: string; currency: string } ;
  method: typeof REORDER_DERIVATION_METHOD;
}

export interface DerivationRefusal {
  outcome: 'NONE';
  code: DerivationRefusalCode;
  detail: string;
  /** Reason codes of the findings that blocked the derivation (e.g. INSUFFICIENT_HISTORY), when evidence was the cause. */
  reasonCodes: string[];
}

export type ReorderPolicyDerivation = DerivationCandidate | DerivationRefusal;

const refuse = (code: DerivationRefusalCode, detail: string, reasonCodes: string[] = []): DerivationRefusal => ({ outcome: 'NONE', code, detail, reasonCodes });
const D = (v: string | number): Decimal => Decimal.parse(String(v)) as Decimal;
const HUNDRED = Decimal.of(100);

// ── exact integer rounding over the Decimal representation ─────────────────────────────────────────────────────────────────────────────────────
const pow10 = (n: number): bigint => 10n ** BigInt(n);
function floorDiv(a: bigint, b: bigint): bigint { const q = a / b; return (a % b !== 0n && (a < 0n) !== (b < 0n)) ? q - 1n : q; }
function ceilDiv(a: bigint, b: bigint): bigint { return -floorDiv(-a, b); }
/** floor(a / b) for decimals, b > 0. */
function floorOf(a: Decimal, b: Decimal): bigint { return floorDiv(a.units * pow10(b.scale), b.units * pow10(a.scale)); }
function ceilOf(a: Decimal, b: Decimal): bigint { return ceilDiv(a.units * pow10(b.scale), b.units * pow10(a.scale)); }
const ONE = Decimal.of(1);
const clamp = (x: bigint, lo: bigint, hi: bigint): bigint => (x < lo ? lo : x > hi ? hi : x);
const minOf = (...xs: bigint[]): bigint => xs.reduce((m, x) => (x < m ? x : m));

function blockingReasonCodes(dims: readonly { findings: Finding[] }[]): string[] {
  const out: string[] = [];
  for (const d of dims) for (const f of d.findings) if (f.outcome === 'INDETERMINATE' && !out.includes(f.reasonCode)) out.push(f.reasonCode);
  return out;
}

export function deriveCompliantReorderPolicy(input: {
  itemId: string;
  snapshot: InventoryPolicyFactsSnapshot;
  declaredCurrency: DeclaredCurrencyFact;
  ruleSet: InventoryReorderRuleSet;
}): ReorderPolicyDerivation {
  const { itemId, snapshot, declaredCurrency, ruleSet: rs } = input;
  const required = [rs.maxChangeReorderPointPct, rs.maxChangeReorderQuantityPct, rs.orderValueCap, rs.maxChangeOrderValuePctOfCap, rs.maxImpliedStockUnits, rs.leadTimeDays, rs.safetyFactor, rs.maxCoverDays];
  if (required.some((v) => v === undefined) || rs.orderValueCapCurrency === undefined) return refuse('RULE_SET_INCOMPLETE', 'the approved rule set leaves a parameter unset; nothing is derived from an unset value');

  const target = { kind: SUPPORTED_TARGET_KIND, id: itemId };
  const action = { code: SUPPORTED_ACTION.code, schemaVersion: SUPPORTED_ACTION.schemaVersion };
  const evaluate = (finalParameters: { reorderPoint: number | string; reorderQuantity: number | string }) =>
    evaluateInventoryReorderPolicy({ subject: { actionType: action, target, finalParameters } as EvaluationSubject, snapshot, declaredCurrency, ruleSet: rs });

  // 1. The baseline, through the real evaluator. Its facts are the evidence; INDETERMINATE means the evidence is missing/ambiguous/unusable.
  if (snapshot.item === null || snapshot.balances.length !== 1) {
    // let the evaluator name the precise reason (TARGET_UNRESOLVED / NO_BALANCE / WAREHOUSE_AMBIGUOUS) with a harmless probe subject
    const probe = evaluate({ reorderPoint: 0, reorderQuantity: 0 });
    return refuse('EVIDENCE_UNAVAILABLE', 'the target or its single inventory balance could not be established', blockingReasonCodes(probe.dimensions));
  }
  const balance = snapshot.balances[0];
  const rp0 = Decimal.parse(balance.reorderPoint); const rq0 = Decimal.parse(balance.reorderQuantity);
  if (rp0 === null || rq0 === null) return refuse('EVIDENCE_UNAVAILABLE', 'the current reorder values are unreadable', ['BASELINE_UNREADABLE']);
  const baselineEval = evaluate({ reorderPoint: Number(balance.reorderPoint), reorderQuantity: Number(balance.reorderQuantity) });
  const blocking = blockingReasonCodes(baselineEval.dimensions);
  if (blocking.length > 0) return refuse('EVIDENCE_UNAVAILABLE', 'required evidence is missing, ambiguous or unusable under the approved rule set', blocking);
  if (snapshot.item.status !== 'active') return refuse('ITEM_NOT_ACTIVE', `the item status is "${snapshot.item.status}"`);
  if (baselineEval.dimensions.every((d) => d.result === 'PASSED')) return refuse('POLICY_ALREADY_COMPLIANT', 'the current reorder policy already satisfies every rule; there is nothing to recommend');

  // 2. Interval bounds (whole units). No INDETERMINATE finding above, so demand, cost and currency are usable here.
  const sum = D(snapshot.demand.sumOfMagnitudes);
  const cost = D(snapshot.latestReceipt!.unitCost as string);
  const W = Decimal.of(snapshot.windowDays);
  const rpPct = D(rs.maxChangeReorderPointPct as number); const rqPct = D(rs.maxChangeReorderQuantityPct as number);
  const cap = D(rs.orderValueCap as number); const capPct = D(rs.maxChangeOrderValuePctOfCap as number);

  const rpStock = ceilOf(sum.mul(D(rs.leadTimeDays as number)).mul(D(rs.safetyFactor as number)), W);                 // E2
  const sumCover = floorOf(sum.mul(D(rs.maxCoverDays as number)), W);                                                    // E3
  const sumStock = floorOf(D(rs.maxImpliedStockUnits as number), ONE);                                                   // R1
  const combinedMax = minOf(sumCover, sumStock);

  const rpMin = (() => { const v = ceilOf(rp0.mul(HUNDRED.sub(rpPct)), HUNDRED); return v > rpStock ? v : rpStock; })();
  const rpMax = floorOf(rp0.mul(HUNDRED.add(rpPct)), HUNDRED);
  const rqMin = ceilOf(rq0.mul(HUNDRED.sub(rqPct)), HUNDRED);
  const rqMax = minOf(
    floorOf(rq0.mul(HUNDRED.add(rqPct)), HUNDRED),
    floorOf(cap, cost),                                                                                                     // K3
    floorOf(rq0.mul(HUNDRED).mul(cost).add(cap.mul(capPct)), HUNDRED.mul(cost)),                                         // K4
  );
  const bounds = { reorderPointMin: String(rpMin), reorderPointMax: String(rpMax), reorderQuantityMin: String(rqMin), reorderQuantityMax: String(rqMax), combinedMax: String(combinedMax) };
  if (rpMin > rpMax || rqMin > rqMax || rqMin < 1n || rpMin + rqMin > combinedMax) {
    return refuse('NO_COMPLIANT_SINGLE_STEP', `no whole-unit pair satisfies every rule within one governed step (bounds: ${JSON.stringify(bounds)})`);
  }

  const nearest = (d: Decimal): bigint => floorOf(d.add(D('0.5')), ONE);
  let rp = clamp(nearest(rp0), rpMin, rpMax);
  let rq = clamp(nearest(rq0), rqMin, rqMax);
  if (rp + rq > combinedMax) {
    rq = rqMin > combinedMax - rp ? rqMin : combinedMax - rp;                  // the order quantity yields first, down to its lower bound
    if (rp + rq > combinedMax) rp = combinedMax - rq;                          // then the reorder point, never below the stock-out requirement
    if (rp < rpMin || rq < rqMin || rp + rq > combinedMax) return refuse('NO_COMPLIANT_SINGLE_STEP', 'the combined cap cannot be met inside the governed step');
  }

  // 3. Verify with the real evaluator. Only a fully PASSED candidate is ever returned.
  const proposed = { reorderPoint: Number(rp), reorderQuantity: Number(rq) };
  if (!Number.isSafeInteger(proposed.reorderPoint) || !Number.isSafeInteger(proposed.reorderQuantity)) return refuse('DERIVATION_UNVERIFIED', 'the derived values are outside the safe integer range');
  const verified = evaluate(proposed);
  if (!verified.dimensions.every((d) => d.result === 'PASSED')) {
    return refuse('DERIVATION_UNVERIFIED', 'the derived candidate did not pass the approved rule set', verified.dimensions.filter((d) => d.result !== 'PASSED').map((d) => `${d.dimension}:${d.result}`));
  }
  return {
    outcome: 'CANDIDATE',
    ruleSetVersion: rs.version,
    itemId,
    balanceId: balance.id,
    warehouseId: balance.warehouseId,
    current: { reorderPoint: rp0.toString(), reorderQuantity: rq0.toString() },
    proposed,
    bounds,
    verification: verified.dimensions.map((d) => ({ dimension: d.dimension, result: d.result })),
    demand: { count: snapshot.demand.count, sumOfMagnitudes: sum.toString(), windowDays: snapshot.windowDays },
    unitCost: { amount: cost.toString(), currency: (declaredCurrency as { currency: string }).currency },
    method: REORDER_DERIVATION_METHOD,
  };
}
