/**
 * D3 fixture-only relational acceptance: temporary objects on a dedicated
 * PostgreSQL test connection. No numbered migration or runtime import.
 * This checks relational mechanics, NOT FORCE RLS, application permissions,
 * publisher authority or production compatibility.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

describe.skipIf(!process.env.DATABASE_URL)('BO D3 inactive association — disposable relational gates', () => {
  let db: Client;
  beforeAll(async () => {
    db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    await db.query(`
      CREATE TEMP TABLE d3_headers (
        id uuid PRIMARY KEY,
        tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, business_id uuid NOT NULL,
        period_start timestamptz NOT NULL, period_end timestamptz NOT NULL,
        status text NOT NULL DEFAULT 'ready',
        CHECK (period_end > period_start),
        UNIQUE (id, tenant_id, workspace_id, business_id, period_start, period_end)
      ) ON COMMIT PRESERVE ROWS;
      CREATE TEMP TABLE d3_artifacts (
        id uuid PRIMARY KEY,
        header_id uuid NOT NULL UNIQUE,
        tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, business_id uuid NOT NULL,
        period_start timestamptz NOT NULL, period_end timestamptz NOT NULL,
        canonical_body text NOT NULL, digest text NOT NULL, evidence_id text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        FOREIGN KEY (header_id, tenant_id, workspace_id, business_id, period_start, period_end)
          REFERENCES d3_headers(id, tenant_id, workspace_id, business_id, period_start, period_end)
          ON UPDATE RESTRICT ON DELETE RESTRICT
      ) ON COMMIT PRESERVE ROWS;
    `);
  });
  afterAll(async () => { await db?.end(); });

  const period = ['2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z'];
  async function header() {
    const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await db.query('INSERT INTO d3_headers (id,tenant_id,workspace_id,business_id,period_start,period_end) VALUES ($1,$2,$3,$4,$5,$6)', [...ids, ...period]);
    return ids;
  }
  const insert = (ids: string[], body = '{"records":[]}') =>
    db.query('INSERT INTO d3_artifacts (id,header_id,tenant_id,workspace_id,business_id,period_start,period_end,canonical_body,digest,evidence_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id', [randomUUID(), ...ids, ...period, body, 'a'.repeat(64), 'b'.repeat(64)]);

  it('enforces one immutable association slot per header (23505)', async () => {
    const ids = await header();
    await insert(ids);
    await expect(insert(ids, '{"records":[1]}')).rejects.toMatchObject({ code: '23505' });
    const r = await db.query('SELECT count(*)::integer AS n FROM d3_artifacts WHERE header_id=$1', [ids[0]]);
    expect(r.rows[0].n).toBe(1);
  });
  it('rejects scope and period mismatch using composite parent key (23503)', async () => {
    const ids = await header();
    await expect(insert([ids[0]!, ids[1]!, ids[2]!, randomUUID()])).rejects.toMatchObject({ code: '23503' });
    const r = await db.query('SELECT count(*)::integer AS n FROM d3_artifacts WHERE header_id=$1', [ids[0]]);
    expect(r.rows[0].n).toBe(0);
  });
  it('pins parent scope/period and prevents deletion after association', async () => {
    const ids = await header();
    await insert(ids);
    await expect(db.query('UPDATE d3_headers SET period_end=$2 WHERE id=$1', [ids[0], '2026-03-01T00:00:00.000Z'])).rejects.toMatchObject({ code: '23503' });
    await expect(db.query('DELETE FROM d3_headers WHERE id=$1', [ids[0]])).rejects.toMatchObject({ code: '23503' });
  });
  it('rolls back a new association on injected failure', async () => {
    const ids = await header();
    await db.query('BEGIN');
    try {
      await insert(ids);
      throw new Error('D3_INJECTED_ABORT');
    } catch (error) {
      expect((error as Error).message).toBe('D3_INJECTED_ABORT');
      await db.query('ROLLBACK');
    }
    const r = await db.query('SELECT count(*)::integer AS n FROM d3_artifacts WHERE header_id=$1', [ids[0]]);
    expect(r.rows[0].n).toBe(0);
  });
});
