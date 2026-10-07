import { Pool, type PoolClient, type PoolConfig, type QueryResult } from 'pg';

let pool: Pool | null = null;

export interface DbConfig {
  connectionString: string;
  poolMin?: number;
  poolMax?: number;
  ssl?: boolean;
  /** Milliseconds an idle client sits in the pool before being closed. */
  idleTimeoutMillis?: number;
  /** Milliseconds to wait for a connection to be established before failing. */
  connectionTimeoutMillis?: number;
  /** Milliseconds before Postgres itself cancels a running statement (server-side `statement_timeout`, set per-session via `options`). */
  statementTimeoutMillis?: number;
  /** Reported to Postgres as `application_name`, visible in `pg_stat_activity` — useful for identifying which service/instance holds a connection. */
  applicationName?: string;
}

export interface PoolStats {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
}

export interface TenantContext {
  tenantId:    string;
  workspaceId: string;
  userId:      string;
}

export function createPool(config: DbConfig): Pool {
  if (pool) {
    // A previous createPool() call left a pool assigned here — close it so
    // its connections don't leak. Fire-and-forget: we don't want createPool()
    // to become async and force every call site to change.
    const stale = pool;
    stale.end().catch((err) => {
      console.error('[db] error closing stale pool', err);
    });
  }
  const statementTimeoutMs = config.statementTimeoutMillis ?? 30_000;
  const opts: PoolConfig = {
    connectionString: config.connectionString,
    min: config.poolMin ?? 2,
    max: config.poolMax ?? 10,
    ssl: config.ssl ? { rejectUnauthorized: false } : false,
    idleTimeoutMillis: config.idleTimeoutMillis ?? 30_000,
    connectionTimeoutMillis: config.connectionTimeoutMillis ?? 5_000,
    application_name: config.applicationName ?? 'infinicus',
    // Server-side backstop against a runaway/hung query holding a connection
    // indefinitely — set per-session via libpq startup options, same
    // mechanism `pg` uses for `application_name`.
    options: `-c statement_timeout=${statementTimeoutMs}`,
  };
  pool = new Pool(opts);
  pool.on('error', (err) => {
    console.error('[db] idle client error', err);
  });
  return pool;
}

export function getPool(): Pool {
  if (!pool) throw new Error('Database pool not initialised — call createPool() first.');
  return pool;
}

/** Point-in-time pool utilization — used by the readiness endpoint and operational monitoring. */
export function poolStats(): PoolStats {
  const p = getPool();
  return { totalCount: p.totalCount, idleCount: p.idleCount, waitingCount: p.waitingCount };
}

export async function query<T extends Record<string, unknown> = Record<string, unknown>>(
  sql: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  return getPool().query<T>(sql, params);
}

export async function closePool(): Promise<void> {
  if (pool) { await pool.end(); pool = null; }
}

export async function getDatabasePool(): Promise<Pool> {
  return getPool();
}

export async function closeDatabasePool(): Promise<void> {
  return closePool();
}

export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function withTenantTransaction<T>(
  ctx: TenantContext,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  return withTransaction(async (client) => {
    await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id',    ctx.tenantId]);
    await client.query('SELECT set_config($1, $2, true)', ['app.workspace_id', ctx.workspaceId]);
    await client.query('SELECT set_config($1, $2, true)', ['app.user_id',      ctx.userId]);
    return fn(client);
  });
}