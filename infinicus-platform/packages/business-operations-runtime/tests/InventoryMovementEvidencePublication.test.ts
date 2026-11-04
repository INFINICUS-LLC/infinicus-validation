/**
 * BO-PUB-DEV-02: the publication service's own decisions, with the extractor, store and reader replaced by stubs (no database): authority first, every store outcome mapped to a
 * closed code, and only a verified artifact ever reaches the store. Rows are TEST DATA.
 */
import { describe, expect, it, vi } from 'vitest';
import type { TenantContext } from '@infinicus/database';
import {
  InventoryMovementEvidencePublicationService, buildInventoryMovementEvidence, canonicalEvidenceBody, type InventoryMovementEvidence, type RawInventoryMovementRow, type PublicationAuthority,
} from '../src/index.js';

const T = '11111111-1111-4111-8111-111111111111'; const W = '22222222-2222-4222-8222-222222222222'; const B = '33333333-3333-4333-8333-333333333333'; const H = '44444444-4444-4444-8444-444444444444';
const ctx: TenantContext = { tenantId: T, workspaceId: W, userId: '55555555-5555-4555-8555-555555555555' };
const row = (n: number): RawInventoryMovementRow => ({ id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`, tenant_id: T, workspace_id: W, business_id: B, inventory_item_id: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001',
  warehouse_id: 'cccccccc-cccc-4ccc-8ccc-000000000001', movement_type: 'receipt', quantity: '5.0000', reference_type: null, reference_id: null, unit_cost: null, unit_cost_currency: null,
  occurred_at: `2026-01-1${n}T00:00:00.000000Z`, correlation_id: 'eeeeeeee-eeee-4eee-8eee-000000000001' });
const built = (): InventoryMovementEvidence => { const r = buildInventoryMovementEvidence({ scope: { tenantId: T, workspaceId: W, businessId: B }, period: { periodStart: '2026-01-01T00:00:00.000Z', periodEnd: '2026-02-01T00:00:00.000Z' }, boPublicationPackageId: H, correlationId: '99999999-9999-4999-8999-999999999999', rows: [row(1), row(2)] }); if (!r.ok) throw new Error('x'); return r.value; };
const request = { businessId: B, boPublicationPackageId: H, periodStart: '2026-01-01T00:00:00.000Z', periodEnd: '2026-02-01T00:00:00.000Z', correlationId: '99999999-9999-4999-8999-999999999999' };
const allow: PublicationAuthority = { mayPublish: async () => true };
const make = (over: { extract?: unknown; append?: unknown; read?: unknown; authority?: PublicationAuthority } = {}) => {
  const extractor = { extract: vi.fn(async () => over.extract ?? { ok: true, evidence: built() }) };
  const store = { append: vi.fn(async () => over.append ?? { outcome: 'STORED', evidenceRowId: 'x' }) };
  const reader = { read: vi.fn(async () => over.read ?? { ok: true, evidence: built(), storedAt: new Date() }) };
  const service = new InventoryMovementEvidencePublicationService(over.authority ?? allow, extractor as never, store as never, reader as never);
  return { service, extractor, store, reader };
};

describe('InventoryMovementEvidencePublicationService decisions', () => {
  it('asks the authority first: a denial reads nothing and stores nothing', async () => {
    const { service, extractor, store, reader } = make({ authority: { mayPublish: async () => false } });
    expect(await service.publish(ctx, request)).toEqual({ ok: false, code: 'PUBLICATION_NOT_AUTHORIZED' });
    expect(extractor.extract).not.toHaveBeenCalled(); expect(store.append).not.toHaveBeenCalled(); expect(reader.read).not.toHaveBeenCalled();
  });
  it.each([
    ['STORED', 'STORED', false], ['REPLAYED', 'REPLAYED', true],
  ])('a %s outcome is read back through the verifying reader and returned (replayed=%s)', async (_l, outcome, replayed) => {
    const { service, store, reader } = make({ append: { outcome, evidenceRowId: 'x' } });
    const r = await service.publish(ctx, request); expect(r).toMatchObject({ ok: true, replayed }); expect(store.append).toHaveBeenCalledTimes(1); expect(reader.read).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['CONFLICT', 'EVIDENCE_CONFLICT'], ['REFUSED', 'EVIDENCE_REFUSED'], ['UNKNOWN_BUSINESS', 'BUSINESS_NOT_FOUND'], ['HEADER_NOT_FOUND', 'HEADER_NOT_FOUND'], ['HEADER_NOT_ELIGIBLE', 'HEADER_NOT_READY'],
  ])('maps the store outcome %s to the closed code %s and never reads back', async (outcome, code) => {
    const { service, reader } = make({ append: { outcome } });
    expect(await service.publish(ctx, request)).toEqual({ ok: false, code }); expect(reader.read).not.toHaveBeenCalled();
  });
  it('a stored artifact that does not verify on read-back is STORED_EVIDENCE_INTEGRITY, never returned', async () => {
    const { service } = make({ read: { ok: false, code: 'STORED_EVIDENCE_INTEGRITY' } });
    expect(await service.publish(ctx, request)).toEqual({ ok: false, code: 'STORED_EVIDENCE_INTEGRITY' });
  });
  it('passes every extractor failure through as its own code and stores nothing', async () => {
    for (const code of ['HEADER_NOT_FOUND', 'HEADER_NOT_PUBLISHED', 'HEADER_COUNT_MISMATCH', 'HEADER_PERIOD_MISMATCH', 'EVIDENCE_REJECTED', 'BUSINESS_NOT_FOUND', 'REQUEST_INVALID']) {
      const { service, store } = make({ extract: { ok: false, code, issueCount: 0, issues: [] } });
      expect(await service.publish(ctx, request), code).toEqual({ ok: false, code }); expect(store.append).not.toHaveBeenCalled();
    }
  });
  it('re-verifies at the storage boundary: an artifact that fails verification (tampered after extraction) never reaches the store', async () => {
    const e = built(); (e.records[0] as unknown as Record<string, unknown>).quantity = '999';
    const { service, store } = make({ extract: { ok: true, evidence: e } });
    expect(await service.publish(ctx, request)).toEqual({ ok: false, code: 'EVIDENCE_REFUSED' }); expect(store.append).not.toHaveBeenCalled();
  });
  it('hands the store the canonical body bytes, the digest, the evidence id and the header binding exactly, and no records (the body carries them)', async () => {
    const { service, store } = make(); await service.publish(ctx, request);
    const input = (store.append.mock.calls[0] as unknown as [TenantContext, string, Record<string, unknown>])[2];
    const e = built();
    expect(input.canonicalBody).toBe(canonicalEvidenceBody(e)); expect(input.digest).toBe(e.digest.value); expect(input.evidenceId).toBe(e.evidenceId);
    expect(input.publicationPackageId).toBe(H); expect(input.recordCount).toBe(2); expect('records' in input).toBe(false);
  });
  it('refuses a request without a header id before reading anything', async () => {
    const { service, extractor } = make();
    expect(await service.publish(ctx, { ...request, boPublicationPackageId: undefined as unknown as string })).toEqual({ ok: false, code: 'REQUEST_INVALID' }); expect(extractor.extract).not.toHaveBeenCalled();
  });
});
