/* eslint-disable @typescript-eslint/no-explicit-any -- stubs */
/**
 * BI-08-DEV-02: the ingestion service's own decisions, with the evidence source, the preparation service and the warehouse replaced by stubs (no database). Test data only.
 */
import { describe, expect, it, vi } from 'vitest';
import { BiConflictError, BiValidationError, type TenantContext } from '@infinicus/database';
import {
  BusinessIntelligenceInventoryEvidenceIngestionService, CONSUMED_EVIDENCE_CONTRACT as C, consumedDigest, consumedEvidenceId, type InventoryMovementEvidenceSource,
} from '../src/index.js';

const T = '11111111-1111-4111-8111-111111111111'; const W = '22222222-2222-4222-8222-222222222222'; const B = '33333333-3333-4333-8333-333333333333'; const H = '44444444-4444-4444-8444-444444444444';
const ctx: TenantContext = { tenantId: T, workspaceId: W, userId: '55555555-5555-4555-8555-555555555555' };
const record = (n: number) => ({ tenantId: T, workspaceId: W, businessId: B, movementId: `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`, inventoryItemId: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001', warehouseId: 'cccccccc-cccc-4ccc-8ccc-000000000001',
  movementType: 'receipt', quantity: `${n}.5`, referenceType: null, referenceId: null, unitCost: null, unitCostCurrency: null, occurredAt: `2026-01-1${n}T08:30:00.000000Z`, correlationId: 'eeeeeeee-eeee-4eee-8eee-000000000001' });
function evidence(n = 2, tweak: (e: any) => void = () => undefined): any {
  const e: any = { contract: { name: C.name, version: C.version, status: C.status }, recordSchemaVersion: C.recordSchemaVersion, scope: { tenantId: T, workspaceId: W, businessId: B },
    source: { domain: C.domain, periodStart: '2026-01-01T00:00:00.000Z', periodEnd: '2026-02-01T00:00:00.000Z', boPublicationPackageId: H }, ordering: C.ordering, recordCount: n,
    records: Array.from({ length: n }, (_, i) => record(i + 1)), digest: { algorithm: 'sha256', canonicalization: C.canonicalization, value: '' }, evidenceId: '', provenance: { correlationId: '99999999-9999-4999-8999-999999999999', owner: 'business_operations' } };
  tweak(e); e.digest.value = consumedDigest(e); e.evidenceId = consumedEvidenceId(e.digest.value); return e;
}
const request = { datasetVersionId: '66666666-6666-4666-8666-666666666666', boPublicationPackageId: H };
const load = (over: Record<string, unknown> = {}) => ({ ok: true, load: { preparedLoadId: 'p'.repeat(64), datasetVersionId: request.datasetVersionId, boPublicationPackageId: H, recordCount: 2, appendBatches: [{ datasetVersionId: request.datasetVersionId, sourceReferenceId: 's', rows: [{ rowNumber: 1, data: {} }] }, { datasetVersionId: request.datasetVersionId, sourceReferenceId: 's', rows: [{ rowNumber: 2, data: {} }] }], ...over } });
function make(o: { read?: unknown; prepare?: unknown; append?: any; seal?: any } = {}) {
  const source: InventoryMovementEvidenceSource = { read: vi.fn(async () => (o.read ?? { ok: true, evidence: evidence() }) as never) };
  const preparation = { prepare: vi.fn(async () => (o.prepare ?? load()) as never) };
  const warehouse = { appendRows: vi.fn(o.append ?? (async () => ({ inserted: 1, replayed: 0 }))), sealVersion: vi.fn(o.seal ?? (async () => ({ datasetVersionId: request.datasetVersionId, rowCount: 2, rowsDigest: 'd'.repeat(64), replayed: false }))) };
  return { service: new BusinessIntelligenceInventoryEvidenceIngestionService(source, preparation as never, warehouse as never), source, preparation, warehouse };
}

describe('BusinessIntelligenceInventoryEvidenceIngestionService decisions', () => {
  it('reads the evidence through the port, prepares with existing=allow and the inventory contract, appends every batch in order, seals, and reports the identities - the request carries no data', async () => {
    const { service, source, preparation, warehouse } = make(); const r = await service.ingest(ctx, B, request);
    expect(r).toMatchObject({ ok: true, datasetVersionId: request.datasetVersionId, boPublicationPackageId: H, recordCount: 2, inserted: 2, replayedRows: 0, sealed: { rowCount: 2, replayed: false } });
    expect((source.read as any).mock.calls[0].slice(1)).toEqual([B, H]);
    const prep = (preparation.prepare as any).mock.calls[0][2]; expect(prep.existing).toBe('allow'); expect(prep.datasetVersionId).toBe(request.datasetVersionId); expect(prep.records).toHaveLength(2);
    expect(warehouse.appendRows).toHaveBeenCalledTimes(2); expect(warehouse.sealVersion).toHaveBeenCalledTimes(1);
    expect((warehouse.appendRows as any).mock.invocationCallOrder[1]).toBeLessThan((warehouse.sealVersion as any).mock.invocationCallOrder[0]);
  });
  it.each([
    ['evidence that does not exist', { ok: false, code: 'EVIDENCE_NOT_FOUND' }, 'EVIDENCE_NOT_FOUND'],
    ['evidence the BO reader reports as altered', { ok: false, code: 'STORED_EVIDENCE_INTEGRITY' }, 'EVIDENCE_INTEGRITY'],
  ])('%s writes nothing', async (_l, read, expected) => {
    const { service, preparation, warehouse } = make({ read }); expect(await service.ingest(ctx, B, request)).toEqual({ ok: false, code: expected });
    expect(preparation.prepare).not.toHaveBeenCalled(); expect(warehouse.appendRows).not.toHaveBeenCalled(); expect(warehouse.sealVersion).not.toHaveBeenCalled();
  });
  it('does NOT trust the port: evidence the reader called ok but that fails independent verification (altered value, another business, another header) writes nothing', async () => {
    for (const [mutate, expected] of [
      [(e: any) => { e.records[0].quantity = '999'; }, 'EVIDENCE_REJECTED'], [(e: any) => { e.scope.businessId = 'ffffffff-ffff-4fff-8fff-ffffffffffff'; }, 'EVIDENCE_REJECTED'],
      [(e: any) => { e.source.boPublicationPackageId = 'ffffffff-ffff-4fff-8fff-ffffffffffff'; }, 'HEADER_MISMATCH'],
    ] as const) {
      const e = evidence(2); mutate(e); if (expected === 'HEADER_MISMATCH') { e.digest.value = consumedDigest(e); e.evidenceId = consumedEvidenceId(e.digest.value); }
      const { service, warehouse } = make({ read: { ok: true, evidence: e } }); const r = await service.ingest(ctx, B, request);
      expect(r.ok).toBe(false); if (!r.ok) expect(r.code).toBe(expected); expect(warehouse.appendRows).not.toHaveBeenCalled(); expect(warehouse.sealVersion).not.toHaveBeenCalled();
    }
  });
  it('a preparation refusal (count disagreement, bad contract/record, header chain) writes nothing; the count disagreement keeps its own code', async () => {
    const mismatch = make({ prepare: { ok: false, code: 'RECORD_COUNT_MISMATCH', issueCount: 0, issues: [] } });
    expect(await mismatch.service.ingest(ctx, B, request)).toEqual({ ok: false, code: 'RECORD_COUNT_MISMATCH', detail: 'RECORD_COUNT_MISMATCH' });
    for (const code of ['DECLARED_COUNT_CONFLICT', 'SOURCE_NOT_PUBLISHED', 'RECORDS_REJECTED', 'TARGET_NOT_PUBLISHED']) {
      const m = make({ prepare: { ok: false, code, issueCount: 1, issues: [] } }); expect(await m.service.ingest(ctx, B, request), code).toEqual({ ok: false, code: 'LOAD_REFUSED', detail: code });
      expect(m.warehouse.appendRows).not.toHaveBeenCalled(); expect(m.warehouse.sealVersion).not.toHaveBeenCalled();
    }
  });
  it('a dataset version built from another header is refused even if everything else verifies', async () => {
    const { service, warehouse } = make({ prepare: load({ boPublicationPackageId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }) });
    expect(await service.ingest(ctx, B, request)).toEqual({ ok: false, code: 'HEADER_MISMATCH' }); expect(warehouse.appendRows).not.toHaveBeenCalled();
  });
  it('a conflicting or refused append is a closed code and the version is NOT sealed', async () => {
    const conflict = make({ append: async () => { throw new BiConflictError('WarehouseRows', 'secret detail'); } });
    expect(await conflict.service.ingest(ctx, B, request)).toEqual({ ok: false, code: 'INGESTION_CONFLICT' }); expect(conflict.warehouse.sealVersion).not.toHaveBeenCalled();
    const refused = make({ append: async () => { throw new BiValidationError('WarehouseRows', ['secret detail']); } });
    expect(await refused.service.ingest(ctx, B, request)).toEqual({ ok: false, code: 'LOAD_REFUSED' }); expect(refused.warehouse.sealVersion).not.toHaveBeenCalled();
  });
  it('a validation refusal from a concurrent seal is retried ONCE per batch (replay path); a persistent refusal stays LOAD_REFUSED after exactly two attempts; a conflict is never retried', async () => {
    let calls = 0;
    const flaky = make({ append: async () => { calls += 1; if (calls === 1) throw new BiValidationError('WarehouseRows', ['sealed meanwhile']); return { inserted: 0, replayed: 1 }; } });
    const r = await flaky.service.ingest(ctx, B, request);
    expect(r.ok).toBe(true); if (r.ok) expect(r).toMatchObject({ inserted: 0, replayedRows: 2 }); // batch 1 retried once, batch 2 clean: counts are never double-added
    expect(flaky.warehouse.appendRows).toHaveBeenCalledTimes(3);
    const persistent = make({ append: async () => { throw new BiValidationError('WarehouseRows', ['invalid']); } });
    expect(await persistent.service.ingest(ctx, B, request)).toEqual({ ok: false, code: 'LOAD_REFUSED' });
    expect(persistent.warehouse.appendRows).toHaveBeenCalledTimes(2); expect(persistent.warehouse.sealVersion).not.toHaveBeenCalled();
    const conflict = make({ append: async () => { throw new BiConflictError('WarehouseRows', 'different'); } });
    expect(await conflict.service.ingest(ctx, B, request)).toEqual({ ok: false, code: 'INGESTION_CONFLICT' });
    expect(conflict.warehouse.appendRows).toHaveBeenCalledTimes(1);
  });
  it('a seal the database refuses (count or contiguity) is SEAL_REFUSED; an unexpected failure is rethrown, not swallowed', async () => {
    const refused = make({ seal: async () => { throw new BiValidationError('WarehouseSeal', ['the dataset version holds 1 rows but 2 were declared']); } });
    const r = await refused.service.ingest(ctx, B, request); expect(r).toEqual({ ok: false, code: 'SEAL_REFUSED' }); expect(JSON.stringify(r)).not.toMatch(/holds|declared/);
    const broken = make({ append: async () => { throw new Error('connection reset'); } }); await expect(broken.service.ingest(ctx, B, request)).rejects.toThrow('connection reset');
  });
  it('a replay (rows already recorded, seal already present) reports replayed counts and no insert', async () => {
    const { service } = make({ append: async () => ({ inserted: 0, replayed: 1 }), seal: async () => ({ datasetVersionId: request.datasetVersionId, rowCount: 2, rowsDigest: 'd'.repeat(64), replayed: true }) });
    expect(await service.ingest(ctx, B, request)).toMatchObject({ ok: true, inserted: 0, replayedRows: 2, sealed: { replayed: true } });
  });
  it('lower-cases the header it asks for and never passes anything but ids to the port', async () => {
    const { service, source } = make(); await service.ingest(ctx, B, { ...request, boPublicationPackageId: H.toUpperCase() }); expect((source.read as any).mock.calls[0][2]).toBe(H);
  });
});
