/**
 * Live PostgreSQL 16 test for BUILD-22's readiness-endpoint requirement
 * (GET /v1/ready — distinct from GET /v1/health's pure liveness check).
 *
 * Kept in its own test file (not apps/api/tests/api.integration.test.ts)
 * deliberately: @infinicus/database's connection pool is a process-wide
 * module singleton (createPool()/getPool()), not scoped per Fastify app
 * instance — swapping it to a deliberately broken pool to exercise the
 * 503 path would corrupt the shared pool every other test in
 * api.integration.test.ts relies on. Vitest gives each test file its own
 * module registry, so isolating this here avoids that risk entirely.
 *
 * Requires:
 *   DATABASE_URL — a real, reachable Postgres connection string.
 *
 * Guard pattern: describe.runIf(!!process.env.DATABASE_URL)
 */
import { describe, it, expect, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@infinicus/configuration';
import { createPool, closePool } from '@infinicus/database';
import { buildApp } from '../src/app.js';

const run = !!process.env.DATABASE_URL;

describe.runIf(run)('GET /v1/ready — live PostgreSQL', () => {
  let app: FastifyInstance | null = null;

  afterAll(async () => {
    await app?.close();
    await closePool();
  });

  it('returns 200 with pool stats when the database is reachable', async () => {
    const config = loadConfig({ DATABASE_URL: process.env.DATABASE_URL!, NODE_ENV: 'test', LOG_LEVEL: 'silent' });
    createPool({ connectionString: config.databaseUrl, ssl: config.dbSsl });
    app = await buildApp(config);
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/v1/ready' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ready');
    expect(body.pool).toMatchObject({
      totalCount: expect.any(Number),
      idleCount: expect.any(Number),
      waitingCount: expect.any(Number),
    });
  });

  it('returns 503 when the database is unreachable', async () => {
    await app?.close();
    await closePool();

    const config = loadConfig({
      DATABASE_URL: 'postgresql://nonexistent_user:wrong_pw@127.0.0.1:59999/nonexistent_db',
      NODE_ENV: 'test', LOG_LEVEL: 'silent',
      DB_CONNECTION_TIMEOUT_MS: '500',
    });
    createPool({ connectionString: config.databaseUrl, connectionTimeoutMillis: config.dbConnectionTimeoutMs, ssl: config.dbSsl });
    app = await buildApp(config);
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/v1/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json().status).toBe('not_ready');
  }, 15_000);
});

describe.skipIf(run)('GET /v1/ready — live PostgreSQL (skipped, no DATABASE_URL)', () => {
  it('skips live tests when DATABASE_URL is not set', () => {
    expect(run).toBe(false);
  });
});


