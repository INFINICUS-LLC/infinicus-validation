import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { IntakeMapperRegistry } from '../src/intake/IntakeMapperRegistry.js';
import { purchaseReceiptMapper, registerDefaultMappers } from '../src/intake/defaultMappers.js';
import { canonicalJson, canonicalReceiptContent, purchaseReceiptProblems, receiptAmountProblem } from '../src/procurement/purchaseReceipt.js';
import { OperationalMappingError } from '../src/errors.js';
import type { IntakeMappingContext, RecordPurchaseReceiptCommand } from '../src/types.js';

const U = () => randomUUID();
const data = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  purchaseOrderId: U(), warehouseId: U(), receiptNumber: 'GRN-1', receivedAt: '2026-10-01T09:30:00.250Z',
  lines: [{ inventoryItemId: U(), quantity: 10, unitCost: 2.5, unitCostCurrency: 'USD' }, { inventoryItemId: U(), quantity: 4.25 }], ...over,
});
const context: IntakeMappingContext = { tenantId: U(), workspaceId: U(), businessId: U(), correlationId: U(), sourceReference: 's#0', provenanceReference: U(), idempotencyKey: 'k', actorId: 'a', occurredAt: new Date().toISOString(), recordIndex: 0 };

describe('purchase_receipt intake mapper (Data-capture Block A)', () => {
  it('is registered by default as record type purchase_receipt v1', () => {
    const registry = registerDefaultMappers(new IntakeMapperRegistry());
    expect(registry.has('purchase_receipt')).toBe(true);
    expect(purchaseReceiptMapper).toMatchObject({ recordType: 'purchase_receipt', version: 1 });
  });

  it('maps a valid record to ONE record_purchase_receipt command carrying the context unchanged and only the contract fields', () => {
    const d = data({ notes: 'dock 3' });
    expect(purchaseReceiptMapper.validate(d)).toEqual([]);
    const [cmd] = purchaseReceiptMapper.map(d, context) as RecordPurchaseReceiptCommand[];
    expect(cmd.type).toBe('record_purchase_receipt');
    expect(cmd.context).toBe(context);
    expect(Object.keys(cmd.payload).sort()).toEqual(['lines', 'notes', 'purchaseOrderId', 'receiptNumber', 'receivedAt', 'warehouseId']);
    expect(cmd.payload.lines[0]).toEqual({ inventoryItemId: (d.lines as any)[0].inventoryItemId, quantity: 10, unitCost: 2.5, unitCostCurrency: 'USD' });
    expect(cmd.payload.lines[1]).toEqual({ inventoryItemId: (d.lines as any)[1].inventoryItemId, quantity: 4.25 }); // no cost, no currency: nothing fabricated
  });

  it('the registry refuses an invalid record with the explicit reasons (nothing is mapped)', () => {
    const registry = registerDefaultMappers(new IntakeMapperRegistry());
    expect(() => registry.mapRecord({ recordType: 'purchase_receipt', data: data({ lines: [{ inventoryItemId: U(), quantity: 0 }] }) }, context)).toThrow(OperationalMappingError);
    expect(() => registry.mapRecord({ recordType: 'purchase_receipt', data: data({ lines: [{ inventoryItemId: U(), quantity: 0 }] }) }, context)).toThrow(/quantity_not_positive/);
  });

  it('validate() and the executor use the SAME rule function, so they cannot drift', () => {
    const d = data({ lines: [{ inventoryItemId: U(), quantity: 1, unitCost: 0, unitCostCurrency: 'USD' }] });
    expect(purchaseReceiptMapper.validate(d)).toEqual(purchaseReceiptProblems(d));
  });

  it('refuses: non-object data, unknown fields (a scope can never be smuggled), and every malformed field', () => {
    expect(purchaseReceiptProblems(null)).toEqual(['receipt_must_be_an_object']);
    expect(purchaseReceiptProblems([])).toEqual(['receipt_must_be_an_object']);
    for (const key of ['tenantId', 'workspaceId', 'businessId', 'status', 'currency', 'unitCost']) expect(purchaseReceiptProblems(data({ [key]: 'x' })), key).toContain(`${key}_not_allowed`);
    const cases: [string, Record<string, unknown>, string][] = [
      ['po id', { purchaseOrderId: 7 }, 'purchaseOrderId_required'],
      ['po id format', { purchaseOrderId: 'ABC' }, 'purchaseOrderId_invalid'],
      ['upper-case uuid', { warehouseId: U().toUpperCase() }, 'warehouseId_invalid'],
      ['blank number', { receiptNumber: '' }, 'receiptNumber_required'],
      ['long number', { receiptNumber: 'x'.repeat(101) }, 'receiptNumber_invalid'],
      ['receivedAt local time', { receivedAt: '2026-10-01 09:30:00' }, 'receivedAt_invalid'],
      ['receivedAt no offset', { receivedAt: '2026-10-01T09:30:00' }, 'receivedAt_invalid'],
      ['receivedAt impossible', { receivedAt: '2026-13-45T25:61:61Z' }, 'receivedAt_invalid'],
      ['receivedAt missing', { receivedAt: undefined }, 'receivedAt_required'],
      ['notes blank', { notes: '  ' }, 'notes_invalid'],
      ['lines not array', { lines: {} }, 'lines_required'],
    ];
    for (const [name, over, reason] of cases) expect(purchaseReceiptProblems(data(over)), name).toContain(reason);
  });

  it('quantity and cost: positive, finite, at most 4 decimals, inside numeric(18,4); cost optional but paired with an exact currency; nothing is rounded', () => {
    expect(receiptAmountProblem(1)).toBeNull();
    expect(receiptAmountProblem(0.0001)).toBeNull();
    expect(receiptAmountProblem(99999999999999)).toBeNull();
    expect(receiptAmountProblem(0)).toBe('not_positive');
    expect(receiptAmountProblem(-0.5)).toBe('not_positive');
    expect(receiptAmountProblem(NaN)).toBe('not_finite');
    expect(receiptAmountProblem(-Infinity)).toBe('not_finite');
    expect(receiptAmountProblem('5')).toBe('not_finite');
    expect(receiptAmountProblem(null)).toBe('not_finite');
    expect(receiptAmountProblem(0.00001)).toBe('excess_scale');
    expect(receiptAmountProblem(1.23456)).toBe('excess_scale');
    expect(receiptAmountProblem(1e14)).toBe('out_of_range');
    const line = (over: Record<string, unknown>) => purchaseReceiptProblems(data({ lines: [{ inventoryItemId: U(), quantity: 1, ...over }] }));
    expect(line({})).toEqual([]);
    expect(line({ unitCost: 1, unitCostCurrency: 'USD' })).toEqual([]);
    expect(line({ unitCost: 0.0001, unitCostCurrency: 'JPY' })).toEqual([]);
    expect(line({ unitCost: 0, unitCostCurrency: 'USD' })).toContain('lines[0].unitCost_not_positive');
    expect(line({ unitCost: 0.00005, unitCostCurrency: 'USD' })).toContain('lines[0].unitCost_below_minimum_precision');
    expect(line({ unitCost: 2.00001, unitCostCurrency: 'USD' })).toContain('lines[0].unitCost_excess_scale');
    expect(line({ unitCost: 2 })).toContain('lines[0].unitCostCurrency_required_with_unitCost');
    expect(line({ unitCostCurrency: 'USD' })).toContain('lines[0].unitCost_required_with_unitCostCurrency');
    expect(line({ unitCost: 2, unitCostCurrency: 'Usd' })).toContain('lines[0].unitCostCurrency_invalid');
    expect(line({ unitCost: 2, unitCostCurrency: 'USDX' })).toContain('lines[0].unitCostCurrency_invalid');
    expect(line({ unitCost: null, unitCostCurrency: null })).toEqual([]); // explicit nulls mean "no cost"
  });

  it('canonical content is deterministic: exact decimal text, 1-based line numbers, UTC instant; key order never matters for equality', () => {
    const p = data({ receivedAt: '2026-10-01T11:30:00.250+02:00' }) as unknown as RecordPurchaseReceiptCommand['payload'];
    const c = canonicalReceiptContent(p);
    expect(c.receivedAt).toBe('2026-10-01T09:30:00.250Z');
    expect(c.lines.map((l) => [l.lineNumber, l.quantity, l.unitCost, l.unitCostCurrency])).toEqual([[1, '10', '2.5', 'USD'], [2, '4.25', null, null]]);
    expect(canonicalJson({ b: 1, a: { d: [2, { y: 1, x: 2 }], c: null } })).toBe(canonicalJson({ a: { c: null, d: [2, { x: 2, y: 1 }] }, b: 1 }));
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }));
  });
});
