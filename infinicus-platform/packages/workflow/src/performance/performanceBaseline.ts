/**
 * The Simulation-ready baseline of a published business performance twin state (NEW-BDT-SIM-01). Pure and database-free.
 *
 * It maps the VERBATIM BI figures the twin holds onto the variables of the frozen DT -> SIM contract (`dt-to-sim`, unchanged). It derives nothing: every value
 * is a recorded fact copied as exact text with its unit (a currency code, `orders`, or `<CUR> minor units`), so no value is numeric and the contract's
 * probabilistic-uncertainty rule does not apply; no distribution is invented. Each currency stands alone (the currency is part of the variable code).
 *
 * Only a state that is integrity-verified and has BOTH domains provided is simulation-ready (verification ties `crossCheck.performed` to exactly that, so the cross-check is implied).
 * The contract's numeric `confidence` is the Twin Confidence supplied by the caller AFTER it passed the confidence gate (`twinConfidencePolicy`): it is never defaulted or derived here,
 * and integrity or agreement of the BI reports is not a confidence.
 */
import type { BusinessPerformanceTwinState, DTQualityEvidence, DTVariableInput, FinancialKpis, SalesKpis } from '@infinicus/handoff-contracts';
import { verifyBiPerformanceEvidence } from './biPerformanceEvidence.js';

export type PerformanceBaselineBuild =
  | { ok: true; objective: string; variables: DTVariableInput[]; assumptions: string[]; evidenceReferences: string[]; quality: DTQualityEvidence }
  | { ok: false; detail: string };

const financialVariables = (k: FinancialKpis): DTVariableInput[] => {
  const c = k.currency; const p = `financial.${c}`;
  const out: DTVariableInput[] = [
    { variableCode: `${p}.revenue`, value: k.revenue.amount, unit: c },
    { variableCode: `${p}.revenue.orders`, value: String(k.revenue.count), unit: 'orders' },
    { variableCode: `${p}.expenses`, value: k.expenses.amount, unit: c },
    { variableCode: `${p}.expenses.items`, value: String(k.expenses.count), unit: 'items' },
    { variableCode: `${p}.goodsReceived`, value: k.goodsReceived.amount, unit: c },
    { variableCode: `${p}.goodsReceived.lines`, value: String(k.goodsReceived.count), unit: 'lines' },
    { variableCode: `${p}.averageOrderValue.state`, value: k.averageOrderValue.state, unit: null },
    { variableCode: `${p}.grossProfit.state`, value: k.grossProfit.state, unit: null },
    { variableCode: `${p}.grossProfit.evidence.saleLines`, value: String(k.grossProfit.evidence.saleLines), unit: 'lines' },
    { variableCode: `${p}.grossProfit.evidence.saleLinesWithCost`, value: String(k.grossProfit.evidence.saleLinesWithCostEvidence), unit: 'lines' },
  ];
  if (k.averageOrderValue.amount !== null) out.push({ variableCode: `${p}.averageOrderValue`, value: k.averageOrderValue.amount, unit: c });
  if (k.grossProfit.state === 'COMPUTED' && k.grossProfit.amount !== null) {
    out.push({ variableCode: `${p}.grossProfit`, value: k.grossProfit.amount, unit: c });
    if (k.grossProfit.marginPercent !== null) out.push({ variableCode: `${p}.grossProfit.marginPercent`, value: k.grossProfit.marginPercent, unit: '%' });
  }
  return out;
};

const salesVariables = (k: SalesKpis): DTVariableInput[] => {
  const c = k.currency; const p = `sales.${c}`; const minor = `${c} minor units (10^-${k.minorUnitExponent})`;
  const out: DTVariableInput[] = [
    { variableCode: `${p}.completedOrders`, value: String(k.completedOrders), unit: 'orders' },
    { variableCode: `${p}.voidedOrders`, value: String(k.voidedOrders), unit: 'orders' },
    { variableCode: `${p}.openOrders`, value: String(k.openOrders), unit: 'orders' },
    { variableCode: `${p}.otherStatusOrders`, value: String(k.otherStatusOrders), unit: 'orders' },
    { variableCode: `${p}.grossMinor`, value: String(k.grossMinor), unit: minor },
    { variableCode: `${p}.discountMinor`, value: String(k.discountMinor), unit: minor },
    { variableCode: `${p}.netMinor`, value: String(k.netMinor), unit: minor },
    { variableCode: `${p}.reconciles`, value: k.reconciles, unit: null },
  ];
  if (k.averageOrderNetMinor !== null) out.push({ variableCode: `${p}.averageOrderNetMinor`, value: String(k.averageOrderNetMinor), unit: minor });
  return out;
};

/**
 * The variable grammar of the performance hand-off (the vocabulary a future Simulation-owned intake must parse; documented in
 * docs/architecture/bdt/NEW-BDT-SIM-01_VARIABLE_GRAMMAR.md). Every variable code is `<domain>.<CUR>.<metric>` or `domain.<domain>.status`, where CUR is a three-letter ISO 4217
 * code; every value is exact TEXT (or a boolean for `reconciles`), never a JavaScript number; the unit says how to read it.
 */
export const PERFORMANCE_VARIABLE_GRAMMAR = Object.freeze({
  code: /^(?:domain\.(?:financial|sales)\.status|(?:financial|sales)\.[A-Z]{3}\.[A-Za-z]+(?:\.[A-Za-z]+)*)$/,
  /** A money amount: optional minus, digits, at most four decimals (unit = the currency code). */
  decimalText: /^-?\d+(?:\.\d{1,4})?$/,
  /** An integer count or a sales amount in minor units (unit = 'orders' | 'items' | 'lines' | '<CUR> minor units (10^-N)'). */
  integerText: /^-?\d+$/,
  unit: /^(?:[A-Z]{3}|%|orders|items|lines|[A-Z]{3} minor units \(10\^-[0-4]\))$/,
});

/** Whether a published twin state can be handed to Simulation at all (before any confidence is considered). Pure. */
export function assessSimulationReadiness(state: BusinessPerformanceTwinState): { ok: true } | { ok: false; detail: string } {
  const ev = state.evidence;
  const integrity = verifyBiPerformanceEvidence(ev);
  if (!integrity.valid) return { ok: false, detail: `the twin state failed its integrity check: ${integrity.reasons.join(',')}` };
  if (ev.financial.status !== 'PROVIDED' || ev.sales.status !== 'PROVIDED') return { ok: false, detail: 'both the financial and the sales evidence must be provided; a partial state is not handed to Simulation' };
  if (ev.financial.currencies.length + ev.sales.currencies.length === 0) return { ok: false, detail: 'the twin state records no currency, so there is nothing to simulate from' };
  if (Number.isNaN(Date.parse(state.observedAt))) return { ok: false, detail: 'the twin state has no valid observation time' };
  return { ok: true };
}

/** `confidence` is the already-gated Twin Confidence (see twinConfidencePolicy); this function never decides or defaults it. */
export function buildPerformanceBaseline(input: { state: BusinessPerformanceTwinState; snapshotId: string; now: Date; confidence: number }): PerformanceBaselineBuild {
  const { state, snapshotId, now, confidence } = input;
  const ready = assessSimulationReadiness(state);
  if (!ready.ok) return ready;
  const ev = state.evidence;
  if (ev.financial.status !== 'PROVIDED' || ev.sales.status !== 'PROVIDED') return { ok: false, detail: 'both domains must be provided' };   // narrows the type; unreachable after readiness
  const variables = [
    { variableCode: 'domain.financial.status', value: 'PROVIDED', unit: null }, { variableCode: 'domain.sales.status', value: 'PROVIDED', unit: null },
    ...ev.financial.currencies.flatMap(financialVariables), ...ev.sales.currencies.flatMap(salesVariables),
  ].sort((a, b) => (a.variableCode < b.variableCode ? -1 : a.variableCode > b.variableCode ? 1 : 0)) as DTVariableInput[];
  const observed = Date.parse(state.observedAt);
  const { from, to } = ev.period;
  return {
    ok: true,
    objective: `Establish the recorded business performance baseline for ${from}..${to} (financial and sales, per currency). It states recorded facts only; it is not a recommendation.`,
    variables,
    assumptions: [
      'Every value is a recorded fact from governed Business Intelligence reports, copied verbatim as exact text; none is a forecast or an estimate.',
      'Values are exact text, not probabilistic variables, so no uncertainty distribution is assigned.',
      'Each currency stands alone: the currency is part of every variable code and no conversion or cross-currency total exists.',
      `The reporting period is ${from}..${to}, UTC calendar days.`,
      ...ev.financial.coverage.map((c) => `BI financial coverage: ${c}`),
      ...ev.sales.coverage.map((c) => `BI sales coverage: ${c}`),
    ],
    evidenceReferences: [
      `twin-snapshot:${snapshotId}`, `bi-performance-evidence:${ev.evidenceDigest}`,
      `${ev.financial.provenance.contract}:${ev.financial.provenance.digest}`, `${ev.sales.provenance.contract}:${ev.sales.provenance.digest}`,
    ],
    quality: { confidence, freshnessSeconds: Math.max(0, Math.floor((now.getTime() - observed) / 1000)) },
  };
}
