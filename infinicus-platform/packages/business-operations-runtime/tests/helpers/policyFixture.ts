/** Test-only builders for the B2b inventory policy evaluator tests (pure, no I/O). */
import type { InventoryPolicyFactsSnapshot } from '@infinicus/database';
import type { DeclaredCurrencyFact, EvaluationSubject } from '../../src/inventory-policy/evaluate.js';

export const ITEM_ID = '11111111-1111-4111-8111-111111111111';
export const WAREHOUSE_ID = '22222222-2222-4222-8222-222222222222';

export const subject = (finalParameters: Record<string, unknown> = { reorderPoint: 100, reorderQuantity: 200 }, over: Partial<EvaluationSubject> = {}): EvaluationSubject => ({
  actionType: { code: 'inventory_reorder_policy_update', schemaVersion: '1' },
  target: { kind: 'inventory_item', id: ITEM_ID },
  finalParameters: finalParameters as EvaluationSubject['finalParameters'],
  ...over,
});

/**
 * A healthy world: baseline rp 100 / rq 200, active item, one balance, usable USD receipt cost 10, 12 issues totalling 900 in 90 days
 * (daily demand 10 => rp needs >= 10 x 14 x 1.25 = 175 ... so tests choose parameters deliberately).
 */
export const snapshot = (over: Partial<InventoryPolicyFactsSnapshot> = {}): InventoryPolicyFactsSnapshot => ({
  capturedAt: '2026-10-11T12:00:00.000Z',
  windowStartsAt: '2026-07-13T12:00:00.000Z',
  windowDays: 90,
  demandMovementTypes: ['issue'],
  item: { id: ITEM_ID, status: 'active', unitOfMeasure: 'unit' },
  balances: [{ id: '33333333-3333-4333-8333-333333333333', warehouseId: WAREHOUSE_ID, reorderPoint: '100', reorderQuantity: '200' }],
  latestReceipt: { movementId: '44444444-4444-4444-8444-444444444444', occurredAt: '2026-10-01T00:00:00.000Z', unitCost: '10', unitCostCurrency: 'USD' },
  demand: { count: 12, sumOfMagnitudes: '900' },
  ...over,
});

export const DECLARED_USD: DeclaredCurrencyFact = { status: 'DECLARED', currency: 'USD', version: 1 };
export const UNDECLARED: DeclaredCurrencyFact = { status: 'UNDECLARED' };
