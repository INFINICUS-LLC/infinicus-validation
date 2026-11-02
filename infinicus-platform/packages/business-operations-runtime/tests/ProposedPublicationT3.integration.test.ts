/** BO-PUB-DEV-02A-R4: transient, disabled lifecycle certification on disposable PostgreSQL only. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { buildInventoryMovementEvidence, canonicalJson, type InventoryMovementEvidence } from '../src/publication/record-evidence/inventoryMovementEvidence.js';
import { assessProposedBinding, assessProposedDispatch, type ProposedHeader, type ProposedStoredEvidence } from './helpers/proposedT3Certification.js';

const T = '11111111-1111-4111-8111-111111111111';
const W = '22222222-2222-4222-8222-222222222222';
const B = '33333333-3333-4333-8333-333333333333';
const OTHER = '55555555-5555-4555-8555-555555555555';
const periodStart = '2026-01-01T00:00:00.000Z';
const periodEnd = '2026-02-01T00:00:00.000Z';
const produced = (headerId: string, quantity = '10.5000'): InventoryMovementEvidence => {
  const result = buildInventoryMovementEvidence({ scope: { tenantId: T, workspaceId: W, businessId: B },
    period: { periodStart, periodEnd }, boPublicationPackageId: headerId, correlationId: OTHER,
    rows: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001', tenant_id: T, workspace_id: W, business_id: B,
      inventory_item_id: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001', warehouse_id: 'cccccccc-cccc-4ccc-8ccc-000000000001',
      movement_type: 'receipt', quantity, reference_type: 'manual', reference_id: OTHER,
      unit_cost: '2.2500', unit_cost_currency: 'USD', occurred_at: '2026-01-11T08:30:00.123456Z', correlation_id: OTHER }],
  });
  if (!result.ok) throw new Error(result.code);
  return result.value;
};
const body = (a: InventoryMovementEvidence) => canonicalJson({ contract: a.contract, recordSchemaVersion: a.recordSchemaVersion,
  scope: a.scope, source: a.source, ordering: a.ordering, recordCount: a.recordCount, records: a.records });

describe.skipIf(!process.env.DATABASE_URL || !process.env.ADMIN_DATABASE_URL)('BO-PUB-DEV-02A-R4 T3 — disposable PostgreSQL identity and replay', () => {
  const suffix = randomUUID().replace(/-/g, '');
  const headers = `t3_headers_${suffix}`;
  const evidence = `t3_evidence_${suffix}`;
  const audit = `t3_audit_${suffix}`;
  const guard = `t3_guard_${suffix}`;
  let admin: Client;
  let app: Client;
  const headerId = randomUUID();

  beforeAll(async () => {
    admin = new Client({ connectionString: process.env.ADMIN_DATABASE_URL! });
    app = new Client({ connectionString: process.env.DATABASE_URL! });
    await admin.connect(); await app.connect();
    const role = (await app.query<{ current_user: string }>('SELECT current_user')).rows[0]!.current_user;
    if (!/^[a-z_][a-z_0-9]*$/.test(role)) throw new Error('unexpected disposable role');
    await admin.query(`CREATE TABLE ${headers} (
      id uuid PRIMARY KEY, tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, business_id uuid NOT NULL,
      period_start text NOT NULL, period_end text NOT NULL, record_count integer NOT NULL,
      version integer NOT NULL, status text NOT NULL, target_layer text NOT NULL)`);
    await admin.query(`CREATE TABLE ${evidence} (
      header_id uuid PRIMARY KEY REFERENCES ${headers}(id), tenant_id uuid NOT NULL, workspace_id uuid NOT NULL,
      business_id uuid NOT NULL, header_version integer NOT NULL, digest text NOT NULL,
      evidence_id text NOT NULL, canonical_body text NOT NULL, publisher_claim uuid NOT NULL)`);
    await admin.query(`CREATE TABLE ${audit} (
      id uuid PRIMARY KEY, header_id uuid NOT NULL REFERENCES ${headers}(id), tenant_id uuid NOT NULL,
      workspace_id uuid NOT NULL, business_id uuid NOT NULL, event_kind text NOT NULL)`);
    await admin.query(`CREATE FUNCTION ${guard}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'T3_APPEND_ONLY' USING ERRCODE = '23514'; END $$`);
    await admin.query(`CREATE TRIGGER ${guard}_mutation BEFORE UPDATE OR DELETE ON ${evidence}
      FOR EACH ROW EXECUTE FUNCTION ${guard}()`);
    await admin.query(`CREATE TRIGGER ${guard}_truncate BEFORE TRUNCATE ON ${evidence}
      FOR EACH STATEMENT EXECUTE FUNCTION ${guard}()`);
    await admin.query(`CREATE TRIGGER ${guard}_audit_mutation BEFORE UPDATE OR DELETE ON ${audit}
      FOR EACH ROW EXECUTE FUNCTION ${guard}()`);
    await admin.query(`CREATE TRIGGER ${guard}_audit_truncate BEFORE TRUNCATE ON ${audit}
      FOR EACH STATEMENT EXECUTE FUNCTION ${guard}()`);
    for (const table of [headers, evidence, audit]) {
      await admin.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      await admin.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      await admin.query(`CREATE POLICY ${table}_scope ON ${table} USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid AND
        workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
        WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid AND
          workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)`);
    }
    await admin.query(`GRANT SELECT, INSERT, UPDATE ON ${headers} TO "${role}"`);
    await admin.query(`GRANT SELECT, INSERT ON ${evidence}, ${audit} TO "${role}"`);
    await admin.query(`INSERT INTO ${headers} VALUES ($1,$2,$3,$4,$5,$6,1,2,'ready','business_intelligence')`,
      [headerId, T, W, B, periodStart, periodEnd]);
  });
  afterAll(async () => {
    await admin?.query(`DROP TABLE IF EXISTS ${audit}, ${evidence}, ${headers}`);
    await admin?.query(`DROP FUNCTION IF EXISTS ${guard}()`);
    await app?.end(); await admin?.end();
  });

  async function attempt(candidate: InventoryMovementEvidence, businessId = B, rollback = false): Promise<string> {
    const db = new Client({ connectionString: process.env.DATABASE_URL! });
    await db.connect();
    await db.query('BEGIN');
    try {
      await db.query("SELECT set_config('app.tenant_id', $1, true), set_config('app.workspace_id', $2, true)", [T, W]);
      const found = await db.query<{
        tenant_id: string; workspace_id: string; business_id: string; period_start: string; period_end: string;
        record_count: number; version: number; status: ProposedHeader['status']; target_layer: ProposedHeader['targetLayer'];
      }>(`SELECT * FROM ${headers} WHERE id=$1 AND business_id=$2 FOR UPDATE`, [headerId, businessId]);
      if (found.rowCount !== 1) throw new Error('HEADER_NOT_FOUND');
      const current = found.rows[0]!;
      const h: ProposedHeader = { id: headerId, tenantId: current.tenant_id, workspaceId: current.workspace_id,
        businessId: current.business_id, periodStart: current.period_start, periodEnd: current.period_end,
        recordCount: current.record_count, version: current.version, status: current.status, targetLayer: current.target_layer };
      const saved = await db.query<{ digest: string; evidence_id: string; canonical_body: string; header_version: number }>(
        `SELECT digest, evidence_id, canonical_body, header_version FROM ${evidence} WHERE header_id=$1`, [headerId]);
      // The SQL row is checked byte-for-byte against the candidate, then the pure
      // verifier decides whether this is the one new artifact or a true replay.
      if (saved.rowCount) {
        if (h.status !== 'ready' || saved.rows[0]!.header_version !== h.version) throw new Error('STALE_HEADER');
        if (saved.rows[0]!.digest !== candidate.digest.value || saved.rows[0]!.evidence_id !== candidate.evidenceId
          || saved.rows[0]!.canonical_body !== body(candidate)) throw new Error('CONFLICTING_EVIDENCE');
        await db.query('COMMIT');
        return 'IDENTICAL_REPLAY';
      }
      const decision = assessProposedBinding(h, candidate, null);
      if (decision.code !== 'STORE_CANDIDATE') throw new Error(decision.code);
      await db.query(`INSERT INTO ${evidence} VALUES ($1,$2,$3,$4,2,$5,$6,$7,$8)`,
        [headerId, T, W, B, candidate.digest.value, candidate.evidenceId, body(candidate), OTHER]);
      await db.query(`INSERT INTO ${audit} VALUES ($1,$2,$3,$4,$5,'evidence_bound')`, [randomUUID(), headerId, T, W, B]);
      if (rollback) throw new Error('INJECTED_ROLLBACK');
      await db.query('COMMIT');
      return 'STORE_CANDIDATE';
    } catch (error) { await db.query('ROLLBACK'); throw error; }
    finally { await db.end(); }
  }
  async function counts(): Promise<[number, number]> {
    const r = await admin.query(`SELECT (SELECT count(*)::integer FROM ${evidence}) evidence,
      (SELECT count(*)::integer FROM ${audit}) audit`);
    return [r.rows[0].evidence, r.rows[0].audit];
  }

  it('rolls back a partial attempt and retains no artifact or audit event', async () => {
    await expect(attempt(produced(headerId), B, true)).rejects.toThrow('INJECTED_ROLLBACK');
    expect(await counts()).toEqual([0, 0]);
  });

  it('serializes simultaneous identical attempts under a scoped header lock', async () => {
    const a = produced(headerId);
    const result = await Promise.all([attempt(a), attempt(a)]);
    expect(result.sort()).toEqual(['IDENTICAL_REPLAY', 'STORE_CANDIDATE']);
    expect(await counts()).toEqual([1, 1]);
  });

  it('rejects divergent content and foreign-business lookup without changing state', async () => {
    await expect(attempt(produced(headerId, '11.0000'))).rejects.toThrow('CONFLICTING_EVIDENCE');
    await expect(attempt(produced(headerId), OTHER)).rejects.toThrow('HEADER_NOT_FOUND');
    expect(await counts()).toEqual([1, 1]);
  });

  it('preserves append-only audit and evidence against mutation and checks RLS', async () => {
    await expect(admin.query(`UPDATE ${evidence} SET digest='changed' WHERE header_id=$1`, [headerId]))
      .rejects.toMatchObject({ code: '23514' });
    await expect(admin.query(`TRUNCATE ${evidence}`)).rejects.toMatchObject({ code: '23514' });
    await expect(admin.query(`DELETE FROM ${audit} WHERE header_id=$1`, [headerId])).rejects.toMatchObject({ code: '23514' });
    await expect(admin.query(`TRUNCATE ${audit}`)).rejects.toMatchObject({ code: '23514' });
    expect((await app.query(`SELECT count(*)::integer n FROM ${evidence}`)).rows[0]?.n).toBe(0);
    expect(await counts()).toEqual([1, 1]);
  });

  it('keeps the real dispatch transition closed without a governed publisher authority', async () => {
    const a = produced(headerId);
    const stored: ProposedStoredEvidence = { headerId, headerVersion: 2, artifact: a };
    const h: ProposedHeader = { id: headerId, tenantId: T, workspaceId: W, businessId: B,
      periodStart, periodEnd, recordCount: 1, version: 2, status: 'ready', targetLayer: 'business_intelligence' };
    expect(assessProposedDispatch(h, stored)).toEqual({ status: 'PROPOSED_NOT_ACTIVE', code: 'STRUCTURAL_DISPATCH_CANDIDATE' });
    expect((await admin.query(`SELECT status FROM ${headers} WHERE id=$1`, [headerId])).rows[0]?.status).toBe('ready');
  });

  it('rejects a header changed after evidence binding', async () => {
    await admin.query(`UPDATE ${headers} SET version=3 WHERE id=$1`, [headerId]);
    await expect(attempt(produced(headerId))).rejects.toThrow('STALE_HEADER');
    expect(await counts()).toEqual([1, 1]);
  });
});
