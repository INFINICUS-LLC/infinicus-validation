import { describe, expect, it } from 'vitest';
import {
  CANONICAL_ACTION_TYPES, SIMULATION_NOT_APPLICABLE_ALLOWED, SIMULATION_NOT_APPLICABLE_REASON_CODE, simulationNotApplicableProblem, actionTypeKey, INVENTORY_REORDER_POLICY_UPDATE_V1, actionTypeMatchesCanonical, canonicalActionTypeRegistry,
  checkParameterValue, requiredGovernanceDimensions, validateActionTypeContract,
} from '../src/authorized-action-package';
import type { ActionTypeContract } from '../src/authorized-action-package';

const C = INVENTORY_REORDER_POLICY_UPDATE_V1;
const clone = (c: ActionTypeContract): ActionTypeContract => JSON.parse(JSON.stringify(c)) as ActionTypeContract;

describe('canonical action vocabulary (owner ruling 1)', () => {
  it('defines inventory_reorder_policy_update v1 for inventory_item with two numeric params, min 0', () => {
    expect(C.code).toBe('inventory_reorder_policy_update');
    expect(C.schemaVersion).toBe('1');
    expect(C.targetKinds).toEqual(['inventory_item']);
    expect(C.parameters.reorderPoint).toEqual({ type: 'number', required: true, min: 0 });
    expect(C.parameters.reorderQuantity).toEqual({ type: 'number', required: true, min: 0 });
    expect(validateActionTypeContract(C)).toEqual([]);
  });

  it('declares the ruled governance impacts', () => {
    expect([...C.governanceImpact.reorderPoint]).toEqual(['CONSTRAINTS', 'RESOURCE_REQUIREMENTS', 'EXPECTED_OUTCOME']);
    expect([...C.governanceImpact.reorderQuantity]).toEqual(['CONSTRAINTS', 'RESOURCE_REQUIREMENTS', 'COST', 'EXPECTED_OUTCOME']);
    const r = requiredGovernanceDimensions(C, ['reorderPoint', 'reorderQuantity']);
    expect(r.basis).toBe('DECLARED_IMPACT');
    expect(r.dimensions).not.toContain('SIMULATION');
  });

  it('does not automatically require Simulation, and is fail-closed on applicability', () => {
    expect(requiredGovernanceDimensions(C, ['reorderPoint']).dimensions).not.toContain('SIMULATION');
    expect(C.applicability).toEqual({});
  });

  it('allows a governed NOT_APPLICABLE simulation for exactly this type and version (B2c amendment), nothing else', () => {
    expect([...SIMULATION_NOT_APPLICABLE_ALLOWED]).toEqual(['inventory_reorder_policy_update@1']);
    expect(SIMULATION_NOT_APPLICABLE_ALLOWED.has(actionTypeKey(C.code, C.schemaVersion))).toBe(true);
    expect(SIMULATION_NOT_APPLICABLE_ALLOWED.has('inventory_reorder_policy_update@2')).toBe(false);
    expect(SIMULATION_NOT_APPLICABLE_REASON_CODE).toBe('NO_APPLICABLE_SIMULATION_MODEL');
    expect(Object.isFrozen(SIMULATION_NOT_APPLICABLE_ALLOWED)).toBe(true);
  });

  it('simulationNotApplicableProblem: listed type + exact canonical reason only; absence or any other reason/type is refused', () => {
    const ok = { code: 'NO_APPLICABLE_SIMULATION_MODEL' };
    expect(simulationNotApplicableProblem(SIMULATION_NOT_APPLICABLE_ALLOWED, C.code, C.schemaVersion, ok)).toBeNull();
    expect(simulationNotApplicableProblem(SIMULATION_NOT_APPLICABLE_ALLOWED, C.code, C.schemaVersion, { code: 'NOT_SIMULATION_BACKED' })).toMatch(/must carry the reason code NO_APPLICABLE_SIMULATION_MODEL/);
    expect(simulationNotApplicableProblem(SIMULATION_NOT_APPLICABLE_ALLOWED, C.code, C.schemaVersion, { code: 'no_applicable_simulation_model' })).not.toBeNull();
    expect(simulationNotApplicableProblem(SIMULATION_NOT_APPLICABLE_ALLOWED, C.code, C.schemaVersion, undefined)).not.toBeNull();
    expect(simulationNotApplicableProblem(SIMULATION_NOT_APPLICABLE_ALLOWED, C.code, C.schemaVersion, {})).not.toBeNull();
    expect(simulationNotApplicableProblem(SIMULATION_NOT_APPLICABLE_ALLOWED, 'other_action', '1', ok)).toMatch(/requires a simulation run reference/);
    expect(simulationNotApplicableProblem(SIMULATION_NOT_APPLICABLE_ALLOWED, C.code, '2', ok)).toMatch(/requires a simulation run reference/);
    expect(simulationNotApplicableProblem(new Set(), C.code, C.schemaVersion, ok)).toMatch(/requires a simulation run reference/);
  });

  it('requires a validity bound and every other governed field for this type (owner ruling D3D-1 unchanged)', () => {
    expect(C.applicability.validityBound).toBeUndefined();
    for (const field of ['executionWindow', 'preconditions', 'budget', 'rollback', 'monitoring'] as const) expect(C.applicability[field]).toBeUndefined();
  });

  it('rejects negative and non-numeric values', () => {
    expect(checkParameterValue(C.parameters.reorderPoint, -1)).not.toEqual([]);
    expect(checkParameterValue(C.parameters.reorderPoint, '5')).not.toEqual([]);
    expect(checkParameterValue(C.parameters.reorderPoint, 0)).toEqual([]);
    expect(checkParameterValue(C.parameters.reorderQuantity, 12.5)).toEqual([]);
  });

  it('is registered once in the canonical registry', () => {
    expect(CANONICAL_ACTION_TYPES).toHaveLength(1);
    expect(canonicalActionTypeRegistry().resolve(C.code, C.schemaVersion)).toBe(C);
    expect(canonicalActionTypeRegistry().resolve(C.code, '2')).toBeNull();
  });
});

describe('workspace definition vs canonical contract (ruling G-1)', () => {
  it('matches an identical copy regardless of key and list order', () => {
    const copy = clone(C);
    copy.targetKinds = [...copy.targetKinds].reverse();
    expect(actionTypeMatchesCanonical(copy, C)).toBe(true);
  });

  it.each([
    ['a changed parameter bound', (c: ActionTypeContract) => { (c.parameters as Record<string, unknown>).reorderPoint = { type: 'number', required: true, min: 1 }; }],
    ['a missing governance impact', (c: ActionTypeContract) => { (c.governanceImpact as Record<string, unknown>).reorderQuantity = ['COST']; }],
    ['a loosened applicability', (c: ActionTypeContract) => { (c.applicability as Record<string, unknown>).budget = 'NOT_APPLICABLE_ALLOWED'; }],
    ['an extra target kind', (c: ActionTypeContract) => { (c.targetKinds as string[]).push('warehouse'); }],
    ['an extra parameter', (c: ActionTypeContract) => { (c.parameters as Record<string, unknown>).leadTimeDays = { type: 'integer', required: false }; }],
  ])('diverges on %s', (_name, mutate) => {
    const copy = clone(C);
    mutate(copy);
    expect(actionTypeMatchesCanonical(copy, C)).toBe(false);
  });
});
