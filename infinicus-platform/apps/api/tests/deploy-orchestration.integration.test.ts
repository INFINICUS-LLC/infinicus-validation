/**
 * Live test for BUILD-23's promotion-gate + deployment-audit
 * requirement: infrastructure/deployment/scripts/deploy.sh, run for
 * real (not reimplemented) against a genuinely running apps/api
 * instance and the real platform.deployment_events table.
 *
 * Requires:
 *   DATABASE_URL       — app_test_user (RLS enforced), boots the real
 *     apps/api server exactly like every other live test in this suite.
 *   ADMIN_DATABASE_URL — infinicus_test_admin, passed to deploy.sh
 *     itself for the migration-gate step, which needs migration
 *     privileges the least-privilege app role deliberately lacks (same
 *     requirement documented on migration-gate.sh/backup.sh). Falls back
 *     to DATABASE_URL if unset.
 *
 * Guard pattern: describe.runIf(!!process.env.DATABASE_URL)
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@infinicus/configuration';
import { createPool, closePool, DeploymentEventRepository } from '@infinicus/database';
import { buildApp } from '../src/app.js';

const execFileAsync = promisify(execFile);
const run = !!process.env.DATABASE_URL;

const DEPLOY_SH = resolve(__dirname, '../../../infrastructure/deployment/scripts/deploy.sh');
const PORT = 34128;
const DEPLOYED_BY = `vitest-${Date.now()}`;
const DEPLOY_DATABASE_URL = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;

describe.runIf(run)('deploy.sh — live orchestration', () => {
  let app: FastifyInstance | null = null;

  afterAll(async () => {
    await app?.close();
    await closePool();
  });

  it('runs migration gate + smoke test and records a succeeded deployment_events row', async () => {
    const config = loadConfig({ DATABASE_URL: process.env.DATABASE_URL!, NODE_ENV: 'test', LOG_LEVEL: 'silent', PORT: String(PORT) });
    createPool({ connectionString: config.databaseUrl, ssl: config.dbSsl });
    app = await buildApp(config);
    await app.listen({ port: PORT, host: '127.0.0.1' });

    const { stdout } = await execFileAsync('bash', [DEPLOY_SH], {
      env: {
        ...process.env,
        ENVIRONMENT: 'test',
        DATABASE_URL: DEPLOY_DATABASE_URL,
        BASE_URL: `http://127.0.0.1:${PORT}`,
        DEPLOYED_BY,
      },
    });
    expect(stdout).toMatch(/Deployment .* to test succeeded/);

    const idMatch = stdout.match(/deployment_events id: ([0-9a-f-]+)/);
    expect(idMatch).not.toBeNull();
    const repo = new DeploymentEventRepository();
    const event = await repo.getById(idMatch![1]);
    expect(event.status).toBe('succeeded');
    expect(event.environment).toBe('test');
    expect(event.deployedBy).toBe(DEPLOYED_BY);
  }, 30_000);

  it('records a failed deployment_events row when the smoke test fails (nothing listening)', async () => {
    let caught: { stdout?: string; stderr?: string } | undefined;
    try {
      await execFileAsync('bash', [DEPLOY_SH], {
        env: {
          ...process.env,
          ENVIRONMENT: 'test',
          DATABASE_URL: DEPLOY_DATABASE_URL,
          BASE_URL: 'http://127.0.0.1:34199', // nothing listening here
          DEPLOYED_BY,
        },
      });
    } catch (err) {
      caught = err as { stdout?: string; stderr?: string };
    }
    expect(caught, 'deploy.sh should have exited non-zero').toBeDefined();
    expect(caught?.stderr).toContain('Smoke test FAILED');

    const repo = new DeploymentEventRepository();
    const recent = await repo.listForEnvironment('test', 10);
    const failedOne = recent.find((e) => e.deployedBy === DEPLOYED_BY && e.status === 'failed');
    expect(failedOne).toBeDefined();
    expect(failedOne?.notes).toBe('smoke test failed');
  }, 30_000);
});

describe.skipIf(run)('deploy.sh — live orchestration (skipped, no DATABASE_URL)', () => {
  it('skips live tests when DATABASE_URL is not set', () => {
    expect(run).toBe(false);
  });
});


