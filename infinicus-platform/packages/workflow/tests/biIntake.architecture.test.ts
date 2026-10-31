/**
 * BI-1 architecture guard: Business Intelligence consumes what BO published and never mutates operational data. The intake repository may only READ two BO
 * tables, neither BI intake file may write any business_operations table, import Business Operations code, or take the caller's scope from the handoff.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(join(here, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const repository = read('../../database/src/repositories/bi/BoToBiIntakeRepository.ts');
const service = read('../src/BusinessIntelligenceIntakeService.ts');

describe('BI-1 intake: BI reads BO, BO is never mutated', () => {
  it('no statement of the intake repository or service writes, locks or deletes a business_operations table', () => {
    for (const [name, code] of [['repository', repository], ['service', service]] as const) {
      expect(code, name).not.toMatch(/(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(\s+TABLE)?)\s+business_operations\./i);
      expect(code, name).not.toMatch(/business_operations\.[a-z_]+\s*\([^)]*\)\s*VALUES/i);
      expect(code, name).not.toMatch(/FOR\s+(UPDATE|SHARE)/i);
    }
  });
  it('the only BO tables read are the publication package and its dispatch record', () => {
    const tables = new Set([...repository.matchAll(/business_operations\.([a-z_]+)/g)].map((m) => m[1]));
    expect([...tables].sort()).toEqual(['bo_handoff_records', 'bo_publication_packages']);
    for (const m of repository.matchAll(/FROM\s+business_operations\.[a-z_]+/gi)) expect(m[0]).toMatch(/^FROM/i);
  });
  it('every BO read is pinned to the caller scope (tenant, workspace and business), never to values the handoff supplies as scope', () => {
    for (const m of repository.matchAll(/FROM\s+business_operations\.([a-z_]+)[\s\S]*?\[([^\]]*)\]/gi)) {
      expect(m[0], m[1]).toMatch(/tenant_id = \$\d/);
      expect(m[0], m[1]).toMatch(/workspace_id = \$\d/);
      expect(m[0], m[1]).toMatch(/business_id = \$\d/);
      expect(m[2], m[1]).toMatch(/ctx\.tenantId/);
      expect(m[2], m[1]).toMatch(/ctx\.workspaceId/);
    }
  });
  it('the service compares the handoff scope with the caller context and never writes scope from the handoff', () => {
    expect(service).toMatch(/p\.tenantId !== ctx\.tenantId/);
    expect(service).toMatch(/p\.workspaceId !== ctx\.workspaceId/);
    expect(repository).not.toMatch(/\[\s*input\.tenantId|input\.workspaceId/);
  });
  it('no import of Business Operations, Data Acquisition or downstream layer code (the handoff contract is the only coupling)', () => {
    for (const code of [repository, service]) {
      expect(code).not.toMatch(/@infinicus\/(business-operations-runtime|data-acquisition-runtime|simulation-engine|outcome-monitoring-runtime)/);
    }
    expect([...service.matchAll(/from '(@infinicus\/[a-z-]+)'/g)].map((m) => m[1]).sort()).toEqual(['@infinicus/database', '@infinicus/handoff-contracts']);
  });
  it('the service performs no direct SQL: persistence goes through the repository only', () => {
    expect(service).not.toMatch(/\b(SELECT|INSERT|UPDATE|DELETE)\b\s/);
  });
});
