/** NEW-BDT-SIM-01 + SEC-01 architecture guards (static): the twin publishes to Simulation through the FROZEN contract, derives nothing, and never writes beyond its own tables. */
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

describe('SEC-01 invariants', () => {
  const svc = () => code(F.service);
  const at = (c: string, needle: string): number => { const i = c.indexOf(needle); expect(i, needle).toBeGreaterThan(-1); return i; };

  it('D1: no constant or defaulted confidence anywhere in production code; the gate decides, and the DEFAULT policy is the unratified (closed) one', () => {
    for (const k of ['baseline', 'service'] as const) {
      expect(code(F[k]), k).not.toMatch(/confidence\s*[:=]\s*(1|1\.0|0\.\d+)\b/);
      expect(code(F[k]), k).not.toMatch(/confidence\s*=\s*\d/);                       // no default parameter value
    }
    expect(svc()).toMatch(/evaluateConfidenceGate\(assessment, this\.d\.minimumConfidence\)/);
    expect(svc()).toMatch(/deps\.confidence \?\? new UnratifiedTwinConfidencePolicy\(\)/);
    expect(svc()).toMatch(/minimumConfidence >= DT_TO_SIM_MIN_CONFIDENCE/);
    expect(code('packages/workflow/src/performance/twinConfidencePolicy.ts')).toMatch(/DT_TO_SIM_MIN_CONFIDENCE = 0\.75/);
    expect(code('apps/api/src/performanceSimulationHandoffComposition.ts')).not.toMatch(/confidence\s*:/);       // production composition injects no policy: it stays closed
  });

  it('no production file imports a test helper or the test-only confidence double', () => {
    const files = ['packages/workflow/src/performance/PerformanceSimulationHandoffService.ts', 'packages/workflow/src/performance/performanceBaseline.ts', 'packages/workflow/src/performance/twinConfidencePolicy.ts',
      'packages/workflow/src/performance/handoffEnvelope.ts', 'apps/api/src/performanceSimulationHandoffComposition.ts', 'apps/api/src/routes/performanceSimulationHandoff.ts'];
    for (const f of files) expect(readFileSync(resolve(root, f), 'utf8'), f).not.toMatch(/tests\/helpers|performanceFixtures|testConfidencePolicy|TEST-ONLY/);
  });

  it('D3 then D1 then D2, in that order: the source is revalidated, then confidence is assessed, then the score and the envelope are persisted, and only then is the package readied and dispatched', () => {
    const c = svc();
    const order = ['this.d.twin.currentEvidence(', 'this.d.confidence.assess(', 'evaluateConfidenceGate(', 'withSharedTenantTransaction(ctx', 'this.d.scores.record(', 'this.d.envelopes.record(', 'this.d.packages.markReady(', 'this.d.packages.dispatch('].map((n) => at(c, n));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(at(c, 'validateDTToSIMHandoff(handoff)')).toBeLessThan(at(c, 'this.d.envelopes.record('));       // the frozen contract is validated before the envelope is persisted
  });

  it('D3: the replay path is behind the same gates (revalidation and confidence precede the replay lookup) and verifies the persisted envelope', () => {
    const c = svc();
    expect(at(c, 'this.d.twin.currentEvidence(')).toBeLessThan(at(c, 'const prior = await replay()'));
    expect(at(c, 'evaluateConfidenceGate(')).toBeLessThan(at(c, 'const prior = await replay()'));
    expect(c).toMatch(/verifyPersistedHandoff\(record, score,/);
    expect(c).toMatch(/current\.evidence\.evidenceDigest !== stored\.evidenceDigest/);
    expect(c).not.toMatch(/maxAge|MAX_AGE|staleAfter|stale_after/i);                                           // no invented maximum evidence age
  });

  it('migration 0221 is additive and forward-only: one new table, its own triggers, RLS forced, append-only, self-registered; no existing table altered, dropped, updated or granted', () => {
    const sql = readFileSync(resolve(root, 'infrastructure/database/migrations/0221_create_dt_handoff_envelopes.sql'), 'utf8');
    const stmts = strip(sql.replace(/^--.*$/gm, ''));
    expect(stmts.match(/\bCREATE TABLE\b/g)).toHaveLength(1);
    expect(stmts).not.toMatch(/\bDROP\s+(TABLE|COLUMN|CONSTRAINT|TRIGGER|POLICY)\b/i);
    expect(stmts).not.toMatch(/\bALTER TABLE business_digital_twin\.(?!dt_handoff_envelopes)/);
    expect(stmts).not.toMatch(/\b(UPDATE|DELETE FROM|TRUNCATE TABLE)\s+business_digital_twin\./i);
    expect(stmts).not.toMatch(/\bGRANT\b/i);
    expect(stmts).toMatch(/ENABLE ROW LEVEL SECURITY/); expect(stmts).toMatch(/FORCE ROW LEVEL SECURITY/);
    expect(stmts).toMatch(/forbid_mutation\(\)/); expect(stmts).toMatch(/BEFORE TRUNCATE/);
    expect(stmts).toMatch(/INSERT INTO _migrations \(filename\) VALUES \('0221_create_dt_handoff_envelopes\.sql'\)/);
    expect(stmts.match(/CREATE TRIGGER/g)).toHaveLength(4);
  });
});
