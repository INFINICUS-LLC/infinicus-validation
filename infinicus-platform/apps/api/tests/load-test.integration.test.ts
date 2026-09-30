/**
 * Live test for BUILD-27's API-throughput/concurrent-users requirement:
 * infrastructure/deployment/scripts/load-test.mjs. Boots the real
 * Fastify application via app.listen() (a genuine HTTP server) and runs
 * the actual load-test script against it — acceptance evidence that the
 * shippable load-test tool produces real, sane numbers against a real
 * running instance, mirroring BUILD-23/26's smoke-test/dast-scan
 * integration-test pattern.
 *
 * Requires:
 *   DATABASE_URL — a real, reachable Postgres connection string.
 *
 * Guard pattern: describe.runIf(!!process.env.DATABASE_URL)
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@infinicus/configuration';
import { createPool, closePool } from '@infinicus/database';
import { buildApp } from '../src/app.js';

const execFileAsync = promisify(execFile);
const run = !!process.env.DATABASE_URL;

const LOAD_TEST_MJS = resolve(__dirname, '../../../infrastructure/deployment/scripts/load-test.mjs');
const PORT = 34533;

describe.runIf(run)('load-test.mjs — live HTTP server', () => {
  let app: FastifyInstance | null = null;

  afterAll(async () => {
    await app?.close();
    await closePool();
  });

  it('measures real throughput and 100% success against a real, listening apps/api instance', async () => {
    const config = loadConfig({
      DATABASE_URL: process.env.DATABASE_URL!, NODE_ENV: 'test', LOG_LEVEL: 'silent',
      PORT: String(PORT), RATE_LIMIT_MAX: '100000',
    });
    createPool({ connectionString: config.databaseUrl, ssl: config.dbSsl });
    app = await buildApp(config);
    await app.listen({ port: PORT, host: '127.0.0.1' });

    const { stdout } = await execFileAsync('node', [LOAD_TEST_MJS, '/v1/health'], {
      env: { ...process.env, BASE_URL: `http://127.0.0.1:${PORT}`, CONCURRENCY: '10', REQUESTS: '100' },
    });
    const report = JSON.parse(stdout.slice(stdout.indexOf('{')));
    expect(report.totalRequests).toBe(100);
    expect(report.failureCount).toBe(0);
    expect(report.throughputReqPerSec).toBeGreaterThan(0);
    expect(report.latencyMs.p50).toBeGreaterThan(0);
  }, 30_000);
});

describe.skipIf(run)('load-test.mjs — live HTTP server (skipped, no DATABASE_URL)', () => {
  it('skips live tests when DATABASE_URL is not set', () => {
    expect(run).toBe(false);
  });
});


