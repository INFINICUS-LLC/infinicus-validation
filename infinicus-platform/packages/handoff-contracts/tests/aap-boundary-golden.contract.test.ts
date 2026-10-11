import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validatePackageBody } from '../src';
import { approvedBody, clone, registry, T } from './aap-fixtures';

/**
 * Golden cases shared with the database package (migration 0179's aap_boundary_problems). For each case the contract's
 * verdict on that ONE field is compared with the label, and the database must never accept what the contract rejects.
 * The action-type applicability rule (NOT_APPLICABLE_NOT_PERMITTED) is a separate rule, proven elsewhere, and is ignored here.
 */
type Field = 'executionWindow' | 'preconditions' | 'budget' | 'rollback' | 'monitoring' | 'simulationRun';
interface GoldenCase { field: Field; name: string; value: unknown; contractValid: boolean; dbValid: boolean; note?: string }
const FIXTURE = resolve(__dirname, 'fixtures/boundary-golden-cases.json');
const { cases } = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { cases: GoldenCase[] };

function contractErrorsFor(c: GoldenCase): string[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the case replaces an arbitrary field of an untyped copy
  const body = clone(approvedBody()) as unknown as Record<string, any>;
  const prefix = c.field === 'simulationRun' ? '$.lineage.simulationRunId' : `$.action.${c.field}`;
  if (c.field === 'simulationRun') body.lineage.simulationRunId = c.value;
  else body.action[c.field] = c.value;
  const result = validatePackageBody(body as never, { actionTypes: registry(), now: T.nowOk });
  return result.errors.filter((e) => e.path.startsWith(prefix) && e.code !== 'NOT_APPLICABLE_NOT_PERMITTED').map((e) => `${e.code} ${e.path}`);
}

describe('boundary fields: golden cases', () => {
  it('covers every field on both sides of the contract/database boundary', () => {
    expect(cases.length).toBeGreaterThanOrEqual(55);
    for (const field of ['executionWindow', 'preconditions', 'budget', 'rollback', 'monitoring', 'simulationRun'] as Field[]) {
      expect(cases.filter((c) => c.field === field && c.contractValid).length).toBeGreaterThanOrEqual(2);
      expect(cases.filter((c) => c.field === field && !c.contractValid).length).toBeGreaterThanOrEqual(3);
    }
  });

  it('never lets the database accept what the contract rejects', () => {
    expect(cases.filter((c) => c.dbValid && !c.contractValid).map((c) => `${c.field}: ${c.name}`)).toEqual([]);
  });

  it.each(cases.map((c) => [`${c.field}: ${c.name}`, c] as const))('contract verdict: %s', (_name, c) => {
    const errors = contractErrorsFor(c);
    expect({ valid: errors.length === 0, errors }).toEqual({ valid: c.contractValid, errors: c.contractValid ? [] : errors });
  });
});
