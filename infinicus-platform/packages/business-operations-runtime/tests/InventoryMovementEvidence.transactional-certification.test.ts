/** BO-PUB-DEV-02A-R3 / T2. Disposable, connection-local certification only.
 * No migration, application writer, publication route, or durable evidence table.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import {
  buildInventoryMovementEvidence, computeEvidenceDigest, deriveEvidenceId,
  evidenceCanonicalJson, verifyInventoryMovementEvidence,
  type InventoryMovementEvidence, type RawInventoryMovementRow,
} from '../src/index.js';

const T = '11111111-1111-4111-8111-111111111111';
const W = '22222222-2222-4222-8222-222222222222';
const B = '33333333-3333-4333-8333-333333333333';
const P = '44444444-4444-4444-8444-444444444444';
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
const produced = (count: number): InventoryMovementEvidence => {
  const result = buildInventoryMovementEvidence({ scope, period, boPublicationPackageId: P,
    correlationId: randomUUID(), rows: Array.from({ length: count }, (_, i) => row(i + 1)) });
  if (!result.ok) throw new Error(result.code);
  return result.value;
};
const body = (a: InventoryMovementEvidence) => ({ contract: a.contract, recordSchemaVersion: a.recordSchemaVersion,
  scope: a.scope, source: a.source, ordering: a.ordering, recordCount: a.recordCount, records: a.records });

// This SQL is deliberately installed only in pg_temp. Its deferred constraint triggers
// certify the proposed storage shape at COMMIT, including an empty record set.
const disposableSql = `
CREATE OR REPLACE FUNCTION pg_temp.t2_canonical(value jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT AS $fn$
DECLARE result text;
BEGIN
  IF jsonb_typeof(value) = 'object' THEN
    SELECT '{' || COALESCE(string_agg(to_jsonb(key)::text || ':' || pg_temp.t2_canonical(val), ',' ORDER BY key COLLATE "C"), '') || '}'
      INTO result FROM jsonb_each(value) AS fields(key, val);
    RETURN result;
  ELSIF jsonb_typeof(value) = 'array' THEN
    SELECT '[' || COALESCE(string_agg(pg_temp.t2_canonical(val), ',' ORDER BY ordinal), '') || ']'
      INTO result FROM jsonb_array_elements(value) WITH ORDINALITY AS fields(val, ordinal);
    RETURN result;
  END IF;
  RETURN value::text;
END $fn$;

CREATE TEMP TABLE t2_evidence (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, business_id uuid NOT NULL,
  record_count integer NOT NULL CHECK (record_count BETWEEN 0 AND 100000),
  canonical_body text NOT NULL, digest text NOT NULL, evidence_id text NOT NULL,
  UNIQUE (id, tenant_id, workspace_id, business_id)
) ON COMMIT PRESERVE ROWS;
CREATE TEMP TABLE t2_records (
  evidence_id uuid NOT NULL, tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, business_id uuid NOT NULL,
  position integer NOT NULL CHECK (position >= 1), record jsonb NOT NULL,
  PRIMARY KEY (evidence_id, position),
  FOREIGN KEY (evidence_id, tenant_id, workspace_id, business_id)
    REFERENCES t2_evidence(id, tenant_id, workspace_id, business_id) ON DELETE RESTRICT
) ON COMMIT PRESERVE ROWS;

CREATE OR REPLACE FUNCTION pg_temp.t2_check(eid uuid) RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE h t2_evidence%ROWTYPE; count_rows integer; first_pos integer; last_pos integer; records jsonb; parsed jsonb;
BEGIN
  SELECT * INTO h FROM t2_evidence WHERE id = eid;
  IF NOT FOUND THEN RAISE EXCEPTION 'T2_HEADER_MISSING'; END IF;
  SELECT count(*)::integer, min(position), max(position), COALESCE(jsonb_agg(record ORDER BY position), '[]'::jsonb)
    INTO count_rows, first_pos, last_pos, records FROM t2_records WHERE evidence_id = eid;
  IF count_rows <> h.record_count OR (count_rows > 0 AND (first_pos <> 1 OR last_pos <> count_rows)) THEN
    RAISE EXCEPTION 'T2_COUNT_OR_POSITION'; END IF;
  BEGIN parsed := h.canonical_body::jsonb;
  EXCEPTION WHEN others THEN RAISE EXCEPTION 'T2_BODY_INVALID'; END;
  IF pg_temp.t2_canonical(parsed) <> h.canonical_body THEN RAISE EXCEPTION 'T2_BODY_NONCANONICAL'; END IF;
  IF parsed->'records' IS DISTINCT FROM records OR (parsed->>'recordCount')::integer <> h.record_count
    OR parsed->'scope' IS DISTINCT FROM jsonb_build_object('tenantId', h.tenant_id, 'workspaceId', h.workspace_id, 'businessId', h.business_id)
    OR parsed->'source'->>'domain' <> 'inventory_movements'
    OR parsed->'contract'->>'status' <> 'PROPOSED_NOT_ACTIVE' THEN
    RAISE EXCEPTION 'T2_BODY_RECORD_MISMATCH'; END IF;
  IF EXISTS (SELECT 1 FROM t2_records r WHERE r.evidence_id = eid AND (
      r.tenant_id <> h.tenant_id OR r.workspace_id <> h.workspace_id OR r.business_id <> h.business_id
      OR r.record->>'tenantId' <> h.tenant_id::text OR r.record->>'workspaceId' <> h.workspace_id::text
      OR r.record->>'businessId' <> h.business_id::text)) THEN RAISE EXCEPTION 'T2_SCOPE_MISMATCH'; END IF;
  IF EXISTS (SELECT 1 FROM t2_records r WHERE r.evidence_id = eid
    GROUP BY r.record->>'movementId' HAVING count(*) > 1)
    THEN RAISE EXCEPTION 'T2_DUPLICATE_RECORD'; END IF;
  IF EXISTS (SELECT 1 FROM (
      SELECT position, record->>'occurredAt' AS occurred_at, record->>'movementId' AS movement_id,
        lag(record->>'occurredAt') OVER (ORDER BY position) AS prior_at,
        lag(record->>'movementId') OVER (ORDER BY position) AS prior_id
      FROM t2_records WHERE evidence_id = eid
    ) ordered WHERE prior_at IS NOT NULL AND
      (occurred_at < prior_at OR (occurred_at = prior_at AND movement_id <= prior_id)))
    THEN RAISE EXCEPTION 'T2_RECORD_ORDER'; END IF;
  IF h.digest <> encode(sha256(convert_to('bo-evidence-body:' || h.canonical_body, 'UTF8')), 'hex')
    OR h.evidence_id <> encode(sha256(convert_to('bo-evidence-id:bo.inventory_movements.record_evidence:' || h.digest, 'UTF8')), 'hex')
    THEN RAISE EXCEPTION 'T2_DIGEST_MISMATCH'; END IF;
END $fn$;
CREATE OR REPLACE FUNCTION pg_temp.t2_deferred() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN PERFORM pg_temp.t2_check(NEW.id); RETURN NEW; END $fn$;
CREATE OR REPLACE FUNCTION pg_temp.t2_record_deferred() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN PERFORM pg_temp.t2_check(NEW.evidence_id); RETURN NEW; END $fn$;
CREATE CONSTRAINT TRIGGER t2_header_check AFTER INSERT ON t2_evidence DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION pg_temp.t2_deferred();
CREATE CONSTRAINT TRIGGER t2_record_check AFTER INSERT ON t2_records DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION pg_temp.t2_record_deferred();
`;

describe.skipIf(!process.env.DATABASE_URL)('BO-PUB-DEV-02A-R3 T2 — disposable PostgreSQL conservation', () => {
  let db: Client;
  beforeAll(async () => {
    db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    await db.query(disposableSql);
  });
  afterAll(async () => { await db?.end(); });

  async function attempt(a: InventoryMovementEvidence, positions: number[], records = a.records,
    change?: (b: ReturnType<typeof body>) => void): Promise<void> {
    const id = randomUUID();
    const b = structuredClone(body(a));
    change?.(b);
    await db.query('BEGIN');
    try {
      await db.query(`INSERT INTO t2_evidence VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, T, W, B, a.recordCount, evidenceCanonicalJson(b), a.digest.value, a.evidenceId]);
      for (let i = 0; i < positions.length; i++) {
        await db.query(`INSERT INTO t2_records VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
          [id, T, W, B, positions[i], JSON.stringify(records[i])]);
      }
      await db.query('COMMIT');
    } catch (error) { await db.query('ROLLBACK'); throw error; }
  }
  async function count(): Promise<number> {
    return Number((await db.query<{ n: string }>('SELECT count(*)::text n FROM t2_evidence')).rows[0]?.n);
  }

  it('commits exact 0, 1 and 2 record bodies with contiguous positions and PostgreSQL digest parity', async () => {
    for (const n of [0, 1, 2]) {
      const a = produced(n);
      expect(verifyInventoryMovementEvidence(a).ok).toBe(true);
      await attempt(a, Array.from({ length: n }, (_, i) => i + 1));
    }
    expect(await count()).toBe(3);
  });

  it.each([
    ['missing', [1], undefined, undefined],
    ['skipped', [1, 3], undefined, undefined],
    ['reordered', [2, 1], undefined, undefined],
    ['truncated body', [1, 2], undefined, (b: ReturnType<typeof body>) => { b.records.pop(); }],
    ['wrong count', [1, 2], undefined, (b: ReturnType<typeof body>) => { b.recordCount = 1; }],
  ] as const)('rejects %s and rolls back the header and rows', async (_name, positions, records, change) => {
    const before = await count();
    await expect(attempt(produced(2), [...positions], records, change)).rejects.toThrow(/T2_/);
    expect(await count()).toBe(before);
  });

  it('rejects duplicate positions, mismatched record content and foreign scope', async () => {
    const a = produced(2);
    const before = await count();
    await expect(attempt(a, [1, 1])).rejects.toThrow();
    const modified = structuredClone(a.records);
    modified[0]!.quantity = '10.6';
    await expect(attempt(a, [1, 2], modified)).rejects.toThrow(/T2_BODY_RECORD_MISMATCH/);
    modified[0] = { ...a.records[0]!, businessId: W };
    await expect(attempt(a, [1, 2], modified)).rejects.toThrow(/T2_BODY_RECORD_MISMATCH|T2_SCOPE_MISMATCH/);
    expect(await count()).toBe(before);
  });

  it('rejects a duplicate movement identity and reversed content even when the body and rows agree', async () => {
    const a = produced(2);
    const duplicate = structuredClone(a);
    duplicate.records[1] = { ...duplicate.records[0]! };
    duplicate.digest.value = computeEvidenceDigest(duplicate);
    duplicate.evidenceId = deriveEvidenceId(duplicate.digest.value);
    expect(verifyInventoryMovementEvidence(duplicate).ok).toBe(false);
    await expect(attempt(duplicate, [1, 2])).rejects.toThrow(/T2_DUPLICATE_RECORD/);

    const reversed = structuredClone(a);
    reversed.records.reverse();
    reversed.digest.value = computeEvidenceDigest(reversed);
    reversed.evidenceId = deriveEvidenceId(reversed.digest.value);
    expect(verifyInventoryMovementEvidence(reversed).ok).toBe(false);
    await expect(attempt(reversed, [1, 2])).rejects.toThrow(/T2_RECORD_ORDER/);
  });

  it('rejects tampered digest, noncanonical text, and changed microsecond or decimal values', async () => {
    const a = produced(1);
    const altered = structuredClone(a);
    altered.digest.value = '0'.repeat(64);
    await expect(attempt(altered, [1])).rejects.toThrow(/T2_DIGEST_MISMATCH/);
    await expect(attempt(a, [1], a.records, b => { b.records[0]!.occurredAt = '2026-01-11T08:30:00.123457Z'; }))
      .rejects.toThrow(/T2_BODY_RECORD_MISMATCH|T2_DIGEST_MISMATCH/);
    await expect(attempt(a, [1], a.records, b => { b.records[0]!.unitCost = '2.3'; }))
      .rejects.toThrow(/T2_BODY_RECORD_MISMATCH|T2_DIGEST_MISMATCH/);
    const id = randomUUID();
    await db.query('BEGIN');
    try {
      await db.query('INSERT INTO t2_evidence VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [id, T, W, B, 0, ` ${evidenceCanonicalJson(body(produced(0)))}`, a.digest.value, a.evidenceId]);
      await expect(db.query('COMMIT')).rejects.toThrow(/T2_BODY_NONCANONICAL/);
    } finally { await db.query('ROLLBACK'); }
  });

  it('rejects a foreign scoped row through the composite foreign key', async () => {
    const a = produced(1);
    const id = randomUUID();
    await db.query('BEGIN');
    try {
      await db.query('INSERT INTO t2_evidence VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [id, T, W, B, 1, evidenceCanonicalJson(body(a)), a.digest.value, a.evidenceId]);
      await expect(db.query('INSERT INTO t2_records VALUES ($1,$2,$3,$4,1,$5::jsonb)',
        [id, T, W, T, JSON.stringify(a.records[0])])).rejects.toMatchObject({ code: '23503' });
    } finally { await db.query('ROLLBACK'); }
  });

  it('matches TypeScript canonical bytes for decimal text, UTC microseconds, and UTF-8 strings', async () => {
    const a = produced(2);
    const b = body(a);
    const actual = await db.query<{ canonical: string; digest: string }>(
      `SELECT pg_temp.t2_canonical($1::jsonb) canonical,
              encode(sha256(convert_to('bo-evidence-body:' || $2::text, 'UTF8')), 'hex') digest`,
      [JSON.stringify(b), evidenceCanonicalJson(b)],
    );
    expect(actual.rows[0]?.canonical).toBe(evidenceCanonicalJson(b));
    expect(actual.rows[0]?.digest).toBe(a.digest.value);
    const unicode = { text: 'Kuwait الكويت', nested: { decimal: '10.5', at: '2026-01-11T08:30:00.123456Z' } };
    const result = await db.query<{ canonical: string }>('SELECT pg_temp.t2_canonical($1::jsonb) canonical', [JSON.stringify(unicode)]);
    expect(result.rows[0]?.canonical).toBe(evidenceCanonicalJson(unicode));
  });

  it('defers conservation until transaction close, then rejects partial evidence without committing it', async () => {
    const a = produced(1);
    const id = randomUUID();
    const before = await count();
    await db.query('BEGIN');
    try {
      await db.query('INSERT INTO t2_evidence VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [id, T, W, B, 1, evidenceCanonicalJson(body(a)), a.digest.value, a.evidenceId]);
      expect((await db.query('SELECT count(*)::integer n FROM t2_evidence WHERE id=$1', [id])).rows[0]?.n).toBe(1);
      await expect(db.query('SET CONSTRAINTS ALL IMMEDIATE')).rejects.toThrow(/T2_COUNT_OR_POSITION/);
    } finally { await db.query('ROLLBACK'); }
    expect(await count()).toBe(before);
  });
});

describe.skipIf(!process.env.DATABASE_URL || !process.env.ADMIN_DATABASE_URL)('BO-PUB-DEV-02A-R3 T2 — disposable concurrent insertion', () => {
  it('allows one completed shared artifact and rolls back a concurrent duplicate', async () => {
    const connectionString = process.env.DATABASE_URL!;
    const setup = new Client({ connectionString: process.env.ADMIN_DATABASE_URL! });
    const app = new Client({ connectionString });
    await setup.connect();
    await app.connect();
    const table = `t2_concurrent_${randomUUID().replace(/-/g, '')}`;
    const children = `${table}_records`;
    const artifact = produced(2);
    try {
      // A transient table in the dedicated disposable database is visible to both sessions.
      // There is no migration or application writer.
      await setup.query(`CREATE TABLE ${table} (evidence_id text PRIMARY KEY, record_count integer NOT NULL, canonical_body text NOT NULL)`);
      await setup.query(`CREATE TABLE ${children} (evidence_id text NOT NULL REFERENCES ${table}(evidence_id),
        position integer NOT NULL, record jsonb NOT NULL, PRIMARY KEY (evidence_id, position))`);
      // The application role must not receive CREATE on public. The CI admin owns
      // only this disposable fixture and grants narrowly scoped test access.
      const role = (await app.query<{ current_user: string }>('SELECT current_user')).rows[0]!.current_user;
      if (!/^[a-z_][a-z_0-9]*$/.test(role)) throw new Error('unexpected disposable application role');
      await setup.query(`GRANT SELECT, INSERT ON ${table}, ${children} TO "${role}"`);
      const write = async (): Promise<void> => {
        const client = new Client({ connectionString });
        await client.connect();
        try {
          await client.query('BEGIN');
          await client.query(`INSERT INTO ${table} VALUES ($1,$2,$3)`,
            [artifact.evidenceId, artifact.recordCount, evidenceCanonicalJson(body(artifact))]);
          for (let i = 0; i < artifact.records.length; i++) {
            await client.query(`INSERT INTO ${children} VALUES ($1,$2,$3::jsonb)`,
              [artifact.evidenceId, i + 1, JSON.stringify(artifact.records[i])]);
          }
          await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { await client.end(); }
      };
      const outcomes = await Promise.allSettled([write(), write()]);
      expect(outcomes.filter(x => x.status === 'fulfilled')).toHaveLength(1);
      const rejected = outcomes.find(x => x.status === 'rejected');
      expect(rejected?.status === 'rejected' ? (rejected.reason as { code?: string }).code : null).toBe('23505');
      const rows = await setup.query<{ record_count: number; canonical_body: string }>(`SELECT record_count, canonical_body FROM ${table}`);
      expect(rows.rows).toEqual([{ record_count: 2, canonical_body: evidenceCanonicalJson(body(artifact)) }]);
      const recorded = await setup.query<{ n: number }>(`SELECT count(*)::integer n FROM ${children}`);
      expect(recorded.rows[0]?.n).toBe(2);
    } finally {
      await setup.query(`DROP TABLE IF EXISTS ${children}`);
      await setup.query(`DROP TABLE IF EXISTS ${table}`);
      await app.end();
      await setup.end();
    }
  });
});
