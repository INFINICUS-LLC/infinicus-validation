/**
 * helpers/ddlProof.ts - the wait-free DDL proof runner (live PostgreSQL, scratch schema). It proves the three properties the shared-database CI relies on:
 * it never queues behind a lock (so it blocks nobody), it cannot be part of a deadlock, and it gives up loudly rather than hanging.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { withExclusiveLocksNoWait } from './helpers/ddlProof.js';

const RUN = !!process.env.ADMIN_DATABASE_URL;
const SCHEMA = `ddlproof_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const A = `${SCHEMA}.a`;
const B = `${SCHEMA}.b`;

describe.runIf(RUN)('withExclusiveLocksNoWait', () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL, max: 8 });
    await pool.query(`CREATE SCHEMA ${SCHEMA}`);
    await pool.query(`CREATE TABLE ${A} (id int PRIMARY KEY)`);
    await pool.query(`CREATE TABLE ${B} (id int PRIMARY KEY, a_id int REFERENCES ${A}(id))`);
    await pool.query(`INSERT INTO ${A} VALUES (1)`);
  });
  afterAll(async () => {
    await pool.query(`DROP SCHEMA ${SCHEMA} CASCADE`);
    await pool.end();
  });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('runs the proof with the exclusive locks held, and always rolls back what it did', async () => {
    const seen = await withExclusiveLocksNoWait(pool, { tables: [A, B] }, async (c) => {
      const held = await c.query(`SELECT count(*)::int AS n FROM pg_locks l WHERE l.pid = pg_backend_pid() AND l.mode = 'AccessExclusiveLock' AND l.relation IN ('${A}'::regclass, '${B}'::regclass)`);
      await c.query(`ALTER TABLE ${B} ADD COLUMN extra int`);
      return held.rows[0].n as number;
    });
    expect(seen).toBe(2);
    const cols = await pool.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'b' AND column_name = 'extra'`, [SCHEMA]);
    expect(cols.rows[0].n).toBe(0);
  });

  it('never queues behind a busy lock: while another transaction holds the table it backs off, and nobody else is blocked meanwhile', async () => {
    const holder = await pool.connect();
    await holder.query('BEGIN');
    await holder.query(`INSERT INTO ${A} VALUES (2)`);                     // ROW EXCLUSIVE on A, like any test writing a hot table
    let released = false;
    const started = Date.now();
    const proof = withExclusiveLocksNoWait(pool, { tables: [A, B] }, async () => { expect(released).toBe(true); return Date.now() - started; });
    await sleep(400);
    // a third connection reads and writes the table while the proof is "waiting": it must not be queued behind an ACCESS EXCLUSIVE request
    const t0 = Date.now();
    await pool.query(`SELECT count(*) FROM ${A}`);
    await pool.query(`INSERT INTO ${B} (id, a_id) VALUES (1, 1)`);
    expect(Date.now() - t0).toBeLessThan(300);
    released = true;
    await holder.query('ROLLBACK');
    holder.release();
    const elapsed = await proof;
    expect(elapsed).toBeGreaterThanOrEqual(400);                           // it genuinely waited for the holder, by retrying, not by queueing
    await pool.query(`DELETE FROM ${B}`);
  });

  it('cannot deadlock: against a transaction that takes the same tables in the opposite order, one side always finishes and nobody is aborted', async () => {
    for (let round = 0; round < 15; round++) {
      const other = await pool.connect();
      const results = await Promise.allSettled([
        withExclusiveLocksNoWait(pool, { tables: [A, B] }, async (c) => { await c.query(`SELECT 1 FROM ${A}`); await sleep(15); return 'proof'; }),
        (async () => {                                                      // opposite order: B then A, each held across a pause
          try {
            await other.query('BEGIN');
            await other.query(`INSERT INTO ${B} (id, a_id) VALUES (${100 + round}, 1)`);
            await sleep(15);
            await other.query(`INSERT INTO ${A} (id) VALUES (${1000 + round})`);
            await other.query('COMMIT');
            return 'other';
          } catch (e) { await other.query('ROLLBACK').catch(() => undefined); throw e; } finally { other.release(); }
        })(),
      ]);
      for (const r of results) expect(r.status, JSON.stringify(r)).toBe('fulfilled');
    }
    await pool.query(`DELETE FROM ${B}`);
    await pool.query(`DELETE FROM ${A} WHERE id <> 1`);
  }, 60_000);

  it('gives up with a clear error instead of hanging when the locks never become available', async () => {
    const holder = await pool.connect();
    await holder.query('BEGIN');
    await holder.query(`LOCK TABLE ${A} IN ROW EXCLUSIVE MODE`);
    try {
      await expect(withExclusiveLocksNoWait(pool, { tables: [A], maxWaitMs: 300 }, async () => 'never')).rejects.toThrow(/could not obtain the exclusive locks/);
    } finally { await holder.query('ROLLBACK'); holder.release(); }
  });

  it('does not swallow real errors: a failing proof statement or a missing table is thrown at once, not retried', async () => {
    await expect(withExclusiveLocksNoWait(pool, { tables: [A] }, async (c) => { await c.query('SELECT nope_not_a_function()'); })).rejects.toThrow(/nope_not_a_function/);
    await expect(withExclusiveLocksNoWait(pool, { tables: [`${SCHEMA}.missing`] }, async () => 'x')).rejects.toMatchObject({ code: '42P01' });
  });
});
