/**
 * The Simulation-ready baseline of a published business performance twin state (NEW-BDT-SIM-01). Pure and database-free.
 *
 * It maps the VERBATIM BI figures the twin holds onto the variables of the frozen DT -> SIM contract (`dt-to-sim`, unchanged). It derives nothing: every value
 * is a recorded fact copied as exact text with its unit (a currency code, `orders`, or `<CUR> minor units`), so no value is numeric and the contract's
 * probabilistic-uncertainty rule does not apply; no distribution is invented. Each currency stands alone (the currency is part of the variable code).
 *
 * Only a state that is integrity-verified and has BOTH domains provided is simulation-ready (verification ties `crossCheck.performed` to exactly that, so the cross-check is implied). The contract's numeric `confidence` is stated as
 * 1 only in that case, and means "recorded facts corroborated by two independent BI reports", NOT a predictive confidence; anything less is refused rather than
 * given a made-up partial score.
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

export function buildPerformanceBaseline(input: { state: BusinessPerformanceTwinState; snapshotId: string; now: Date }): PerformanceBaselineBuild {
  const { state, snapshotId, now } = input;
  const ev = state.evidence;
  const integrity = verifyBiPerformanceEvidence(ev);
  if (!integrity.valid) return { ok: false, detail: `the twin state failed its integrity check: ${integrity.reasons.join(',')}` };
  if (ev.financial.status !== 'PROVIDED' || ev.sales.status !== 'PROVIDED') return { ok: false, detail: 'both the financial and the sales evidence must be provided; a partial state is not handed to Simulation' };
  const variables = [
    { variableCode: 'domain.financial.status', value: 'PROVIDED', unit: null }, { variableCode: 'domain.sales.status', value: 'PROVIDED', unit: null },
    ...ev.financial.currencies.flatMap(financialVariables), ...ev.sales.currencies.flatMap(salesVariables),
  ].sort((a, b) => (a.variableCode < b.variableCode ? -1 : a.variableCode > b.variableCode ? 1 : 0)) as DTVariableInput[];
  if (ev.financial.currencies.length + ev.sales.currencies.length === 0) return { ok: false, detail: 'the twin state records no currency, so there is nothing to simulate from' };
  const observed = Date.parse(state.observedAt);
  if (Number.isNaN(observed)) return { ok: false, detail: 'the twin state has no valid observation time' };
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
    quality: { confidence: 1, freshnessSeconds: Math.max(0, Math.floor((now.getTime() - observed) / 1000)) },
  };
}
