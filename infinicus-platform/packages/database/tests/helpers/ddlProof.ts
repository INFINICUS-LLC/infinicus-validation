/**
 * Running DDL proofs (a documented rollback, a re-applied migration) against the SHARED test database without ever waiting for a lock.
 *
 * WHY: every package's live-database tests run against one database at the same time. A migration rollback is a handful of ACCESS EXCLUSIVE
 * statements on hot tables (the 0210 rollback locks tenancy.tenants, tenancy.workspaces, identity.users, platform.businesses, platform.orders and
 * business_operations.register_sessions, measured with pg_locks). Taking them one statement at a time while other tests hold row locks on the same tables
 * (a) can form a lock-order cycle, so PostgreSQL aborts one side with "deadlock detected" and the victim can be an UNRELATED test, and (b) while the
 * request waits in the lock queue it blocks every later reader of those tables, which surfaced as 5 s test timeouts in other packages.
 *
 * HOW: take every lock the proof needs up front, in ONE statement, with NOWAIT. A transaction that never waits while holding a lock has no waits-for
 * edge, so it can neither deadlock nor stall anyone; if any lock is busy the whole attempt is rolled back (releasing everything) and retried after a
 * short jittered pause. Once the locks are held the DDL statements wait for nothing and finish in milliseconds. Nothing about what is asserted changes.
 */
import type { Pool, PoolClient } from 'pg';

export interface DdlProofOptions {
  /** Schema-qualified tables the proof's statements will lock exclusively (list EVERY table, including foreign-key parents; verify with pg_locks). */
  tables: string[];
  /** Give up (fail the test) after this long without ever obtaining the locks. */
  maxWaitMs?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `proof` inside a transaction that already holds ACCESS EXCLUSIVE locks on `tables`. The transaction is ALWAYS rolled back afterwards, so a proof
 * that must leave nothing behind needs no cleanup; if `proof` itself COMMITs (a re-applied migration does), that is its own business.
 */
export async function withExclusiveLocksNoWait<R>(pool: Pool, options: DdlProofOptions, proof: (client: PoolClient) => Promise<R>): Promise<R> {
  const deadline = Date.now() + (options.maxWaitMs ?? 90_000);
  const lockSql = `LOCK TABLE ${options.tables.join(', ')} IN ACCESS EXCLUSIVE MODE NOWAIT`;
  for (let attempt = 1; ; attempt++) {
    const client = await pool.connect();
    let obtained = false;
    try {
      await client.query('BEGIN');
      try {
        await client.query(lockSql);
        obtained = true;
      } catch (error) {
        if ((error as { code?: string }).code !== '55P03') throw error;       // only "lock not available" is contention; anything else is a real error
      }
      if (obtained) return await proof(client);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
    if (Date.now() > deadline) throw new Error(`could not obtain the exclusive locks on ${options.tables.join(', ')} within ${options.maxWaitMs ?? 90_000} ms (attempt ${attempt}); other tests kept them busy`);
    await sleep(40 + Math.floor(Math.random() * 160));
  }
}

/**
 * Re-applies a migration script (it carries its own BEGIN/COMMIT) against the shared test database without ever waiting for a lock.
 *
 * A re-applied migration is DDL on the table it guards (DROP/CREATE TRIGGER, ALTER TABLE, CREATE OR REPLACE FUNCTION), which needs strong locks that other
 * packages' tests hold while they write the same hot tables. Waiting in the lock queue for them stalled those tests and, taking the locks one statement at a
 * time, formed lock-order cycles ("deadlock detected"). Here a lock wait longer than `lockTimeoutMs` aborts the whole script (it is one implicit transaction,
 * so nothing is left half-applied), and it is retried after a short jittered pause. The 50 ms cap is far below PostgreSQL's 1 s deadlock check, so this
 * session can never be chosen as a deadlock victim, and it never holds up a later reader for more than 50 ms. The migration is idempotent by design, which is
 * what the tests using this prove; a real error (anything other than 55P03 lock not available / 40P01 deadlock / the transient catalog race below) is thrown at once.
 */
export async function runMigrationWithoutWaiting(pool: Pool, sql: string, options: { lockTimeoutMs?: number; maxWaitMs?: number } = {}): Promise<void> {
  const lockTimeoutMs = options.lockTimeoutMs ?? 50;
  const maxWaitMs = options.maxWaitMs ?? 90_000;
  const deadline = Date.now() + maxWaitMs;
  for (let attempt = 1; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query(`SET lock_timeout = ${Math.trunc(lockTimeoutMs)}`);
      await client.query(sql);
      return;
    } catch (error) {
      const code = (error as { code?: string }).code;
      // 'tuple concurrently updated' (XX000) is PostgreSQL's catalog race when two sessions CREATE OR REPLACE the same function at once. Six migrations replace
      // business_operations.forbid_mutation and different suites re-apply them in parallel, so it is transient here; the script is idempotent and is retried.
      const catalogRace = code === 'XX000' && /tuple concurrently updated/.test((error as Error).message);
      if ((code !== '55P03' && code !== '40P01' && !catalogRace) || Date.now() > deadline) throw error;
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);          // a script that failed part-way leaves the session in an aborted transaction
      await client.query('RESET lock_timeout').catch(() => undefined);
      client.release();
    }
    await sleep(30 + Math.floor(Math.random() * 120));
  }
}
