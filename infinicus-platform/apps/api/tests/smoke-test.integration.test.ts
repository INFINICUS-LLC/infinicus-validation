/**
 * Live test for BUILD-23's smoke-test requirement
 * (infrastructure/deployment/scripts/smoke-test.sh). Boots the real
 * Fastify application via app.listen() (a genuine HTTP server, not
 * app.inject()) and runs the actual script against it with curl — this
 * is acceptance evidence that the shippable smoke-test script works
 * against a real running instance, not a reimplementation of its checks.
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

const SMOKE_TEST_SH = resolve(__dirname, '../../../infrastructure/deployment/scripts/smoke-test.sh');
const PORT = 34127;

describe.runIf(run)('smoke-test.sh — live HTTP server', () => {
  let app: FastifyInstance | null = null;

  afterAll(async () => {
    await app?.close();
    await closePool();
  });

  it('passes against a real, listening apps/api instance', async () => {
    const config = loadConfig({ DATABASE_URL: process.env.DATABASE_URL!, NODE_ENV: 'test', LOG_LEVEL: 'silent', PORT: String(PORT) });
    createPool({ connectionString: config.databaseUrl, ssl: config.dbSsl });
    app = await buildApp(config);
    await app.listen({ port: PORT, host: '127.0.0.1' });

    const { stdout } = await execFileAsync('bash', [SMOKE_TEST_SH], {
      env: { ...process.env, BASE_URL: `http://127.0.0.1:${PORT}` },
    });
    expect(stdout).toContain('Smoke test passed');
  }, 30_000);

  it('fails loudly (non-zero exit, no response) against an unreachable instance', async () => {
    let caught: { code?: number; stdout?: string; stderr?: string } | undefined;
    try {
      await execFileAsync('bash', [SMOKE_TEST_SH], {
        env: { ...process.env, BASE_URL: 'http://127.0.0.1:34199' }, // nothing listening here
      });
    } catch (err) {
      caught = err as { code?: number; stdout?: string; stderr?: string };
    }
    expect(caught, 'smoke-test.sh should have exited non-zero').toBeDefined();
    expect(caught?.stderr).toMatch(/FAIL: GET \/v1\/health expected 200, got 000/);
  }, 15_000);
});

describe.skipIf(run)('smoke-test.sh — live HTTP server (skipped, no DATABASE_URL)', () => {
  it('skips live tests when DATABASE_URL is not set', () => {
    expect(run).toBe(false);
  });
});


