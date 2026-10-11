import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateActionTypeContract } from '../src';
import type { ActionTypeContract } from '../src';

/**
 * Golden cases shared with the database package (migration 0178's aap_action_type_problems). The contract and the
 * persisted registry must never disagree in the unsafe direction: whatever the database accepts, the contract accepts.
 */
interface GoldenCase { name: string; definition: unknown; contractValid: boolean; dbValid: boolean; note?: string }
const FIXTURE = resolve(__dirname, 'fixtures/action-type-golden-cases.json');
const { cases } = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { cases: GoldenCase[] };

describe('action-type contract: golden cases', () => {
  it('has a meaningful number of cases on every side of the contract/database boundary', () => {
    expect(cases.length).toBeGreaterThanOrEqual(25);
    expect(cases.filter((c) => c.contractValid && c.dbValid).length).toBeGreaterThanOrEqual(4);
    expect(cases.filter((c) => !c.contractValid && !c.dbValid).length).toBeGreaterThanOrEqual(15);
    expect(cases.filter((c) => c.contractValid && !c.dbValid).length).toBeGreaterThanOrEqual(5);
  });

  it('never lets the database accept what the contract rejects', () => {
    expect(cases.filter((c) => c.dbValid && !c.contractValid).map((c) => c.name)).toEqual([]);
  });

  it.each(cases.map((c) => [c.name, c] as const))('contract verdict: %s', (_name, c) => {
    const problems = validateActionTypeContract(c.definition as ActionTypeContract);
    expect(problems.length === 0).toBe(c.contractValid);
  });
});
