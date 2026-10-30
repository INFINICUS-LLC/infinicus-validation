/**
 * BO-ID-UUID-02: the uuid-typed identifiers of Business Operations commands are canonical UUIDs before any SQL.
 *
 * No database: the real OperationalCommandExecutor runs against a client that records every query and answers each with a sentinel failure. So
 *   - a REFUSED command is proven by its exact message AND by `query` never having been called;
 *   - an ACCEPTED identifier is proven by the executor getting past the check and issuing its first query (the sentinel then ends the run).
 * The same behaviour against real PostgreSQL, end to end from the Data Acquisition Layer, is in CommandIdentifiers.integration.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { OperationalCommandExecutor } from '../src/OperationalCommandExecutor.js';
import { OperationalMappingError } from '../src/errors.js';
import { contextIdentifierFields, firstIdentifierProblem, idOptional, idRequired } from '../src/commandIdentifiers.js';
import { uuidFieldProblem } from '../src/uuidReference.js';
import type { ConfigureInventoryReorderPolicyCommand, OperationalCommand } from '../src/types.js';

const SENTINEL = 'FIRST QUERY REACHED';
const GOOD = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const ID = { item: '11111111-aaaa-4aaa-8aaa-111111111111', warehouse: '22222222-bbbb-4bbb-8bbb-222222222222', supplier: '33333333-cccc-4ccc-8ccc-333333333333', asset: '44444444-dddd-4ddd-8ddd-444444444444' };
const scope = { tenantId: '11111111-1111-4111-8111-111111111111', workspaceId: '22222222-2222-4222-8222-222222222222', businessId: '33333333-3333-4333-8333-333333333333' };
const ctx = { ...scope, userId: '44444444-4444-4444-8444-444444444444' };
const baseContext = { ...scope, correlationId: '55555555-5555-4555-8555-555555555555', sourceReference: 's#0', provenanceReference: '66666666-6666-4666-8666-666666666666', idempotencyKey: 'i', actorId: 'a', occurredAt: '2026-10-03T00:00:00.000Z' };

const MALFORMED: [string, unknown][] = [
  ['free text', 'not-a-uuid'], ['a business code', 'SUP-0042'], ['empty', ''], ['blank', '   '], ['leading space', ` ${GOOD}`], ['trailing newline', `${GOOD}\n`],
  ['braces', `{${GOOD}}`], ['no hyphens', GOOD.replaceAll('-', '')], ['regrouped hyphens', '3f25-04e0-4f89-41d3-9a0c-0305-e82c-3301'], ['urn prefix', `urn:uuid:${GOOD}`],
  ['one digit short', GOOD.slice(0, 35)], ['one digit long', `${GOOD}0`], ['a non-hex digit', GOOD.replace('3f25', '3g25')], ['a full-width digit', GOOD.replace('3f25', '３f25')],
  ['an injection attempt', `${GOOD}'; DROP TABLE platform.suppliers; --`], ['a SQL comment payload', "' OR '1'='1"], ['a number', 12345], ['an object', { id: GOOD }], ['an array', [GOOD]], ['a boolean', true],
];
const VALID: [string, string][] = [['lower case', GOOD], ['upper case', GOOD.toUpperCase()], ['mixed case', '3F2504e0-4f89-41D3-9a0c-0305E82c3301']];

function recordingClient() {
  const query = vi.fn(async (..._args: unknown[]) => { throw new Error(SENTINEL); });
  return { client: { query } as unknown as PoolClient, query };
}
const executor = new OperationalCommandExecutor();
const run = (command: OperationalCommand) => { const c = recordingClient(); return { ...c, result: executor.executeOn(c.client, ctx, command) }; };
const refusal = async (promise: Promise<unknown>): Promise<Error & { code?: string }> => (await promise.catch((e: unknown) => e)) as Error & { code?: string };

interface Spec { name: string; fields: string[]; build: (payload: Record<string, unknown>, context?: Record<string, unknown>) => OperationalCommand | ConfigureInventoryReorderPolicyCommand; configure?: boolean }
const specs: Spec[] = [
  { name: 'record_inventory_movement', fields: ['inventoryItemId', 'warehouseId'], build: (p, c) => ({ type: 'record_inventory_movement', context: { ...baseContext, ...c }, payload: { inventoryItemId: ID.item, warehouseId: ID.warehouse, movementType: 'receipt', quantity: 1, ...p } }) as unknown as OperationalCommand },
  { name: 'record_keyed_inventory_movement', fields: ['inventoryItemId', 'warehouseId'], build: (p, c) => {
      // the handler needs exactly one of id / natural key per side, so giving an id takes the natural key away
      const payload: Record<string, unknown> = { inventoryItemSku: 'SKU-1', warehouseCode: 'WH-1', movementType: 'receipt', quantity: 1, ...p };
      if ('inventoryItemId' in p) delete payload.inventoryItemSku;
      if ('warehouseId' in p) delete payload.warehouseCode;
      return { type: 'record_keyed_inventory_movement', context: { ...baseContext, ...c }, payload } as unknown as OperationalCommand;
    } },
  { name: 'create_purchase_order', fields: ['supplierId'], build: (p, c) => ({ type: 'create_purchase_order', context: { ...baseContext, ...c }, payload: { supplierId: ID.supplier, poNumber: 'PO-1', currencyCode: 'USD', ...p } }) as unknown as OperationalCommand },
  { name: 'record_supplier_performance', fields: ['supplierId'], build: (p, c) => ({ type: 'record_supplier_performance', context: { ...baseContext, ...c }, payload: { supplierId: ID.supplier, periodStart: '2026-01-01', periodEnd: '2026-01-31', qualityScore: 1, deliveryScore: 1, priceScore: 1, serviceScore: 1, overallScore: 1, ...p } }) as unknown as OperationalCommand },
  { name: 'record_asset_inspection', fields: ['assetId'], build: (p, c) => ({ type: 'record_asset_inspection', context: { ...baseContext, ...c }, payload: { assetId: ID.asset, conditionRating: 'good', pass: true, ...p } }) as unknown as OperationalCommand },
  { name: 'configureInventoryReorderPolicy', configure: true, fields: ['inventoryItemId', 'warehouseId'], build: (p, c) => ({ type: 'configure_inventory_reorder_policy', context: { ...baseContext, ...c }, payload: { inventoryItemId: ID.item, warehouseId: ID.warehouse, reorderPoint: 1, reorderQuantity: 1, ...p } }) as unknown as ConfigureInventoryReorderPolicyCommand },
];
const execute = (spec: Spec, command: OperationalCommand | ConfigureInventoryReorderPolicyCommand) => {
  const c = recordingClient();
  const result = spec.configure ? executor.configureInventoryReorderPolicy(c.client, ctx, command as ConfigureInventoryReorderPolicyCommand) : executor.executeOn(c.client, ctx, command as OperationalCommand);
  return { ...c, result };
};

describe('firstIdentifierProblem', () => {
  it('returns null when every field is a canonical UUID, in any case', () => {
    expect(firstIdentifierProblem([idRequired('a', GOOD), idOptional('b', GOOD.toUpperCase())])).toBeNull();
  });
  it('reports the FIRST bad field, in the given order, naming the field and never the value', () => {
    expect(firstIdentifierProblem([idRequired('first', 'bad-1'), idRequired('second', 'bad-2')])).toBe(uuidFieldProblem('first'));
    expect(firstIdentifierProblem([idRequired('first', GOOD), idRequired('second', 'bad-2')])).toBe('second must be a canonical UUID (8-4-4-4-12 hexadecimal characters).');
  });
  it('treats an absent optional field as acceptable and an absent required field as a problem', () => {
    for (const absent of [undefined, null]) {
      expect(firstIdentifierProblem([idOptional('opt', absent)])).toBeNull();
      expect(firstIdentifierProblem([idRequired('req', absent)])).toBe(uuidFieldProblem('req'));
    }
  });
  it('an optional field that is present but malformed is still a problem (an empty string is present)', () => {
    expect(firstIdentifierProblem([idOptional('opt', '')])).toBe(uuidFieldProblem('opt'));
  });
  it('the context contributes businessId, correlationId (required) and causationId (optional)', () => {
    expect(contextIdentifierFields({ ...baseContext }).map((f) => [f.name, f.optional])).toEqual([['businessId', false], ['correlationId', false], ['causationId', true]]);
  });
});

for (const spec of specs) {
  describe(`${spec.name}: identifiers are canonical UUIDs before any SQL`, () => {
    for (const field of spec.fields) {
      it.each(MALFORMED)(`refuses ${field} = %s with the one deterministic message, before the first query`, async (_name, value) => {
        const { query, result } = execute(spec, spec.build({ [field]: value }));
        const error = await refusal(result);
        expect(error).toBeInstanceOf(OperationalMappingError);
        expect(error.message).toBe(uuidFieldProblem(field));
        expect(error.code).toBeUndefined(); // a mapping error, not a database error
        expect(error.message).not.toMatch(/invalid input syntax|22P02/i);
        if (typeof value === 'string' && value.trim().length > 0) expect(error.message).not.toContain(value.trim());
        expect(query).not.toHaveBeenCalled();
      });

      it.each(VALID)(`accepts ${field} in %s and gets as far as the first query`, async (_name, value) => {
        const { query, result } = execute(spec, spec.build({ [field]: value }));
        const error = await refusal(result);
        expect(error.message).toBe(SENTINEL);
        expect(query).toHaveBeenCalled();
      });
    }

    for (const field of ['businessId', 'correlationId', 'causationId']) {
      it.each(MALFORMED.slice(0, 8))(`refuses context ${field} = %s before the first query`, async (_name, value) => {
        const { query, result } = execute(spec, spec.build({}, { [field]: value }));
        const error = await refusal(result);
        expect(error).toBeInstanceOf(OperationalMappingError);
        expect(error.message).toBe(uuidFieldProblem(field));
        expect(query).not.toHaveBeenCalled();
      });
    }

    it('an absent causationId is fine, a present valid one is fine', async () => {
      for (const context of [{ causationId: undefined }, { causationId: null }, { causationId: GOOD }]) {
        const { query, result } = execute(spec, spec.build({}, context));
        expect((await refusal(result)).message).toBe(SENTINEL);
        expect(query).toHaveBeenCalled();
      }
    });

    it('with two bad identifiers the first in the fixed order is reported (context before payload)', async () => {
      const { query, result } = execute(spec, spec.build({ [spec.fields[0]]: 'bad' }, { businessId: 'also-bad' }));
      expect((await refusal(result)).message).toBe(uuidFieldProblem('businessId'));
      expect(query).not.toHaveBeenCalled();
    });

    it('a malformed identifier does not hide a tenant-scope mismatch: that check still comes first and is unchanged', async () => {
      if (spec.configure) return; // the configuration method has the same scope check; covered by its own existing tests
      const wrongScope = spec.build({ [spec.fields[0]]: 'bad' }, { tenantId: '99999999-9999-4999-8999-999999999999' });
      const error = await refusal(execute(spec, wrongScope).result);
      expect(error.message).toBe('Command tenant/workspace scope does not match active context.');
    });
  });
}

describe('keyed movement: an id is optional, the natural key stands in for it', () => {
  const keyed = specs[1];
  it('without any id, with sku and code, the check passes and the handler runs its first query', async () => {
    const { query, result } = execute(keyed, keyed.build({}));
    expect((await refusal(result)).message).toBe(SENTINEL);
    expect(query).toHaveBeenCalled();
  });
  it('a null id passes this check as absent; the handler then behaves exactly as before (it treats the key as given and goes to its first query)', async () => {
    const { query, result } = execute(keyed, keyed.build({ inventoryItemId: null, warehouseId: null }, {}));
    expect((await refusal(result)).message).toBe(SENTINEL);
    expect(query).toHaveBeenCalled();
  });
});

describe('identifiers stored in text columns are NOT validated as UUIDs', () => {
  const workforce = (memberId: unknown): OperationalCommand => ({ type: 'record_workforce_event', context: baseContext, payload: { memberId, action: 'hire', hours: 8 } }) as unknown as OperationalCommand;
  const fact = (over: Record<string, unknown>): OperationalCommand => ({ type: 'record_operational_fact', context: baseContext, payload: { eventType: 'sale', amount: 10, ...over } }) as unknown as OperationalCommand;
  it.each(['EMP-42', 'not-a-uuid', 'ünïcödé-1', '12345'])('workforce memberId %j reaches SQL untouched', async (memberId) => {
    const { query, result } = run(workforce(memberId));
    expect((await refusal(result)).message).toBe(SENTINEL);
    expect(query).toHaveBeenCalled();
  });
  it.each(['CUST-7', 'not-a-uuid'])('operational-fact customerId %j and memberId reach SQL untouched', async (id) => {
    const { query, result } = run(fact({ customerId: id, memberId: id }));
    expect((await refusal(result)).message).toBe(SENTINEL);
    expect(query).toHaveBeenCalled();
  });
  it('their commands still check the context identifiers', async () => {
    const { query, result } = run({ ...workforce('EMP-42'), context: { ...baseContext, correlationId: 'bad' } } as OperationalCommand);
    expect((await refusal(result)).message).toBe(uuidFieldProblem('correlationId'));
    expect(query).not.toHaveBeenCalled();
  });
});

describe('record_purchase_receipt keeps its own established, stricter contract', () => {
  const receipt = (payload: Record<string, unknown>, context: Record<string, unknown> = {}): OperationalCommand => ({
    type: 'record_purchase_receipt', context: { ...baseContext, ...context },
    payload: { purchaseOrderId: GOOD, warehouseId: ID.warehouse, receiptNumber: 'GRN-1', receivedAt: '2026-10-01T09:30:00.250Z', lines: [{ inventoryItemId: ID.item, quantity: 1 }], ...payload },
  }) as unknown as OperationalCommand;
  it('payload identifiers are not preempted: the receipt validator reports its own reason codes, before any SQL', async () => {
    for (const [payload, code] of [[{ purchaseOrderId: 'x' }, 'purchaseOrderId_invalid'], [{ warehouseId: 'x' }, 'warehouseId_invalid'], [{ lines: [{ inventoryItemId: 'not-a-uuid', quantity: 1 }] }, 'inventoryItemId_invalid']] as const) {
      const { query, result } = run(receipt(payload as Record<string, unknown>));
      const error = await refusal(result);
      expect(error.message).toMatch(/^Invalid purchase receipt: /);
      expect(error.message).toContain(code);
      expect(query).not.toHaveBeenCalled();
    }
  });
  it('its context identifiers are checked like every other command', async () => {
    const { query, result } = run(receipt({}, { businessId: 'bad' }));
    expect((await refusal(result)).message).toBe(uuidFieldProblem('businessId'));
    expect(query).not.toHaveBeenCalled();
  });
});
