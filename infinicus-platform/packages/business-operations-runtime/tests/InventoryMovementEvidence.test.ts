/**
 * BO-PUB-DEV-01: pure inventory movement publication evidence (PROPOSED contract, not active). The rows here are TEST DATA written for the tests; they are not
 * business records and no production path uses them.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- tests mutate arbitrary artifact shapes */
import { describe, expect, it } from 'vitest';
import {
  INVENTORY_MOVEMENT_EVIDENCE as C, buildInventoryMovementEvidence, verifyInventoryMovementEvidence, serializeInventoryMovement, canonicalDecimal, computeEvidenceDigest, deriveEvidenceId,
  type RawInventoryMovementRow, type InventoryMovementEvidence, type EvidenceFailureCode,
} from '../src/index.js';

const T = '11111111-1111-4111-8111-111111111111'; const W = '22222222-2222-4222-8222-222222222222'; const B = '33333333-3333-4333-8333-333333333333';
const scope = { tenantId: T, workspaceId: W, businessId: B };
const period = { periodStart: '2026-01-01T00:00:00.000Z', periodEnd: '2026-02-01T00:00:00.000Z' };
const CORR = '99999999-9999-4999-8999-999999999999';
const id = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
const row = (n: number, over: Partial<RawInventoryMovementRow> = {}): RawInventoryMovementRow => ({
  id: id(n), tenant_id: T, workspace_id: W, business_id: B, inventory_item_id: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001', warehouse_id: 'cccccccc-cccc-4ccc-8ccc-000000000001',
  movement_type: 'receipt', quantity: '10.5000', reference_type: 'manual', reference_id: 'dddddddd-dddd-4ddd-8ddd-000000000001', unit_cost: '2.2500', unit_cost_currency: 'USD',
  occurred_at: `2026-01-${String(10 + n).padStart(2, '0')}T08:30:00.123456Z`, correlation_id: 'eeeeeeee-eeee-4eee-8eee-000000000001', ...over,
});
const rows = (n: number) => Array.from({ length: n }, (_, i) => row(i + 1));
const build = (rs: readonly RawInventoryMovementRow[] = rows(3), over: { boPublicationPackageId?: string | null; correlationId?: string } = {}) =>
  buildInventoryMovementEvidence({ scope, period, boPublicationPackageId: over.boPublicationPackageId ?? null, correlationId: over.correlationId ?? CORR, rows: rs });
const ok = (rs?: readonly RawInventoryMovementRow[]) => { const r = build(rs); if (!r.ok) throw new Error(JSON.stringify(r)); return r.value; };
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const code = (r: { ok: boolean } & Partial<{ code: EvidenceFailureCode }>) => (r.ok ? 'OK' : r.code);
/** Re-seals a tampered artifact so the digest is valid again: isolates the schema rule under test from the digest check. */
const reseal = (a: InventoryMovementEvidence): InventoryMovementEvidence => { const d = computeEvidenceDigest(a); return { ...a, digest: { ...a.digest, value: d }, evidenceId: deriveEvidenceId(d) }; };
const issues = (r: ReturnType<typeof verifyInventoryMovementEvidence>) => (r.ok ? [] : r.issues.map((x) => `${x.code}:${x.recordIndex}:${x.field}`));

describe('contract identity: a PROPOSED contract, clearly marked and not active', () => {
  it('names itself proposed, with a version and a record schema version that are not presented as approved', () => {
    expect(C).toMatchObject({ status: 'PROPOSED_NOT_ACTIVE', contractVersion: '0.1.0-proposed', recordSchemaVersion: 'bo.inventory_movement.record.v0.1-proposed', maxRecords: 100_000 });
    const a = ok();
    expect(a.contract).toEqual({ name: C.contract, version: '0.1.0-proposed', status: 'PROPOSED_NOT_ACTIVE' });
  });
});

describe('serialization and canonical identity', () => {
  it('maps a ledger row exactly: ids unchanged, decimals canonical text (never a number), timestamps at microsecond precision', () => {
    const rec = serializeInventoryMovement(row(1))!;
    expect(rec).toEqual({ tenantId: T, workspaceId: W, businessId: B, movementId: id(1), inventoryItemId: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001', warehouseId: 'cccccccc-cccc-4ccc-8ccc-000000000001',
      movementType: 'receipt', quantity: '10.5', referenceType: 'manual', referenceId: 'dddddddd-dddd-4ddd-8ddd-000000000001', unitCost: '2.25', unitCostCurrency: 'USD',
      occurredAt: '2026-01-11T08:30:00.123456Z', correlationId: 'eeeeeeee-eeee-4eee-8eee-000000000001' });
    expect(Object.values(rec).some((v) => typeof v === 'number')).toBe(false);
  });
  it.each([['12.5000', '12.5'], ['0.0000', '0'], ['-0.0000', '0'], ['-3.2000', '-3.2'], ['100', '100'], ['007.5000', '7.5'], ['0.0001', '0.0001'], ['99999999999999.9999', '99999999999999.9999']])('canonical decimal %s -> %s', (i, o) => expect(canonicalDecimal(i)).toBe(o));
  it.each(['', '1e3', '+1', '1.', '.5', '1.23456', 'abc', '1,5', ' 1', '1 ', '123456789012345', '1.2.3', 5 as unknown as string])('refuses %j as numeric(18,4) text', (i) => expect(canonicalDecimal(i)).toBeNull());
  it('does not modify its inputs', () => { const rs = rows(3); const before = JSON.stringify(rs); build(rs); expect(JSON.stringify(rs)).toBe(before); });
  it('a quantity that is not numeric(18,4) text is refused, not coerced', () => {
    const r = build([row(1, { quantity: '1e3' })]);
    expect(r).toMatchObject({ ok: false, code: 'RECORDS_REJECTED' });
  });
});

describe('deterministic ordering, digest and replay', () => {
  it('orders by occurredAt then movementId whatever the order the rows arrive in', () => {
    const rs = [row(3), row(1, { occurred_at: '2026-01-12T00:00:00.000001Z' }), row(2, { occurred_at: '2026-01-12T00:00:00.000001Z' })];
    const a = ok(rs); const b = ok([...rs].reverse()); const c = ok([rs[1]!, rs[2]!, rs[0]!]);
    expect(a.records.map((r) => r.movementId)).toEqual([id(1), id(2), id(3)]);
    expect(b).toEqual(a); expect(c).toEqual(a);
    expect(a.ordering).toBe('occurredAt asc, movementId asc');
  });
  it('replays byte-identically: same ledger, same artifact, same digest and evidence id - whatever the request correlation id', () => {
    const a = build(rows(4), { correlationId: CORR }); const b = build(rows(4), { correlationId: '88888888-8888-4888-8888-888888888888' });
    expect(a.ok && b.ok).toBe(true); if (!a.ok || !b.ok) return;
    expect(b.value.digest).toEqual(a.value.digest); expect(b.value.evidenceId).toBe(a.value.evidenceId);
    expect(b.value.provenance.correlationId).not.toBe(a.value.provenance.correlationId);
    expect(JSON.stringify(a.value.records)).toBe(JSON.stringify(b.value.records));
    expect(a.value.digest).toMatchObject({ algorithm: 'sha256', canonicalization: 'bo-canonical-json-v1' }); expect(a.value.digest.value).toMatch(/^[0-9a-f]{64}$/);
  });
  it('any change of a value, a record, the scope, the period or the package changes the digest', () => {
    const base = ok().digest.value;
    const changedValue = ok([row(1), row(2), row(3, { quantity: '10.5001' })]).digest.value;
    const fewer = ok(rows(2)).digest.value;
    const other = buildInventoryMovementEvidence({ scope: { ...scope, businessId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }, period, boPublicationPackageId: null, correlationId: CORR, rows: rows(3).map((r) => ({ ...r, business_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' })) });
    const widened = buildInventoryMovementEvidence({ scope, period: { ...period, periodEnd: '2026-03-01T00:00:00.000Z' }, boPublicationPackageId: null, correlationId: CORR, rows: rows(3) });
    const withPackage = build(rows(3), { boPublicationPackageId: 'abababab-abab-4bab-8bab-abababababab' });
    for (const r of [other, widened, withPackage]) { expect(r.ok).toBe(true); if (r.ok) expect(r.value.digest.value).not.toBe(base); }
    expect(new Set([base, changedValue, fewer]).size).toBe(3);
  });
  it('an empty period is a valid, verified, empty artifact (count 0), not an error', () => {
    const a = ok([]); expect(a.recordCount).toBe(0); expect(a.records).toEqual([]);
    expect(verifyInventoryMovementEvidence(a).ok).toBe(true);
  });
  it('the evidence id names the digest and nothing else', () => { const a = ok(); expect(a.evidenceId).toBe(deriveEvidenceId(a.digest.value)); expect(a.evidenceId).not.toBe(a.digest.value); });
});

describe('verification: the contract, schema version and structure', () => {
  it('accepts what the producer builds, including after a JSON round trip', () => {
    const a = ok(); expect(verifyInventoryMovementEvidence(a).ok).toBe(true); expect(verifyInventoryMovementEvidence(JSON.parse(JSON.stringify(a))).ok).toBe(true);
  });
  it.each([
    ['not an object', null, 'ARTIFACT_INVALID'], ['an array', [], 'ARTIFACT_INVALID'], ['a string', 'x', 'ARTIFACT_INVALID'],
  ])('refuses %s', (_l, v, c) => expect(code(verifyInventoryMovementEvidence(v))).toBe(c));
  it.each([
    ['an unknown contract name', (a: Record<string, any>) => { a.contract.name = 'bo.sales.record_evidence'; }, 'CONTRACT_UNSUPPORTED'],
    ['an unsupported contract version', (a: Record<string, any>) => { a.contract.version = '1.0.0'; }, 'CONTRACT_UNSUPPORTED'],
    ['an ACTIVE status the contract does not have', (a: Record<string, any>) => { a.contract.status = 'ACTIVE'; }, 'CONTRACT_UNSUPPORTED'],
    ['an unsupported record schema version', (a: Record<string, any>) => { a.recordSchemaVersion = 'bo.inventory_movement.record.v9'; }, 'SCHEMA_VERSION_UNSUPPORTED'],
    ['an unknown top-level property', (a: Record<string, any>) => { a.extra = 1; }, 'ARTIFACT_INVALID'],
    ['a missing top-level property', (a: Record<string, any>) => { delete a.provenance; }, 'ARTIFACT_INVALID'],
    ['an invalid scope id', (a: Record<string, any>) => { a.scope.tenantId = 'T'; }, 'SCOPE_INVALID'],
    ['an upper-case (non-canonical) scope id', (a: Record<string, any>) => { a.scope.businessId = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'; }, 'SCOPE_INVALID'],
    ['an extra scope property', (a: Record<string, any>) => { a.scope.region = 'x'; }, 'SCOPE_INVALID'],
    ['a period that is not millisecond UTC', (a: Record<string, any>) => { a.source.periodStart = '2026-01-01'; }, 'PERIOD_INVALID'],
    ['an inverted period', (a: Record<string, any>) => { a.source.periodStart = a.source.periodEnd; }, 'PERIOD_INVALID'],
    ['another domain', (a: Record<string, any>) => { a.source.domain = 'sales'; }, 'PERIOD_INVALID'],
    ['a malformed package id', (a: Record<string, any>) => { a.source.boPublicationPackageId = 'x'; }, 'PERIOD_INVALID'],
    ['another ordering', (a: Record<string, any>) => { a.ordering = 'id desc'; }, 'ARTIFACT_INVALID'],
    ['another digest algorithm', (a: Record<string, any>) => { a.digest.algorithm = 'md5'; }, 'ARTIFACT_INVALID'],
    ['a malformed digest', (a: Record<string, any>) => { a.digest.value = 'abc'; }, 'ARTIFACT_INVALID'],
    ['records that are not an array', (a: Record<string, any>) => { a.records = {}; }, 'ARTIFACT_INVALID'],
    ['a record count that disagrees with the records', (a: Record<string, any>) => { a.recordCount = 2; }, 'RECORD_COUNT_MISMATCH'],
    ['a record count that is not an integer', (a: Record<string, any>) => { a.recordCount = '3'; }, 'ARTIFACT_INVALID'],
  ])('refuses %s', (_l, mutate, expected) => { const a = clone(ok()) as Record<string, any>; mutate(a); expect(code(verifyInventoryMovementEvidence(a))).toBe(expected); });
  it('refuses more records than the BI-10 engine can read, whole', () => {
    const a = clone(ok()); a.records = new Array(C.maxRecords + 1).fill(a.records[0]); a.recordCount = a.records.length;
    expect(code(verifyInventoryMovementEvidence(a))).toBe('TOO_MANY_RECORDS');
  });
});

describe('verification: integrity (the digest and the evidence id)', () => {
  it.each(['quantity', 'movementType', 'occurredAt', 'movementId', 'unitCost'] as const)('a changed %s without a re-computed digest is DIGEST_MISMATCH', (field) => {
    const a = clone(ok()); const r = a.records[1] as unknown as Record<string, unknown>;
    r[field] = field === 'quantity' ? '999' : field === 'movementType' ? 'issue' : field === 'occurredAt' ? '2026-01-30T00:00:00.000000Z' : field === 'unitCost' ? '9' : id(77);
    // a changed id or time could also break ordering; whichever rule fires first, it must not be accepted
    expect(verifyInventoryMovementEvidence(a).ok).toBe(false);
  });
  it('a dropped, added or reordered record is refused', () => {
    const a = clone(ok()); a.records.pop(); expect(code(verifyInventoryMovementEvidence(a))).toBe('RECORD_COUNT_MISMATCH');
    const b = clone(ok()); b.recordCount = 2; b.records.pop(); expect(code(verifyInventoryMovementEvidence(b))).toBe('DIGEST_MISMATCH');
    const c = clone(ok()); c.records.reverse(); expect(code(verifyInventoryMovementEvidence(c))).toBe('RECORDS_REJECTED');
  });
  it('a swapped digest or evidence id is refused; provenance is the only part not covered by the digest', () => {
    const a = clone(ok()); a.digest.value = '0'.repeat(64); expect(code(verifyInventoryMovementEvidence(a))).toBe('DIGEST_MISMATCH');
    const b = clone(ok()); b.evidenceId = '1'.repeat(64); expect(code(verifyInventoryMovementEvidence(b))).toBe('EVIDENCE_ID_MISMATCH');
    const c = clone(ok()); c.provenance.correlationId = '77777777-7777-4777-8777-777777777777'; expect(verifyInventoryMovementEvidence(c).ok).toBe(true);
  });
  it('checks the caller\'s expectations: scope, period, count, digest', () => {
    const a = ok();
    expect(verifyInventoryMovementEvidence(a, { scope, ...period, recordCount: 3, digest: a.digest.value }).ok).toBe(true);
    for (const x of [{ scope: { ...scope, businessId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' } }, { periodStart: '2026-01-02T00:00:00.000Z' }, { periodEnd: '2026-03-01T00:00:00.000Z' }, { recordCount: 4 }, { digest: '2'.repeat(64) }]) {
      expect(code(verifyInventoryMovementEvidence(a, x))).toBe('EXPECTATION_MISMATCH');
    }
  });
});

describe('verification: records (schema, scope, sensitivity) - one bad record refuses the whole artifact', () => {
  it.each([
    ['a record of another business', (r: any) => { r.businessId = 'ffffffff-ffff-4fff-8fff-ffffffffffff'; }, 'RECORD_FOREIGN_SCOPE:0:null'],
    ['a record of another tenant', (r: any) => { r.tenantId = 'ffffffff-ffff-4fff-8fff-ffffffffffff'; }, 'RECORD_FOREIGN_SCOPE:0:null'],
    ['a record of another workspace', (r: any) => { r.workspaceId = 'ffffffff-ffff-4fff-8fff-ffffffffffff'; }, 'RECORD_FOREIGN_SCOPE:0:null'],
    ['a record before the period', (r: any) => { r.occurredAt = '2025-12-31T23:59:59.999999Z'; }, 'RECORD_OUT_OF_PERIOD:0:occurredAt'],
    ['a record at the (exclusive) period end', (r: any) => { r.occurredAt = '2026-02-01T00:00:00.000000Z'; }, 'RECORD_OUT_OF_PERIOD:0:occurredAt'],
    ['free-text notes', (r: any) => { r.notes = 'SECRET customer said'; }, 'RECORD_FIELD_SENSITIVE:0:notes'],
    ['the person who performed it', (r: any) => { r.performedBy = 'ffffffff-ffff-4fff-8fff-ffffffffffff'; }, 'RECORD_FIELD_SENSITIVE:0:performedBy'],
    ['a storage timestamp', (r: any) => { r.createdAt = '2026-01-01T00:00:00.000000Z'; }, 'RECORD_FIELD_SENSITIVE:0:createdAt'],
    ['an unknown property', (r: any) => { r.surprise = 1; }, 'RECORD_FIELD_NOT_ALLOWED:0:surprise'],
    ['a missing property', (r: any) => { delete r.quantity; }, 'RECORD_FIELD_INVALID:0:quantity'],
    ['an unknown movement type', (r: any) => { r.movementType = 'teleport'; }, 'RECORD_FIELD_INVALID:0:movementType'],
    ['an unknown reference type', (r: any) => { r.referenceType = 'rumour'; }, 'RECORD_FIELD_INVALID:0:referenceType'],
    ['an upper-case identity', (r: any) => { r.movementId = r.movementId.toUpperCase(); }, 'RECORD_FIELD_INVALID:0:movementId'],
    ['a malformed reference id', (r: any) => { r.referenceId = 'ref-1'; }, 'RECORD_FIELD_INVALID:0:referenceId'],
    ['a numeric quantity (money and stock are text)', (r: any) => { r.quantity = 10.5; }, 'RECORD_FIELD_INVALID:0:quantity'],
    ['a non-canonical quantity', (r: any) => { r.quantity = '10.50'; }, 'RECORD_FIELD_INVALID:0:quantity'],
    ['an exponent quantity', (r: any) => { r.quantity = '1e3'; }, 'RECORD_FIELD_INVALID:0:quantity'],
    ['a negative zero', (r: any) => { r.quantity = '-0'; }, 'RECORD_FIELD_INVALID:0:quantity'],
    ['a zero cost', (r: any) => { r.unitCost = '0'; }, 'RECORD_FIELD_INVALID:0:unitCost'],
    ['a negative cost', (r: any) => { r.unitCost = '-1'; }, 'RECORD_FIELD_INVALID:0:unitCost'],
    ['a cost below the smallest storable amount', (r: any) => { r.unitCost = '0.00001'; }, 'RECORD_FIELD_INVALID:0:unitCost'],
    ['a lower-case currency', (r: any) => { r.unitCostCurrency = 'usd'; }, 'RECORD_FIELD_INVALID:0:unitCostCurrency'],
    ['a currency with no cost', (r: any) => { r.unitCost = null; }, 'RECORD_FIELD_INVALID:0:unitCostCurrency'],
    ['a cost with no currency (currency-unproven history)', (r: any) => { r.unitCostCurrency = null; }, 'RECORD_COST_CURRENCY_UNPROVEN:0:unitCostCurrency'],
    ['a timestamp at millisecond precision', (r: any) => { r.occurredAt = '2026-01-11T08:30:00.123Z'; }, 'RECORD_FIELD_INVALID:0:occurredAt'],
    ['a timestamp with an offset', (r: any) => { r.occurredAt = '2026-01-11T08:30:00.123456+02:00'; }, 'RECORD_FIELD_INVALID:0:occurredAt'],
    ['an impossible calendar date', (r: any) => { r.occurredAt = '2026-01-32T08:30:00.123456Z'; }, 'RECORD_FIELD_INVALID:0:occurredAt'],
    ['a record that is not an object', null, 'RECORD_SHAPE:0:null'],
  ])('refuses %s', (_l, mutate, expected) => {
    const a = clone(ok());
    if (mutate === null) (a.records as unknown[])[0] = 'x'; else (mutate as (r: unknown) => void)(a.records[0]);
    const r = verifyInventoryMovementEvidence(reseal(a));
    expect(r.ok).toBe(false); expect(issues(r)).toContain(expected);
  });
  it('refuses duplicate movement ids and out-of-order records', () => {
    const dup = clone(ok()); dup.records[1] = { ...dup.records[0]! }; expect(issues(verifyInventoryMovementEvidence(reseal(dup)))).toContain('RECORD_DUPLICATE:1:movementId');
    const swapped = clone(ok()); [swapped.records[0], swapped.records[1]] = [swapped.records[1]!, swapped.records[0]!]; expect(issues(verifyInventoryMovementEvidence(reseal(swapped)))).toContain('RECORD_ORDER_VIOLATION:1:null');
  });
  it('the producer refuses a ledger row that carries a cost without a currency: it never invents the currency', () => {
    expect(build([row(1), row(2, { unit_cost_currency: null })])).toMatchObject({ ok: false, code: 'RECORDS_REJECTED', issues: [{ code: 'RECORD_COST_CURRENCY_UNPROVEN', recordIndex: 1 }] });
    expect(build([row(1, { unit_cost: null, unit_cost_currency: null })]).ok).toBe(true);
  });
  it('the producer refuses a row of another business, and a row outside the period', () => {
    expect(build([row(1, { business_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' })])).toMatchObject({ ok: false, code: 'RECORDS_REJECTED' });
    expect(build([row(1, { occurred_at: '2027-01-01T00:00:00.000000Z' })])).toMatchObject({ ok: false, code: 'RECORDS_REJECTED' });
  });
  it('reports positions, property names and codes - never a value', () => {
    const a = clone(ok()); (a.records[0] as unknown as Record<string, unknown>).notes = 'SECRET-NOTE'; (a.records[1] as unknown as Record<string, unknown>).quantity = 'SECRET-QTY';
    const r = verifyInventoryMovementEvidence(reseal(a));
    expect(r.ok).toBe(false); expect(JSON.stringify(r)).not.toMatch(/SECRET/);
  });
  it('caps the issues it reports but counts all of them', () => {
    const a = clone(ok(rows(1))); a.records = Array.from({ length: 150 }, (_, i) => ({ ...a.records[0]!, movementId: id(i + 1), notes: 'x' } as never)); a.recordCount = 150;
    const r = verifyInventoryMovementEvidence(reseal(a));
    expect(r.ok === false && r.issueCount >= 150 && r.issues.length === C.maxIssuesReported).toBe(true);
  });
});
