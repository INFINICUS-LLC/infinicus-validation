/**
 * Test helper: asserts that a TRUNCATE of a shared, append-only table is refused WITHOUT convoying every other test file.
 *
 * Why it exists: PostgreSQL takes the ACCESS EXCLUSIVE lock BEFORE it runs the BEFORE TRUNCATE trigger that refuses the statement (or before the
 * "referenced in a foreign key" check). If that lock has to wait for an in-flight transaction of a concurrently running test file, every new
 * statement on the table queues behind the waiting TRUNCATE - plain SELECTs included - and a wait cycle (the in-flight transaction needs
 * something a queued session holds) stalls both until the deadlock detector or the 30 s statement timeout fires. That produced the P0-6f CI
 * failures ("Test timed out in 5000ms", an engine attempt aborted as OPERATIONAL_ERROR) and is reproducible by issuing the refused TRUNCATE
 * repeatedly while the end-to-end suites run.
 *
 * How: the statement runs on its own session with a 100 ms `lock_timeout`, so it can never keep the queue closed (or sit in a wait cycle)
 * for longer than that; if the lock was not obtainable it is retried until the real refusal is seen. The assertion is unchanged: the returned
 * promise REJECTS with the database's own refusal error (so callers keep `rejects.toThrow(<the append-only message>)`), and it throws if the
 * TRUNCATE ever succeeds or the lock is never obtained.
 */
import type { Pool } from 'pg';

const LOCK_NOT_AVAILABLE = '55P03';
const ATTEMPTS = 40;

export async function truncateRefusal(pool: Pick<Pool, 'connect'>, sql: string): Promise<never> {
  const client = await pool.connect();
  try {
    await client.query("SET lock_timeout = '100ms'");
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      try {
        await client.query(sql);
      } catch (error) {
        if ((error as { code?: string }).code === LOCK_NOT_AVAILABLE) {
          await new Promise((resolve) => setTimeout(resolve, 20 + Math.floor(Math.random() * 30)));
          continue;
        }
        throw error; // the database's own refusal: exactly what the caller asserts on
      }
      throw new Error(`the TRUNCATE succeeded but must be refused: ${sql}`);
    }
    throw new Error(`the TRUNCATE could not obtain its lock in ${ATTEMPTS} attempts: ${sql}`);
  } finally {
    await client.query('RESET lock_timeout').catch(() => undefined);
    client.release();
  }
}
