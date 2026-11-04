/**
 * BI-08-DEV-02: the consumer-side, independent verification of BO inventory movement evidence, and the mapping onto the BI-08 load. The evidence here is built by a LOCAL helper that
 * applies the contract's digest rule; the live end-to-end test proves it agrees with the real BO producer. Test data only.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- tests tamper with arbitrary artifact shapes */
import { describe, expect, it } from 'vitest';
import {
  CONSUMED_EVIDENCE_CONTRACT as C, INVENTORY_MOVEMENT_WAREHOUSE_CONTRACT, consumedDigest, consumedEvidenceId, prepareWarehouseRows, toTransformedRecords, verifyConsumedInventoryEvidence,
  type ConsumedInventoryEvidence,
} from '../src/index.js';

const T = '11111111-1111-4111-8111-111111111111'; const W = '22222222-2222-4222-8222-222222222222'; const B = '33333333-3333-4333-8333-333333333333'; const H = '44444444-4444-4444-8444-444444444444';
const expected = { tenantId: T, workspaceId: W, businessId: B, boPublicationPackageId: H };
const record = (n: number, over: Record<string, unknown> = {}) => ({
  tenantId: T, workspaceId: W, businessId: B, movementId: `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`, inventoryItemId: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001', warehouseId: 'cccccccc-cccc-4ccc-8ccc-000000000001',
  movementType: 'receipt', quantity: `${n}.5`, referenceType: null, referenceId: null, unitCost: '2.25', unitCostCurrency: 'USD', occurredAt: `2026-01-1${n}T08:30:00.123456Z`, correlationId: 'eeeeeeee-eeee-4eee-8eee-000000000001', ...over,
});
/** Builds evidence under the contract's rule; `tweak` edits it BEFORE sealing so only the property under test can be wrong, `after` edits it after sealing (tampering). */
function evidence(n = 3, tweak: (e: any) => void = () => undefined, after: (e: any) => void = () => undefined): ConsumedInventoryEvidence {
  const e: any = {
    contract: { name: C.name, version: C.version, status: C.status }, recordSchemaVersion: C.recordSchemaVersion, scope: { tenantId: T, workspaceId: W, businessId: B },
    source: { domain: C.domain, periodStart: '2026-01-01T00:00:00.000Z', periodEnd: '2026-02-01T00:00:00.000Z', boPublicationPackageId: H }, ordering: C.ordering,
    recordCount: n, records: Array.from({ length: n }, (_, i) => record(i + 1)), digest: { algorithm: 'sha256', canonicalization: C.canonicalization, value: '' }, evidenceId: '',
    provenance: { correlationId: '99999999-9999-4999-8999-999999999999', owner: 'business_operations' },
  };
  tweak(e); e.digest.value = consumedDigest(e); e.evidenceId = consumedEvidenceId(e.digest.value); after(e); return e;
}
const code = (e: unknown, over: Record<string, unknown> = {}) => { const r = verifyConsumedInventoryEvidence(e, { ...expected, ...over }); return r.ok ? 'OK' : r.code; };

describe('accepts what the contract produces', () => {
  it('verifies, including after a JSON round trip, and for an empty period', () => {
    expect(code(evidence())).toBe('OK'); expect(code(JSON.parse(JSON.stringify(evidence())))).toBe('OK'); expect(code(evidence(0))).toBe('OK');
  });
  it('the digest is the SHA-256 of the prefixed canonical body and does not depend on key order or on the provenance', () => {
    const a = evidence(); const reordered = JSON.parse(JSON.stringify(a)); reordered.records = reordered.records.map((r: any) => Object.fromEntries(Object.entries(r).reverse()));
    expect(consumedDigest(reordered)).toBe(a.digest.value); expect(code(reordered)).toBe('OK');
    const other = JSON.parse(JSON.stringify(a)); other.provenance.correlationId = '77777777-7777-4777-8777-777777777777'; expect(code(other)).toBe('OK');
  });
});

describe('refuses what it must not trust (closed codes, no values)', () => {
  it.each([
    ['not an object', null, 'ARTIFACT_SHAPE'], ['an array', [], 'ARTIFACT_SHAPE'], ['an extra top-level property', evidence(3, undefined, (e) => { e.extra = 1; }), 'ARTIFACT_SHAPE'],
    ['a missing property', evidence(3, undefined, (e) => { delete e.provenance; }), 'ARTIFACT_SHAPE'],
    ['another contract name', evidence(3, (e) => { e.contract.name = 'bo.sales.record_evidence'; }), 'CONTRACT_UNSUPPORTED'], ['another contract version', evidence(3, (e) => { e.contract.version = '1.0.0'; }), 'CONTRACT_UNSUPPORTED'],
    ['an ACTIVE status', evidence(3, (e) => { e.contract.status = 'ACTIVE'; }), 'CONTRACT_UNSUPPORTED'],
    ['another schema version', evidence(3, (e) => { e.recordSchemaVersion = 'bo.inventory_movement.record.v9'; }), 'SCHEMA_UNSUPPORTED'], ['another ordering', evidence(3, (e) => { e.ordering = 'id desc'; }), 'SCHEMA_UNSUPPORTED'],
    ['another digest algorithm', evidence(3, undefined, (e) => { e.digest.algorithm = 'md5'; }), 'ARTIFACT_SHAPE'], ['a malformed digest', evidence(3, undefined, (e) => { e.digest.value = 'abc'; }), 'ARTIFACT_SHAPE'],
    ['another tenant', evidence(3, (e) => { e.scope.tenantId = 'ffffffff-ffff-4fff-8fff-ffffffffffff'; }), 'SCOPE_MISMATCH'], ['another business', evidence(3, (e) => { e.scope.businessId = 'ffffffff-ffff-4fff-8fff-ffffffffffff'; }), 'SCOPE_MISMATCH'],
    ['a record of another business', evidence(3, (e) => { e.records[1].businessId = 'ffffffff-ffff-4fff-8fff-ffffffffffff'; }), 'SCOPE_MISMATCH'],
    ['another domain', evidence(3, (e) => { e.source.domain = 'sales'; }), 'ARTIFACT_SHAPE'], ['another publication header', evidence(3, (e) => { e.source.boPublicationPackageId = 'ffffffff-ffff-4fff-8fff-ffffffffffff'; }), 'HEADER_MISMATCH'],
    ['an unbound artifact', evidence(3, (e) => { e.source.boPublicationPackageId = null; }), 'HEADER_MISMATCH'],
    ['another owner', evidence(3, undefined, (e) => { e.provenance.owner = 'business_intelligence'; }), 'ARTIFACT_SHAPE'],
    ['a record count that disagrees with the records', evidence(3, undefined, (e) => { e.recordCount = 2; }), 'COUNT_MISMATCH'],
    ['a record with notes', evidence(3, (e) => { e.records[0].notes = 'free text'; }), 'RECORD_INVALID'], ['a record with the performing person', evidence(3, (e) => { e.records[0].performedBy = 'x'; }), 'RECORD_INVALID'],
    ['a record missing a property', evidence(3, (e) => { delete e.records[0].quantity; }), 'RECORD_INVALID'],
    ['a cost with no currency (currency unproven)', evidence(3, (e) => { e.records[0].unitCostCurrency = null; }), 'RECORD_INVALID'], ['a currency with no cost', evidence(3, (e) => { e.records[0].unitCost = null; }), 'RECORD_INVALID'],
    ['a duplicate movement id', evidence(3, (e) => { e.records[1].movementId = e.records[0].movementId; }), 'RECORD_INVALID'],
    ['records out of order', evidence(3, (e) => { e.records.reverse(); }), 'ORDER_VIOLATION'],
    ['a changed quantity (digest not re-sealed)', evidence(3, undefined, (e) => { e.records[1].quantity = '999'; }), 'DIGEST_MISMATCH'],
    ['a changed scope in a record (digest not re-sealed)', evidence(3, undefined, (e) => { e.source.periodEnd = '2026-03-01T00:00:00.000Z'; }), 'DIGEST_MISMATCH'],
    ['a dropped record (count and digest not re-sealed)', evidence(3, undefined, (e) => { e.records.pop(); e.recordCount = 2; }), 'DIGEST_MISMATCH'],
    ['a swapped evidence id', evidence(3, undefined, (e) => { e.evidenceId = '1'.repeat(64); }), 'EVIDENCE_ID_MISMATCH'],
  ])('refuses %s', (_l, e, expectedCode) => { expect(code(e)).toBe(expectedCode); });
  it('refuses evidence for a different expectation than the caller named: tenant, workspace, business, header, count', () => {
    const e = evidence();
    expect(code(e, { tenantId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' })).toBe('SCOPE_MISMATCH'); expect(code(e, { workspaceId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' })).toBe('SCOPE_MISMATCH');
    expect(code(e, { businessId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' })).toBe('SCOPE_MISMATCH'); expect(code(e, { boPublicationPackageId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' })).toBe('HEADER_MISMATCH');
    expect(code(e, { recordCount: 4 })).toBe('COUNT_MISMATCH');
  });
  it('reports only a code - never a value', () => {
    const r = verifyConsumedInventoryEvidence(evidence(3, (e) => { e.records[0].notes = 'SECRET-NOTE'; }), expected); expect(JSON.stringify(r)).not.toMatch(/SECRET/);
  });
});

describe('mapping onto the BI-08 load (exact decimals, source identity, order)', () => {
  it('maps every record with its movement id as source identity and evidence order as source order; the BI-08 contract accepts it and keeps decimals as text', () => {
    const e = evidence(3); const records = toTransformedRecords(e);
    expect(records.map((r) => r.sourceIndex)).toEqual([0, 1, 2]); expect(records.map((r) => r.sourceRecordId)).toEqual(e.records.map((r) => r.movementId));
    const r = prepareWarehouseRows(INVENTORY_MOVEMENT_WAREHOUSE_CONTRACT, records); expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.prepared.rows.map((x) => x.rowNumber)).toEqual([1, 2, 3]); expect(r.prepared.rows[0]!.data).toMatchObject({ quantity: '1.5', unitCost: '2.25', occurredAt: '2026-01-11T08:30:00.123456Z' });
    expect(r.prepared.partitions).toEqual([{ partitionKey: 'receipt', recordCount: 3 }]);
  });
  it('the warehouse contract refuses a numeric quantity, an out-of-range cost and an unknown movement type that a (hypothetically) corrupted evidence could carry', () => {
    for (const over of [{ quantity: 5 }, { quantity: '1.50' }, { unitCost: '0.00001' }, { unitCost: '0' }, { movementType: 'teleport' }, { referenceType: 'rumour' }]) {
      const e = evidence(1, (x) => { Object.assign(x.records[0], over); }); const r = prepareWarehouseRows(INVENTORY_MOVEMENT_WAREHOUSE_CONTRACT, toTransformedRecords(e));
      expect(r.ok, JSON.stringify(over)).toBe(false);
    }
  });
  it('the wide magnitude edge values survive the whole mapping as exact text', () => {
    const e = evidence(1, (x) => { x.records[0].quantity = '99999999999999.9999'; x.records[0].unitCost = '0.0001'; });
    const r = prepareWarehouseRows(INVENTORY_MOVEMENT_WAREHOUSE_CONTRACT, toTransformedRecords(e)); expect(r.ok && r.prepared.rows[0]!.data).toMatchObject({ quantity: '99999999999999.9999', unitCost: '0.0001' });
  });
});
