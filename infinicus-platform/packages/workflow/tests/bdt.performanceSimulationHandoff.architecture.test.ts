/** NEW-BDT-SIM-01 architecture guards (static): the twin publishes to Simulation through the FROZEN contract, derives nothing, and never writes beyond its own tables. */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..', '..', '..');
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const code = (rel: string) => strip(readFileSync(resolve(root, rel), 'utf8'));
const F = {
  baseline: 'packages/workflow/src/performance/performanceBaseline.ts',
  service: 'packages/workflow/src/performance/PerformanceSimulationHandoffService.ts',
  route: 'apps/api/src/routes/performanceSimulationHandoff.ts',
  composition: 'apps/api/src/performanceSimulationHandoffComposition.ts',
};

describe('twin -> simulation hand-off - boundaries', () => {
  it('imports no Business Operations or Business Intelligence code and names no Simulation repository or table (Simulation\'s intake is Simulation\'s own act)', () => {
    for (const k of ['baseline', 'service', 'composition'] as const) {
      // the one allowed BI import is the reporting-period limit constant (a shared bound, not a report)
      const c = code(F[k]).replace("import { MAX_REPORT_DAYS } from '../financial/FinancialIntelligenceService.js';", '');
      expect(c, k).not.toMatch(/business-operations-runtime|FinancialIntelligenceService|SalesReportService|FinancialFactsRepository|SalesFactsRepository/);
      expect(c, k).not.toMatch(/SimulationIntakeRepository|SimulationRunRepository|SimulationModelRepository|simulation\.simulation_|@infinicus\/simulation-engine/);
      expect(c, k).not.toMatch(/\b(SELECT|INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM)\b|\.query\(/);
    }
  });

  it('uses the FROZEN DT -> SIM contract unchanged, validated before AND after persisting; the BUILD-12 bi-to-dt contract is not involved', () => {
    const c = code(F.service);
    expect(c.match(/validateDTToSIMHandoff\(/g)?.length).toBe(2);
    expect(c).toMatch(/DT_TO_SIM_CONTRACT_VERSION/);
    for (const k of Object.keys(F) as (keyof typeof F)[]) expect(code(F[k]), k).not.toMatch(/bi-to-dt|BIToDT/);
    const contract = readFileSync(resolve(root, 'packages/handoff-contracts/src/dt-to-sim.ts'), 'utf8');
    expect(contract).toMatch(/DT_TO_SIM_CONTRACT_VERSION = '1\.0\.0'/);
  });

  it('derives nothing: no float parsing, rounding, summing or averaging; the only arithmetic is the freshness in whole seconds', () => {
    for (const k of ['baseline', 'service'] as const) {
      const c = code(F[k]);
      expect(c, k).not.toMatch(/\b(parseFloat|toFixed|toPrecision|Math\.(round|ceil|trunc|min)|reduce\()/);
      expect(c, k).not.toMatch(/\bNumber\(/);
    }
    expect(code(F.baseline).match(/Math\.(floor|max)\(/g)).toEqual(['Math.max(', 'Math.floor(']);
  });

  it('writes only through the twin-owned repositories, in one shared tenant transaction, and never deletes', () => {
    const c = code(F.service);
    expect(c).toMatch(/withSharedTenantTransaction/);
    for (const m of ['createBaseline', 'addInput', 'validateBaseline', 'publishBaseline', 'createInsightPackage', 'createVersion', 'createPackage', 'markReady', 'dispatch']) expect(c).toContain(`.${m}(`);
    expect(c).not.toMatch(/\.(delete|revoke|reject|acknowledge|supersede\w*)\(/);
    expect(c).toMatch(/'simulation', PERFORMANCE_SIM_TARGET_BLOCK, idempotencyKey/);
  });

  it('exposes exactly one POST (dt:write, subscription, idempotency, business check) and no other verb', () => {
    const c = code(F.route);
    expect(c.match(/server\.(get|post|put|patch|delete)\(/g)).toEqual(['server.post(']);
    expect(c).toMatch(/PERFORMANCE_SIMULATION_HANDOFF_PERMISSION = 'dt:write'/);
    expect(c).toMatch(/requireActiveSubscription\(\), app\.requireIdempotencyKey/);
    expect(c).toMatch(/businesses\.getById/);
  });

  it('is composed only from the business performance twin service', () => {
    const c = code(F.composition);
    expect(c).toMatch(/buildBusinessPerformanceTwinService\(\)/);
    expect(c).not.toMatch(/inventory|ReorderPolicy|Adi|Aba|Simulation(?!Handoff)/i);
  });
});
