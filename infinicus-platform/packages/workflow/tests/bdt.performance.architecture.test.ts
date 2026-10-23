/** NEW-BDT-01 architecture guards (static): the twin consumes BI reports only, derives no KPI, converts and sums no money, and writes only through the twin repositories. */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..', '..', '..');
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8');
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const FILES = {
  evidence: 'packages/workflow/src/performance/biPerformanceEvidence.ts',
  service: 'packages/workflow/src/performance/BusinessPerformanceTwinService.ts',
  contract: 'packages/handoff-contracts/src/bi-performance-evidence.ts',
  route: 'apps/api/src/routes/businessPerformanceTwin.ts',
  composition: 'apps/api/src/businessPerformanceTwinComposition.ts',
};
const code = Object.fromEntries(Object.entries(FILES).map(([k, f]) => [k, strip(read(f))]));

describe('BDT performance representation - boundaries', () => {
  it('the twin side never imports Business Operations (BO -> BI -> BDT only) and never touches SQL or a pool', () => {
    for (const k of ['evidence', 'service', 'contract'] as const) {
      expect(code[k], k).not.toMatch(/business-operations-runtime/);
      expect(code[k], k).not.toMatch(/\b(SELECT|INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM)\b/);
      expect(code[k], k).not.toMatch(/\b(getPool|withTenantTransaction|\.query\()/);
    }
    expect(code.route).not.toMatch(/business-operations-runtime|FROM\s+platform\./);
  });

  it('derives and converts nothing: no float parsing, rounding, summing or averaging of figures in the evidence, service or contract', () => {
    for (const k of ['evidence', 'service', 'contract'] as const) {
      expect(code[k], k).not.toMatch(/\b(parseFloat|toFixed|toPrecision|Math\.(round|floor|ceil|trunc)|reduce\()/);
      expect(code[k], k).not.toMatch(/\bNumber\(/);
    }
    // the only arithmetic on money is the exact BigInt scale alignment of minor units to the financial decimals, inside the cross-check (two BigInt calls)
    expect(code.evidence.match(/BigInt\(/g)?.length).toBe(2);
    expect(code.evidence).toMatch(/BigInt\(s!\.netMinor\) \* 10n \*\* BigInt\(4 - s!\.minorUnitExponent\)/);
  });

  it('uses the existing twin repositories exactly as the inventory item twin does, in one shared tenant transaction', () => {
    expect(code.service).toMatch(/withSharedTenantTransaction/);
    for (const m of ['createSnapshot', 'addValue', 'addEvidence', 'validateSnapshot', 'publishSnapshot']) expect(code.service).toContain(`snapshots.${m}(`);
    expect(code.service).not.toMatch(/supersedeSnapshot|DELETE|\.delete\(/);
  });

  it('the contract is additive: the frozen bi-to-dt contract is not imported, extended or used', () => {
    for (const k of ['evidence', 'service', 'contract', 'route', 'composition'] as const) expect(code[k], k).not.toMatch(/bi-to-dt|BIToDT/);
  });

  it('exposes exactly one POST (dt:write, subscription, idempotency) and one GET (dt:read), and no other verb', () => {
    expect(code.route.match(/server\.(get|post|put|patch|delete)\(/g)).toEqual(['server.post(', 'server.get(']);
    expect(code.route).toMatch(/BUSINESS_PERFORMANCE_TWIN_WRITE_PERMISSION = 'dt:write'/);
    expect(code.route).toMatch(/BUSINESS_PERFORMANCE_TWIN_READ_PERMISSION = 'dt:read'/);
    expect(code.route).toMatch(/requireActiveSubscription\(\), app\.requireIdempotencyKey/);
    expect(code.route).toMatch(/businesses\.getById/);
  });

  it('is composed only from the two BI services', () => {
    expect(code.composition).toMatch(/buildFinancialIntelligenceService\(\)/);
    expect(code.composition).toMatch(/buildSalesReportService\(\)/);
    expect(code.composition).not.toMatch(/inventory|ReorderPolicy|Simulation|Adi|Aba/i);
  });
});
