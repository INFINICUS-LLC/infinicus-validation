/** P0-6c: the adapter's pure parsing of a sealed package (defence in depth - the contract refuses most of these at sealing) and the precondition vocabulary. */
import { describe, expect, it } from 'vitest';
import { InventoryReorderPolicyExecutionAdapter, evaluatePreconditions } from '../src/index.js';
import { Decimal } from '../src/inventory-policy/decimal.js';

const ITEM = '00000000-0000-4000-8000-000000000001';
const pkg = (over: { type?: any; target?: any; parameters?: any } = {}): any => ({
  action: {
    type: over.type ?? { code: 'inventory_reorder_policy_update', schemaVersion: '1' },
    target: over.target ?? { kind: 'inventory_item', id: ITEM },
    parameters: over.parameters ?? { reorderPoint: 150, reorderQuantity: 250 },
  },
});
const adapter = new InventoryReorderPolicyExecutionAdapter({ executor: {} as never, evaluations: {} as never });

describe('InventoryReorderPolicyExecutionAdapter.parse', () => {
  it('reads the target and the exact values', () => {
    const plan = adapter.parse(pkg()) as any;
    expect(plan.itemId).toBe(ITEM);
    expect(plan.requested.reorderPoint.toString()).toBe('150');
    expect(plan.requested.reorderQuantityNumber).toBe(250);
    expect((adapter.parse(pkg({ parameters: { reorderPoint: 0, reorderQuantity: 0 } })) as any).requested.reorderPoint.isZero()).toBe(true);
    expect((adapter.parse(pkg({ parameters: { reorderPoint: 1.2345, reorderQuantity: 0.0001 } })) as any).requested.reorderPoint.toString()).toBe('1.2345');
  });

  it.each([
    ['another action type', { type: { code: 'adjust_price', schemaVersion: '1' } }, 'PARAMETERS_INVALID'],
    ['another schema version', { type: { code: 'inventory_reorder_policy_update', schemaVersion: '2' } }, 'PARAMETERS_INVALID'],
    ['a non-UUID target', { target: { kind: 'inventory_item', id: 'sku-123' } }, 'TARGET_INVALID'],
    ['another target kind', { target: { kind: 'warehouse', id: ITEM } }, 'TARGET_INVALID'],
    ['a missing parameter', { parameters: { reorderPoint: 1 } }, 'PARAMETERS_INVALID'],
    ['an extra parameter', { parameters: { reorderPoint: 1, reorderQuantity: 2, warehouseId: 'x' } }, 'PARAMETERS_INVALID'],
    ['a negative value', { parameters: { reorderPoint: -1, reorderQuantity: 2 } }, 'PARAMETERS_INVALID'],
    ['a value that would be rounded', { parameters: { reorderPoint: 1.00001, reorderQuantity: 2 } }, 'PARAMETERS_INVALID'],
    ['a value beyond the column range', { parameters: { reorderPoint: 1e14, reorderQuantity: 2 } }, 'PARAMETERS_INVALID'],
    ['a string number', { parameters: { reorderPoint: '10', reorderQuantity: 2 } }, 'PARAMETERS_INVALID'],
    ['NaN', { parameters: { reorderPoint: Number.NaN, reorderQuantity: 2 } }, 'PARAMETERS_INVALID'],
    ['Infinity', { parameters: { reorderPoint: 1, reorderQuantity: Number.POSITIVE_INFINITY } }, 'PARAMETERS_INVALID'],
  ])('refuses %s', (_name, over, code) => {
    expect((adapter.parse(pkg(over)) as any).code).toBe(code);
  });
});

describe('evaluatePreconditions (the BO vocabulary)', () => {
  const facts = { stock_available: Decimal.parse('50.5') as Decimal };
  const run = (code: string, operator: string, operand: unknown) => evaluatePreconditions([{ code, operator, operand } as never], facts).results[0];

  it('evaluates stock_available with exact decimal comparison', () => {
    expect(run('stock_available', 'gte', 50.5).passed).toBe(true);
    expect(run('stock_available', 'gt', 50.5).passed).toBe(false);
    expect(run('stock_available', 'lt', 51).passed).toBe(true);
    expect(run('stock_available', 'lte', 50.4).passed).toBe(false);
    expect(run('stock_available', 'eq', 50.5).passed).toBe(true);
    expect(run('stock_available', 'neq', 50.5).passed).toBe(false);
    expect(run('stock_available', 'between', [50, 51]).passed).toBe(true);
    expect(run('stock_available', 'between', [51, 60]).passed).toBe(false);
    expect(run('stock_available', 'between', [50.5, 60]).passed).toBe(true); // inclusive at both ends
    expect(run('stock_available', 'between', [40, 50.5]).passed).toBe(true);
    expect(run('stock_available', 'in', [1, 50.5]).passed).toBe(true);
    expect(run('stock_available', 'not_in', [1, 50.5]).passed).toBe(false);
    expect(run('stock_available', 'gte', 50.5).observed).toBe('50.5');
  });

  it('never ignores what it cannot evaluate', () => {
    expect(run('warehouse_is_open', 'eq', true)).toMatchObject({ passed: null, problem: 'UNSUPPORTED_CODE', observed: null });
    expect(run('stock_available', 'contains', 1)).toMatchObject({ passed: null, problem: 'UNSUPPORTED_OPERATOR' });
    for (const [op, operand] of [['gte', '1'], ['gte', null], ['between', [1]], ['between', [5, 1]], ['in', []], ['in', ['x']]] as const) {
      expect(run('stock_available', op, operand), `${op} ${JSON.stringify(operand)}`).toMatchObject({ passed: null, problem: 'OPERAND_INVALID' });
    }
    const r = evaluatePreconditions([{ code: 'stock_available', operator: 'gte', operand: 1 }, { code: 'nope', operator: 'eq', operand: 1 }] as never, facts);
    expect([r.unsupported, r.failed]).toEqual([true, false]);
    expect(evaluatePreconditions([], facts)).toEqual({ results: [], unsupported: false, failed: false });
  });
});

describe('P0-6f: the executor reads the evaluator\'s recorded snapshot values', () => {
  it('accepts numeric text exactly as the BO evaluator records it, and finite numbers; rejects everything else', async () => {
    const { Decimal } = await import('../src/inventory-policy/decimal.js');
    expect(Decimal.fromSnapshotValue('170.0000')?.cmp(Decimal.of(170))).toBe(0);
    expect(Decimal.fromSnapshotValue('0')?.cmp(Decimal.of(0))).toBe(0);
    expect(Decimal.fromSnapshotValue(190)?.cmp(Decimal.of(190))).toBe(0);
    for (const bad of ['', ' 5', '-5', '+5', '1e3', '1,5', 'NaN', 'Infinity', '5.', '.5', null, undefined, {}, [], true, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(Decimal.fromSnapshotValue(bad), String(bad)).toBeNull();
    }
  });
});

describe('InventoryReorderPolicyExecutionAdapter.resolveBaseline: a PLAIN approval needs the baseline evidence its ADI proposal cites (fail closed, O-4 not weakened)', () => {
  const ctx = { tenantId: 't', workspaceId: 'w', userId: 'u' } as never;
  const plainPkg = (over: { proposed?: any; parameters?: any } = {}): any => ({
    scope: { businessId: 'b' },
    action: { type: { code: 'inventory_reorder_policy_update', schemaVersion: '1' }, target: { kind: 'inventory_item', id: ITEM }, parameters: over.parameters ?? { reorderPoint: 150, reorderQuantity: 250 } },
    lineage: {
      modificationEvaluation: { state: 'NOT_APPLICABLE' },
      proposedParameters: over.proposed ?? { state: 'VALUE', value: { parameters: { reorderPoint: 150, reorderQuantity: 250 }, source: { recordId: 'rec-1' } } },
    },
  });
  const plan = (): any => adapter.parse(pkg()) as any;
  const withPort = (evaluationReferencesFor: (...a: any[]) => Promise<any>) => new InventoryReorderPolicyExecutionAdapter({ executor: {} as never, evaluations: {} as never, proposalBaseline: { evaluationReferencesFor } as never });
  const refusal = async (a: InventoryReorderPolicyExecutionAdapter, p: any) => (await a.resolveBaseline(ctx, p, plan())) as any;

  it('no configured source, no proposal, parameters that differ from the proposal, a failing source, and an empty or malformed reference set are all NO_BASELINE_EVIDENCE', async () => {
    const never = async () => { throw new Error('must not be called'); };
    expect(await refusal(adapter, plainPkg())).toMatchObject({ ok: false, code: 'NO_BASELINE_EVIDENCE' });
    expect(await refusal(withPort(never), plainPkg({ proposed: { state: 'NOT_APPLICABLE' } }))).toMatchObject({ ok: false, code: 'NO_BASELINE_EVIDENCE' });
    expect(await refusal(withPort(never), plainPkg({ proposed: { state: 'VALUE', value: { parameters: { reorderPoint: 151, reorderQuantity: 250 }, source: { recordId: 'rec-1' } } } }))).toMatchObject({ ok: false, code: 'NO_BASELINE_EVIDENCE' });
    expect(await refusal(withPort(async () => { throw new Error('down'); }), plainPkg())).toMatchObject({ ok: false, code: 'NO_BASELINE_EVIDENCE' });
    expect(await refusal(withPort(async () => []), plainPkg())).toMatchObject({ ok: false, code: 'NO_BASELINE_EVIDENCE' });
    expect(await refusal(withPort(async () => [{ kind: 'simulation_run', id: 'x', dimension: 'COST' }]), plainPkg())).toMatchObject({ ok: false, code: 'NO_BASELINE_EVIDENCE' });
    expect(await refusal(withPort(async () => [{ kind: 'bo_inventory_policy_evaluation', id: ITEM, dimension: 'COST' }]), plainPkg())).toMatchObject({ ok: false, code: 'NO_BASELINE_EVIDENCE' }); // incomplete dimension set
  });
});
