/**
 * Live test for BUILD-26's DAST requirement
 * (infrastructure/deployment/scripts/dast-scan.sh). Boots the real
 * Fastify application via app.listen() (a genuine HTTP server) and runs
 * the actual script against it with curl — acceptance evidence that the
 * shippable DAST script works against a real running instance, mirroring
 * BUILD-23's smoke-test.integration.test.ts pattern exactly.
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

const DAST_SCAN_SH = resolve(__dirname, '../../../infrastructure/deployment/scripts/dast-scan.sh');
const PORT = 34522;

describe.runIf(run)('dast-scan.sh — live HTTP server', () => {
  let app: FastifyInstance | null = null;

  afterAll(async () => {
    await app?.close();
    await closePool();
  });

  it('passes every check against a real, listening apps/api instance', async () => {
    const config = loadConfig({ DATABASE_URL: process.env.DATABASE_URL!, NODE_ENV: 'test', LOG_LEVEL: 'silent', PORT: String(PORT) });
    createPool({ connectionString: config.databaseUrl, ssl: config.dbSsl });
    app = await buildApp(config);
    await app.listen({ port: PORT, host: '127.0.0.1' });

    const { stdout } = await execFileAsync('bash', [DAST_SCAN_SH], {
      env: { ...process.env, BASE_URL: `http://127.0.0.1:${PORT}` },
    });
    expect(stdout).toContain('DAST scan passed');
    expect(stdout).not.toContain('FAIL:');
  }, 30_000);
});

describe.skipIf(run)('dast-scan.sh — live HTTP server (skipped, no DATABASE_URL)', () => {
  it('skips live tests when DATABASE_URL is not set', () => {
    expect(run).toBe(false);
  });
});


