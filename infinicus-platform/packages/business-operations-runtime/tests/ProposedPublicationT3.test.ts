/** T3 candidate certification. No active publisher or durable evidence relation. */
import { describe, expect, it } from 'vitest';
import {
  buildInventoryMovementEvidence, type InventoryMovementEvidence, type RawInventoryMovementRow,
} from '../src/publication/record-evidence/inventoryMovementEvidence.js';
import {
  assessProposedBinding, assessProposedDispatch,
  type ProposedHeader, type ProposedStoredEvidence,
} from './helpers/proposedT3Certification.js';

const T = '11111111-1111-4111-8111-111111111111';
const W = '22222222-2222-4222-8222-222222222222';
const B = '33333333-3333-4333-8333-333333333333';
const H = '44444444-4444-4444-8444-444444444444';
const OTHER = '55555555-5555-4555-8555-555555555555';
const START = '2026-01-01T00:00:00.000Z';
const END = '2026-02-01T00:00:00.000Z';
const row = (quantity = '10.5000', currency: string | null = 'USD'): RawInventoryMovementRow => ({
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001', tenant_id: T, workspace_id: W, business_id: B,
  inventory_item_id: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001', warehouse_id: 'cccccccc-cccc-4ccc-8ccc-000000000001',
  movement_type: 'receipt', quantity, reference_type: 'manual', reference_id: OTHER,
  unit_cost: '2.2500', unit_cost_currency: currency, occurred_at: '2026-01-11T08:30:00.123456Z', correlation_id: OTHER,
});
const header = (): ProposedHeader => ({ id: H, tenantId: T, workspaceId: W, businessId: B,
  periodStart: START, periodEnd: END, recordCount: 1, version: 2, status: 'ready', targetLayer: 'business_intelligence' });
function artifact(quantity = '10.5000', correlationId = OTHER): InventoryMovementEvidence {
  const r = buildInventoryMovementEvidence({ scope: { tenantId: T, workspaceId: W, businessId: B },
    period: { periodStart: START, periodEnd: END }, boPublicationPackageId: H,
    correlationId, rows: [row(quantity)] });
  if (!r.ok) throw new Error(r.code);
  return r.value;
}
const stored = (a: InventoryMovementEvidence): ProposedStoredEvidence => ({ headerId: H, headerVersion: 2, artifact: a });

describe('BO-PUB-DEV-02A-R4 T3 proposed identity and lifecycle', () => {
  it('binds deterministic content identity to one scoped header, period and count', () => {
    const h = header(); const a = artifact();
    expect(assessProposedBinding(h, a, null)).toMatchObject({ status: 'PROPOSED_NOT_ACTIVE', code: 'STORE_CANDIDATE' });
    expect(assessProposedBinding({ ...h, businessId: OTHER }, a, null).code).toBe('HEADER_MISMATCH');
    expect(assessProposedBinding({ ...h, tenantId: OTHER }, a, null).code).toBe('HEADER_MISMATCH');
    expect(assessProposedBinding({ ...h, workspaceId: OTHER }, a, null).code).toBe('HEADER_MISMATCH');
    expect(assessProposedBinding({ ...h, id: OTHER }, a, null).code).toBe('HEADER_MISMATCH');
    expect(assessProposedBinding({ ...h, periodEnd: '2026-03-01T00:00:00.000Z' }, a, null).code).toBe('HEADER_MISMATCH');
    expect(assessProposedBinding({ ...h, recordCount: 2 }, a, null).code).toBe('HEADER_MISMATCH');
  });

  it('treats a byte-identical body with different un-hashed provenance as an exact replay no-op', () => {
    const first = artifact();
    const replay = artifact('10.5000', '66666666-6666-4666-8666-666666666666');
    expect(replay.evidenceId).toBe(first.evidenceId);
    expect(assessProposedBinding(header(), replay, stored(first)).code).toBe('IDENTICAL_REPLAY');
  });

  it('rejects divergent evidence for one header and refuses tampered identity', () => {
    const first = artifact(); const changed = artifact('11.0000');
    expect(changed.evidenceId).not.toBe(first.evidenceId);
    expect(assessProposedBinding(header(), changed, stored(first)).code).toBe('CONFLICTING_EVIDENCE');
    const tampered = structuredClone(first); tampered.evidenceId = '0'.repeat(64);
    expect(assessProposedBinding(header(), tampered, null).code).toBe('ARTIFACT_INVALID');
  });

  it('rejects stale, cancelled, missing and conflicting evidence before a dispatch candidate', () => {
    const a = artifact();
    expect(assessProposedDispatch(header(), null).code).toBe('EVIDENCE_MISSING');
    expect(assessProposedDispatch(header(), stored(a)).code).toBe('STRUCTURAL_DISPATCH_CANDIDATE');
    expect(assessProposedDispatch({ ...header(), status: 'cancelled' }, stored(a)).code).toBe('STALE_HEADER');
    expect(assessProposedDispatch({ ...header(), version: 3 }, stored(a)).code).toBe('STALE_HEADER');
    expect(assessProposedDispatch(header(), stored(artifact('11.0000'))).code).toBe('STRUCTURAL_DISPATCH_CANDIDATE');
    expect(assessProposedBinding({ ...header(), status: 'dispatched', version: 3 }, a, stored(a)).code).toBe('IDENTICAL_REPLAY');
  });

  it('preserves historical currency refusal and never offers authority for an invalid source', () => {
    const r = buildInventoryMovementEvidence({ scope: { tenantId: T, workspaceId: W, businessId: B },
      period: { periodStart: START, periodEnd: END }, boPublicationPackageId: H,
      correlationId: OTHER, rows: [row('10.5000', null)] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues).toContainEqual(expect.objectContaining({ code: 'RECORD_COST_CURRENCY_UNPROVEN' }));
  });
});
