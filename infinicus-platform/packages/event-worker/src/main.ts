/**
 * Event worker PROCESS entry point (P0-6b). Run as its own process/container (infrastructure/deployment/event-worker); the API never
 * starts, polls or schedules it. Refuses to start unless every setting is present (see config.ts). Starting this process does NOT enable
 * the authorized-action pipeline: the execution capability gate is separate and closed until the governed activation (P0-6e) exists.
 *
 * Logs one JSON line per notable event: counts and ids only, never payloads, parameters or credentials.
 */
import { Pool } from 'pg';
import { closePool, createPool } from '@infinicus/database';
import { SqlScopeDiscovery } from './ScopeDiscovery.js';
import { WorkerConfigError, loadWorkerConfig } from './config.js';
import { buildEventWorker } from './compose.js';

const log = (level: 'info' | 'error', message: string, fields: Record<string, unknown> = {}): void => {
  process.stdout.write(`${JSON.stringify({ level, message, at: new Date().toISOString(), ...fields })}\n`);
};

async function main(): Promise<void> {
  let config;
  try {
    config = loadWorkerConfig(process.env);
  } catch (error) {
    if (error instanceof WorkerConfigError) { log('error', 'event worker refused to start', { problems: error.problems }); process.exitCode = 2; return; }
    throw error;
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) { log('error', 'event worker refused to start', { problems: ['DATABASE_URL is required'] }); process.exitCode = 2; return; }

  createPool({ connectionString: databaseUrl });
  const discoveryPool = new Pool({ connectionString: config.discoveryDatabaseUrl, max: 1 });
  const worker = buildEventWorker({
    config,
    discovery: new SqlScopeDiscovery(discoveryPool),
    onScopeError: (scope, error) => log('error', 'scope dispatch failed', { tenantId: scope.tenantId, workspaceId: scope.workspaceId, error: error instanceof Error ? error.name : 'error' }),
  });

  const abort = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { log('info', 'event worker stopping', { signal }); abort.abort(); });
  log('info', 'event worker started', { workerId: config.workerId });
  try {
    await worker.run(abort.signal, config.pollIntervalMs);
  } finally {
    await discoveryPool.end().catch(() => undefined);
    await closePool().catch(() => undefined);
    log('info', 'event worker stopped', { workerId: config.workerId });
  }
}

main().catch((error) => { log('error', 'event worker crashed', { error: error instanceof Error ? error.name : 'error' }); process.exitCode = 1; });
