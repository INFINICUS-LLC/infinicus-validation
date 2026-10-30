/**
 * BO-REF-UUID-01 (F9): the inventory-movement `referenceId` lands in a typed uuid column, so a malformed value must be refused at the Business Operations
 * command boundary - before any SQL - with one deterministic message that does not repeat the value.
 *
 * No database here: the format rule, the intake mapper's validation reason, and the executor (against a client that fails the test if it is ever queried).
 * The same behaviour against real PostgreSQL, end to end from the Data Acquisition Layer, is in MovementReferenceId.integration.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { IntakeMapperRegistry } from '../src/intake/IntakeMapperRegistry.js';
import { inventoryMovementMapper, registerDefaultMappers } from '../src/intake/defaultMappers.js';
import { OperationalCommandExecutor } from '../src/OperationalCommandExecutor.js';
import { OperationalMappingError } from '../src/errors.js';
import { canonicalUuidReference, referenceIdProblem } from '../src/uuidReference.js';
import type { OperationalCommand } from '../src/types.js';

const GOOD = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const UPPER = GOOD.toUpperCase();
const MIXED = '3F2504e0-4f89-41D3-9a0c-0305E82c3301';

/** Everything a caller could send that is not a canonical UUID. Several of these PostgreSQL rejects with a raw error, and a few it silently tolerates. */
const MALFORMED: [string, unknown][] = [
  ['free text', 'not-a-uuid'],
  ['a purchase-order style code', 'PO-2026-0042'],
  ['empty', ''],
  ['blank', '   '],
  ['leading space', ` ${GOOD}`],
  ['trailing space', `${GOOD} `],
  ['trailing newline', `${GOOD}\n`],
  ['trailing carriage return and newline', `${GOOD}\r\n`],
  ['braces (PostgreSQL tolerates)', `{${GOOD}}`],
  ['no hyphens (PostgreSQL tolerates)', GOOD.replaceAll('-', '')],
  ['regrouped hyphens (PostgreSQL tolerates)', '3f25-04e0-4f89-41d3-9a0c-0305-e82c-3301'],
  ['urn prefix', `urn:uuid:${GOOD}`],
  ['one digit short', GOOD.slice(0, 35)],
  ['one digit long', `${GOOD}0`],
  ['a non-hexadecimal digit', GOOD.replace('3f25', '3g25')],
  ['a full-width digit lookalike', GOOD.replace('3f25', '３f25')],
  ['wrong hyphen position', '3f2504e04-f89-41d3-9a0c-0305e82c3301'],
  ['an injection attempt', `${GOOD}'; DROP TABLE business_operations.inventory_movements; --`],
  ['a number', 12345],
  ['an object', { id: GOOD }],
  ['an array', [GOOD]],
  ['a boolean', true],
];

describe('canonicalUuidReference', () => {
  it.each([['lower case', GOOD], ['upper case', UPPER], ['mixed case', MIXED]])('accepts a canonical UUID in %s and returns it lower-case', (_n, value) => {
    expect(canonicalUuidReference(value)).toBe(GOOD);
  });

  it('does not enforce version or variant bits (PostgreSQL does not either)', () => {
    expect(canonicalUuidReference('00000000-0000-0000-0000-000000000000')).toBe('00000000-0000-0000-0000-000000000000');
    expect(canonicalUuidReference('ffffffff-ffff-ffff-ffff-ffffffffffff')).toBe('ffffffff-ffff-ffff-ffff-ffffffffffff');
  });

  it.each(MALFORMED)('rejects %s', (_name, value) => {
    expect(canonicalUuidReference(value)).toBeNull();
  });

  it('rejects null and undefined as values (absence is decided by the caller)', () => {
    expect(canonicalUuidReference(null)).toBeNull();
    expect(canonicalUuidReference(undefined)).toBeNull();
  });

  it('names the field and the rule in its message and never a value', () => {
    expect(referenceIdProblem()).toBe('referenceId must be a canonical UUID (8-4-4-4-12 hexadecimal characters).');
  });
});

describe('inventory_movement intake mapper: referenceId validation', () => {
  const movement = (over: Record<string, unknown>) => ({ inventoryItemId: 'item-1', warehouseId: 'warehouse-1', movementType: 'receipt', quantity: 1, ...over });
  const keyed = (over: Record<string, unknown>) => ({ sku: 'SKU-1', warehouseCode: 'WH-1', movementType: 'receipt', quantity: 1, ...over });

  it.each([['lower case', GOOD], ['upper case', UPPER], ['mixed case', MIXED]])('accepts a %s UUID, plain and keyed', (_n, referenceId) => {
    expect(inventoryMovementMapper.validate(movement({ referenceType: 'manual', referenceId }))).toEqual([]);
    expect(inventoryMovementMapper.validate(keyed({ referenceType: 'manual', referenceId }))).toEqual([]);
  });

  it('accepts an absent or null referenceId (the column is nullable), plain and keyed', () => {
    for (const over of [{}, { referenceId: undefined }, { referenceId: null }]) {
      expect(inventoryMovementMapper.validate(movement(over))).toEqual([]);
      expect(inventoryMovementMapper.validate(keyed(over))).toEqual([]);
    }
  });

  it.each(MALFORMED)('reports exactly one deterministic reason for %s, plain and keyed', (_name, referenceId) => {
    expect(inventoryMovementMapper.validate(movement({ referenceId }))).toEqual(['referenceId_invalid']);
    expect(inventoryMovementMapper.validate(keyed({ referenceId }))).toEqual(['referenceId_invalid']);
  });

  it('keeps every other reason and adds this one; a bad reference does not hide a bad quantity', () => {
    expect(inventoryMovementMapper.validate(movement({ referenceId: 'nope', quantity: 0 }))).toEqual(['quantity_must_not_be_zero', 'referenceId_invalid']);
  });

  it('through the registry, rejects the record before any command is built, with a message that does not repeat the value', () => {
    const registry = registerDefaultMappers(new IntakeMapperRegistry());
    const context = { tenantId: 't', workspaceId: 'w', businessId: 'b', correlationId: 'c', sourceReference: 's#0', provenanceReference: 'p', idempotencyKey: 'i', actorId: 'a', occurredAt: '2026-10-03T00:00:00.000Z', recordIndex: 0 };
    const bad = 'PO-2026-0042';
    let error: unknown;
    try { registry.mapRecord({ recordType: 'inventory_movement', data: movement({ referenceId: bad }) }, context); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(OperationalMappingError);
    expect((error as Error).message).toBe('Invalid inventory_movement record: referenceId_invalid');
    expect((error as Error).message).not.toContain(bad);
    // a valid record still maps to the same command shape as before (the mapper passes the value through; the executor normalises it)
    const [mapped] = registry.mapRecord({ recordType: 'inventory_movement', data: movement({ referenceId: UPPER }) }, context);
    expect(mapped).toMatchObject({ type: 'record_inventory_movement', payload: { referenceId: UPPER } });
  });
});

describe('OperationalCommandExecutor: a malformed referenceId never reaches SQL', () => {
  const scope = { tenantId: '11111111-1111-4111-8111-111111111111', workspaceId: '22222222-2222-4222-8222-222222222222', businessId: '33333333-3333-4333-8333-333333333333' };
  const ctx = { tenantId: scope.tenantId, workspaceId: scope.workspaceId, userId: '44444444-4444-4444-8444-444444444444' };
  const context = { ...scope, correlationId: '55555555-5555-4555-8555-555555555555', sourceReference: 's#0', provenanceReference: '66666666-6666-4666-8666-666666666666', idempotencyKey: 'i', actorId: 'a', occurredAt: '2026-10-03T00:00:00.000Z' };
  const plain = (referenceId: unknown): OperationalCommand => ({ type: 'record_inventory_movement', context, payload: { inventoryItemId: '77777777-7777-4777-8777-777777777777', warehouseId: '88888888-8888-4888-8888-888888888888', movementType: 'receipt', quantity: 1, referenceType: 'manual', referenceId } } as unknown as OperationalCommand);
  const keyed = (referenceId: unknown): OperationalCommand => ({ type: 'record_keyed_inventory_movement', context, payload: { inventoryItemSku: 'SKU-1', warehouseCode: 'WH-1', movementType: 'receipt', quantity: 1, referenceType: 'manual', referenceId } } as unknown as OperationalCommand);
  const noSqlClient = () => { const query = vi.fn(async () => { throw new Error('SQL must not be executed for a rejected command'); }); return { client: { query } as unknown as PoolClient, query }; };
  const executor = new OperationalCommandExecutor();

  it.each(MALFORMED.filter(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'object' || typeof v === 'boolean'))(
    'refuses %s (plain and keyed) with the one deterministic message, before the first query',
    async (_name, referenceId) => {
      for (const command of [plain(referenceId), keyed(referenceId)]) {
        const { client, query } = noSqlClient();
        let error: unknown;
        try { await executor.executeOn(client, ctx, command); } catch (e) { error = e; }
        expect(error).toBeInstanceOf(OperationalMappingError);
        expect((error as Error).message).toBe(referenceIdProblem());
        if (typeof referenceId === 'string' && referenceId.trim().length > 0) expect((error as Error).message).not.toContain(referenceId.trim());
        expect(query).not.toHaveBeenCalled();
      }
    }
  );

  it('the refusal is a mapping error, not a database error: it has no SQLSTATE and no database wording', async () => {
    const { client } = noSqlClient();
    const error = (await executor.executeOn(client, ctx, plain('not-a-uuid')).catch((e: unknown) => e)) as Error & { code?: string };
    expect(error.code).toBeUndefined();
    expect(error.message).not.toMatch(/invalid input syntax|uuid:|22P02/i);
  });
});
