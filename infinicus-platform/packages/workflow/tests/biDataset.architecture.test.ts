/**
 * BI-1 dataset materialization guard: the intake -> dataset step writes business_intelligence only, reads exactly one BO table (the publication package, for
 * its period), pins every read to the caller's scope, never invents a quality or completeness score, and the service holds no SQL and no BO code.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(join(here, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const repository = read('../../database/src/repositories/bi/IntakeDatasetRepository.ts');
const service = read('../src/BusinessIntelligenceDatasetService.ts');

describe('BI-1 dataset materialization: BI writes BI, BO is only read', () => {
  it('no statement writes, locks or deletes a business_operations table', () => {
    for (const [name, code] of [['repository', repository], ['service', service]] as const) {
      expect(code, name).not.toMatch(/(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(\s+TABLE)?)\s+business_operations\./i);
    }
    for (const m of repository.matchAll(/(?:INSERT\s+INTO|UPDATE)\s+([a-z_]+\.[a-z_]+)/gi)) expect(m[1].startsWith('business_intelligence.'), m[1]).toBe(true);
  });
  it('the only BO table read is the publication package, pinned to tenant, workspace and business from the caller', () => {
    expect([...new Set([...repository.matchAll(/business_operations\.([a-z_]+)/g)].map((m) => m[1]))]).toEqual(['bo_publication_packages']);
    const read = /FROM business_operations\.bo_publication_packages WHERE([^`]*)`,\s*\[([^\]]*)\]/.exec(repository);
    expect(read).not.toBeNull();
    expect(read![1]).toMatch(/business_id = \$\d/); expect(read![1]).toMatch(/tenant_id = \$\d/); expect(read![1]).toMatch(/workspace_id = \$\d/);
    expect(read![2]).toMatch(/ctx\.tenantId/); expect(read![2]).toMatch(/ctx\.workspaceId/);
  });
  it('every statement on the intake is pinned to the caller scope', () => {
    const m = /FROM business_intelligence\.intelligence_intake_packages\s+WHERE([^`]*)`,\s*\[([^\]]*)\]/.exec(repository);
    expect(m).not.toBeNull(); expect(m![1]).toMatch(/tenant_id = \$\d/); expect(m![1]).toMatch(/workspace_id = \$\d/); expect(m![2]).toMatch(/ctx\.tenantId/);
  });
  it('no quality or completeness score is ever assigned: the version is inserted with NULL for both', () => {
    expect(repository).toMatch(/quality_score, completeness_score,[\s\S]*?VALUES \(\$1,\$2,\$3,\$4,\$5,\$6,\$7,\$8,NULL,NULL,'published'/);
    expect(repository).not.toMatch(/SET\s+(quality_score|completeness_score)/i);
  });
  it('no import of Business Operations, Data Acquisition or downstream layer code; the service performs no SQL', () => {
    for (const code of [repository, service]) expect(code).not.toMatch(/@infinicus\/(business-operations-runtime|data-acquisition-runtime|simulation-engine|outcome-monitoring-runtime)/);
    expect([...service.matchAll(/from '(@infinicus\/[a-z-]+)'/g)].map((m) => m[1])).toEqual(['@infinicus/database']);
    expect(service).not.toMatch(/\b(SELECT|INSERT|UPDATE|DELETE)\b\s/);
  });
});
