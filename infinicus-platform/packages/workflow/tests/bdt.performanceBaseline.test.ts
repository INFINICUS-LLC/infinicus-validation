/** NEW-BDT-SIM-01: the pure Simulation-ready baseline of a published business performance state (no database, no clock). */
import { describe, expect, it } from 'vitest';
import { DT_TO_SIM_CONTRACT_VERSION, validateDTToSIMHandoff, type BusinessPerformanceTwinState } from '@infinicus/handoff-contracts';
import { assembleBiPerformanceEvidence, digestOf } from '../src/performance/biPerformanceEvidence.js';
import { buildPerformanceBaseline } from '../src/performance/performanceBaseline.js';
import { financialFor, PERIOD, salesFor } from './helpers/performanceFixtures.js';

const BIZ = '11111111-1111-4111-8111-111111111111';
const SNAP = '22222222-2222-4222-8222-222222222222';
const OBSERVED = '2026-11-02T10:00:00.000Z';
const NOW = new Date('2026-11-02T10:05:30.900Z');

const stateOf = (fin = financialFor(BIZ), sales = salesFor(BIZ)): BusinessPerformanceTwinState => {
  const r = assembleBiPerformanceEvidence({ businessId: BIZ, period: PERIOD, financial: fin, sales });
  if (!r.ok) throw new Error(r.detail);
  return { schema: 'business-performance-twin-state/1', model: { name: 'business-performance-representation', version: '1', method: 'VERBATIM_BI_EVIDENCE' }, observedAt: OBSERVED, evidence: r.evidence } as BusinessPerformanceTwinState;
};
const build = (state = stateOf()) => buildPerformanceBaseline({ state, snapshotId: SNAP, now: NOW });
const ok = (b: ReturnType<typeof build>) => { if (!b.ok) throw new Error(b.detail); return b; };
const byCode = (b: ReturnType<typeof ok>) => Object.fromEntries(b.variables.map((v) => [v.variableCode, v]));

describe('variables are the BI figures, verbatim, per currency', () => {
  const b = ok(build()); const v = byCode(b);
  it('copies money as exact text with its currency as the unit, and keeps each currency in its own variable codes', () => {
    expect(v['financial.USD.revenue']).toEqual({ variableCode: 'financial.USD.revenue', value: '150.00', unit: 'USD' });
    expect(v['financial.KWD.revenue']).toEqual({ variableCode: 'financial.KWD.revenue', value: '31.500', unit: 'KWD' });
    expect(v['financial.USD.expenses'].value).toBe('15.00');
    expect(v['financial.KWD.expenses'].value).toBe('0.000');
    expect(b.variables.filter((x) => x.variableCode.startsWith('financial.USD.')).every((x) => !String(x.value).includes('KWD'))).toBe(true);
    expect(b.variables.some((x) => /\.(total|all|combined)\b/.test(x.variableCode))).toBe(false);
  });
  it('copies sales in minor units with the exponent in the unit, and does not mix them with the financial decimals', () => {
    expect(v['sales.USD.netMinor']).toEqual({ variableCode: 'sales.USD.netMinor', value: '15000', unit: 'USD minor units (10^-2)' });
    expect(v['sales.KWD.netMinor'].unit).toBe('KWD minor units (10^-3)');
    expect(v['sales.USD.completedOrders'].value).toBe('2');
    expect(v['sales.USD.reconciles'].value).toBe(true);
  });
  it('passes BI states through: gross profit without cost evidence has a state and no amount; with cost evidence it has the BI amount and margin', () => {
    expect(v['financial.USD.grossProfit.state'].value).toBe('INSUFFICIENT_COST_EVIDENCE');
    expect(v['financial.USD.grossProfit']).toBeUndefined();
    expect(v['financial.KWD.grossProfit.state'].value).toBe('COMPUTED');
    expect(v['financial.KWD.grossProfit']).toMatchObject({ value: '21.000', unit: 'KWD' });
    expect(v['financial.KWD.grossProfit.marginPercent']).toMatchObject({ value: '66.67', unit: '%' });
  });
  it('every value is exact text or a boolean (never a number), so no invented uncertainty is needed', () => {
    expect(b.variables.every((x) => typeof x.value === 'string' || typeof x.value === 'boolean')).toBe(true);
  });
  it('is deterministic: sorted by code, and identical inputs give identical output', () => {
    const codes = b.variables.map((x) => x.variableCode);
    expect(codes).toEqual([...codes].sort());
    expect(new Set(codes).size).toBe(codes.length);
    expect(build()).toEqual(b);
  });
});

describe('quality, evidence and assumptions', () => {
  const b = ok(build());
  it('references the twin snapshot, the evidence digest and both BI source digests', () => {
    const s = stateOf();
    expect(b.evidenceReferences).toEqual([
      `twin-snapshot:${SNAP}`, `bi-performance-evidence:${s.evidence.evidenceDigest}`,
      expect.stringMatching(/^bi-financial-report\/1:[0-9a-f]{64}$/), expect.stringMatching(/^bi-sales-report \(BI-SALES-1\):[0-9a-f]{64}$/),
    ]);
  });
  it('states confidence 1 only for corroborated recorded facts and freshness in whole seconds since the observation', () => {
    expect(b.quality).toEqual({ confidence: 1, freshnessSeconds: 330 });
    expect(buildPerformanceBaseline({ state: stateOf(), snapshotId: SNAP, now: new Date('2026-11-02T09:00:00.000Z') })).toMatchObject({ ok: true, quality: { freshnessSeconds: 0 } });
  });
  it('says what the values are and are not, and carries the BI coverage', () => {
    expect(b.assumptions.join(' ')).toMatch(/recorded fact/);
    expect(b.assumptions).toEqual(expect.arrayContaining(['BI financial coverage: NO_CURRENCY_CONVERSION', `The reporting period is ${PERIOD.from}..${PERIOD.to}, UTC calendar days.`]));
    expect(b.objective).toMatch(/not a recommendation/);
  });
});

describe('refuses what is not simulation-ready', () => {
  it('a partial state (one domain missing) is not handed to Simulation', () => {
    const fin = { outcome: 'UNAVAILABLE', code: 'FACTS_UNAVAILABLE', detail: 'down' } as const;
    expect(build(stateOf(fin))).toMatchObject({ ok: false, detail: expect.stringContaining('both') });
  });
  it('a tampered state fails the integrity check', () => {
    const s = stateOf(); (s.evidence.financial as { currencies: { revenue: { amount: string } }[] }).currencies[0]!.revenue.amount = '999.00';
    expect(build(s)).toMatchObject({ ok: false, detail: expect.stringContaining('integrity') });
  });
  it('a state that records no currency at all is refused even if it is validly sealed (forged-but-consistent evidence)', () => {
    const s = stateOf();
    const prov = (c: string) => ({ status: 'PROVIDED', provenance: { contract: c, digest: 'a'.repeat(64), period: PERIOD }, coverage: [], currencies: [] });
    const body = { contract: s.evidence.contract, businessId: BIZ, period: PERIOD, financial: prov('bi-financial-report/1'), sales: prov('bi-sales-report (BI-SALES-1)'), crossCheck: { performed: true, revenue: [] } };
    const forged = { ...s, evidence: { ...body, evidenceDigest: digestOf(body) } } as unknown as BusinessPerformanceTwinState;
    expect(build(forged)).toMatchObject({ ok: false, detail: expect.stringContaining('no currency') });
  });
  it('a state whose cross-check flag contradicts its domains fails integrity (the cross-check is implied by both domains being provided)', () => {
    const s = stateOf(); (s.evidence.crossCheck as { performed: boolean }).performed = false;
    expect(build(s)).toMatchObject({ ok: false, detail: expect.stringContaining('integrity') });
  });
  it('an invalid observation time is refused', () => {
    const s = stateOf(); s.observedAt = 'yesterday-ish';
    expect(build(s)).toMatchObject({ ok: false, detail: expect.stringContaining('observation time') });
  });
});

describe('the result satisfies the frozen DT -> SIM contract', () => {
  it('a hand-off built from it passes validateDTToSIMHandoff unchanged', () => {
    const b = ok(build());
    const handoff = {
      handoffId: 'h', sourceLayer: 'DT', sourceBlock: 'BDT-PERFORMANCE-01', targetLayer: 'SIM', targetBlock: 'SIM-01', correlationId: 'c', lineage: [], status: 'ready', createdAt: NOW.toISOString(),
      payload: {
        contractVersion: DT_TO_SIM_CONTRACT_VERSION, tenantId: 't', workspaceId: 'w', businessId: BIZ, digitalTwinInstanceId: 'i', snapshotId: SNAP, snapshotVersion: 1,
        scenarioBaselineId: 'b', scenarioBaselineVersion: 1, objective: b.objective, variables: b.variables, assumptions: b.assumptions, constraints: [], uncertaintyAssignments: [],
        evidenceReferences: b.evidenceReferences, quality: b.quality, effectiveAt: OBSERVED, idempotencyKey: 'k',
      },
    };
    expect(validateDTToSIMHandoff(handoff)).toEqual({ valid: true, reasons: [] });
  });
});
