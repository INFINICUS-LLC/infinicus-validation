/** BI-2-DEV-01 architecture guards (static): the BI-09 registry rules are pure - no persistence, no clock or id generation, no calculation, no BO access. */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dir = resolve(__dirname, '..', 'src', 'bi');
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
const code = Object.fromEntries(files.map((f) => [f, strip(readFileSync(resolve(dir, f), 'utf8'))]));

describe('BI-09 registry rules - boundaries', () => {
  it('the domain folder holds exactly the two reviewed modules', () => {
    expect([...files].sort()).toEqual(['metricDefinition.ts', 'metricRegistry.ts']);
  });

  it('imports nothing but its own modules and node:crypto (no database, no Business Operations, no other layer, no framework)', () => {
    for (const [f, src] of Object.entries(code)) {
      const specs = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
      for (const s of specs) expect(['./metricDefinition.js', 'node:crypto'], `${f} imports ${s}`).toContain(s);
    }
  });

  it('persists nothing: no SQL, pool, transaction, file, network or browser storage', () => {
    for (const [f, src] of Object.entries(code)) {
      expect(src, f).not.toMatch(/\b(SELECT|INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM|CREATE\s+TABLE)\b/);
      expect(src, f).not.toMatch(/\b(getPool|withTenantTransaction|withSharedTenantTransaction|\.query\(|fetch\(|readFile|writeFile|indexedDB|localStorage|sessionStorage)\b/);
    }
  });

  it('is deterministic: no clock read, no random id (the caller passes the time and the ids)', () => {
    for (const [f, src] of Object.entries(code)) {
      expect(src, f).not.toMatch(/Date\.now\(|new Date\(\)|Math\.random|randomUUID|randomBytes/);
    }
  });

  it('calculates no metric value (that is BI-10): no float parsing, rounding or numeric folding', () => {
    for (const [f, src] of Object.entries(code)) {
      expect(src, f).not.toMatch(/\b(parseFloat|toFixed|toPrecision|Math\.(round|floor|ceil|trunc|sum)|reduce\()/);
    }
  });

  it('is not wired into any route or repository: only the package index, the registry service, the read-only hand-off service and the BI-10 calculation (which consumes BI-09 definitions) import it', () => {
    const src = resolve(__dirname, '..', 'src');
    const stack = [src];
    const importers: string[] = [];
    while (stack.length > 0) {
      const d = stack.pop()!;
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = resolve(d, e.name);
        if (e.isDirectory()) { if (p !== dir) stack.push(p); continue; }
        if (e.name.endsWith('.ts') && /\.\/bi\/|\.\.\/bi\//.test(readFileSync(p, 'utf8'))) importers.push(e.name);
      }
    }
    // BI-2-DEV-04: the read-only hand-off service applies the same pure rules to the stored registry (no route, no repository imports them)
    // BI-2-DEV-05/06: the BI-10 calculation and intelligence hand-off (src/bi10) and the calculation service consume BI-09 definitions and hand-offs; no route and no repository imports the rules
    // BI-2-DEV-07: the calculation persistence service and the warehouse row source (canonical JSON and the run/result shapes) are further BI-10 consumers of the BI-09 rules
    expect([...importers].sort()).toEqual(['BusinessIntelligenceCalculationHandoffService.ts', 'BusinessIntelligenceCalculationPersistenceService.ts', 'BusinessIntelligenceMetricCalculationService.ts', 'BusinessIntelligenceMetricRegistryService.ts', 'PostgresWarehouseRowSource.ts', 'index.ts', 'intelligenceHandoff.ts', 'metricCalculation.ts']);
  });
});
