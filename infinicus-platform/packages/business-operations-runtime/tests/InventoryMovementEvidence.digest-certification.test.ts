/** BO-PUB-DEV-02A-R2: certification probes only. PROPOSED_NOT_ACTIVE; no persistence or activation. */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Client } from 'pg';
import {
  INVENTORY_MOVEMENT_EVIDENCE as C, buildInventoryMovementEvidence, verifyInventoryMovementEvidence,
  evidenceCanonicalJson, computeEvidenceDigest, deriveEvidenceId, type InventoryMovementEvidence, type RawInventoryMovementRow,
} from '../src/index.js';

const T = '11111111-1111-4111-8111-111111111111';
const W = '22222222-2222-4222-8222-222222222222';
const B = '33333333-3333-4333-8333-333333333333';
const P = '44444444-4444-4444-8444-444444444444';
const C0 = '55555555-5555-4555-8555-555555555555';
const scope = { tenantId: T, workspaceId: W, businessId: B };
const period = { periodStart: '2026-01-01T00:00:00.000Z', periodEnd: '2026-02-01T00:00:00.000Z' };
const row = (i: number): RawInventoryMovementRow => ({
  id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`,
  tenant_id: T, workspace_id: W, business_id: B,
  inventory_item_id: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001',
  warehouse_id: 'cccccccc-cccc-4ccc-8ccc-000000000001',
  movement_type: 'receipt', quantity: '10.5000', reference_type: 'manual',
  reference_id: 'dddddddd-dddd-4ddd-8ddd-000000000001',
  unit_cost: '2.2500', unit_cost_currency: 'USD',
  occurred_at: `2026-01-${String(i + 10).padStart(2, '0')}T08:30:00.123456Z`,
  correlation_id: 'eeeeeeee-eeee-4eee-8eee-000000000001',
});
function produced(rows: RawInventoryMovementRow[]): InventoryMovementEvidence {
  const r = buildInventoryMovementEvidence({ scope, period, boPublicationPackageId: P, correlationId: C0, rows });
  if (!r.ok) throw new Error(`fixture rejected: ${r.code}`);
  return r.value;
}
function body(a: InventoryMovementEvidence) {
  return { contract: a.contract, recordSchemaVersion: a.recordSchemaVersion, scope: a.scope, source: a.source, ordering: a.ordering, recordCount: a.recordCount, records: a.records };
}
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

describe('BO-PUB-DEV-02A-R2 T1 — producer digest certification (proposed, not active)', () => {
  it.each([0, 1, 2])('producer/verifier digest and evidence id agree for %i records', n => {
    const a = produced(Array.from({ length: n }, (_, i) => row(i + 1)));
    expect(a.contract.status).toBe('PROPOSED_NOT_ACTIVE');
    expect(a.digest.value).toBe(sha('bo-evidence-body:' + evidenceCanonicalJson(body(a))));
    expect(a.digest.value).toBe(computeEvidenceDigest(a));
    expect(a.evidenceId).toBe(sha('bo-evidence-id:' + C.contract + ':' + a.digest.value));
    expect(a.evidenceId).toBe(deriveEvidenceId(a.digest.value));
    expect(verifyInventoryMovementEvidence(a).ok).toBe(true);
  });

  it('canonical text is stable under object-key permutations, but not record-order changes', () => {
    const a = produced([row(2), row(1)]);
    const b = produced([row(1), row(2)]);
    expect(a.digest.value).toBe(b.digest.value);
    expect(evidenceCanonicalJson({ a: 1, nested: { z: 2, b: 3 } }))
      .toBe(evidenceCanonicalJson({ nested: { b: 3, z: 2 }, a: 1 }));
    const changed = structuredClone(a);
    changed.records.reverse();
    expect(computeEvidenceDigest(changed)).not.toBe(a.digest.value);
    expect(verifyInventoryMovementEvidence(changed).ok).toBe(false);
  });

  it('tampering with count, scope, period, record, digest, and evidence id is refused', () => {
    const a = produced([row(1)]);
    const cases: Array<(v: InventoryMovementEvidence) => void> = [
      v => { v.recordCount += 1; },
      v => { v.scope.businessId = W; },
      v => { v.source.periodEnd = '2026-03-01T00:00:00.000Z'; },
      v => { v.records[0]!.quantity = '9'; },
      v => { v.digest.value = '0'.repeat(64); },
      v => { v.evidenceId = 'f'.repeat(64); },
    ];
    for (const change of cases) {
      const copy = structuredClone(a);
      change(copy);
      expect(verifyInventoryMovementEvidence(copy).ok).toBe(false);
    }
  });
});

describe.skipIf(!process.env.DATABASE_URL)('BO-PUB-DEV-02A-R2 T1 — disposable PostgreSQL SHA-256 parity', () => {
  it('the exact producer canonical body agrees with the proposed PostgreSQL digest expression', async () => {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      for (const count of [0, 1, 2]) {
        const a = produced(Array.from({ length: count }, (_, i) => row(i + 1)));
        const canonicalBody = evidenceCanonicalJson(body(a));
        const result = await client.query<{ digest: string }>(
          "SELECT encode(sha256(convert_to('bo-evidence-body:' || $1::text, 'UTF8')), 'hex') AS digest",
          [canonicalBody],
        );
        expect(result.rows[0]?.digest).toBe(a.digest.value);
      }
    } finally {
      await client.end();
    }
  });
});
