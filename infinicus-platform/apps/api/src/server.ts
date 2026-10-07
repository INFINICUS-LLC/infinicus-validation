import { loadConfig } from '@infinicus/configuration';
import { createPool } from '@infinicus/database';
import { buildApp } from './app.js';

async function main(): Promise<void> {
  const config = loadConfig();
  createPool({
    connectionString: config.databaseUrl,
    ssl: config.dbSsl,
    poolMin: config.dbPoolMin,
    poolMax: config.dbPoolMax,
    idleTimeoutMillis: config.dbIdleTimeoutMs,
    connectionTimeoutMillis: config.dbConnectionTimeoutMs,
    statementTimeoutMillis: config.dbStatementTimeoutMs,
    applicationName: '@infinicus/api',
  });

  const app = await buildApp(config);
  await app.listen({ port: config.port, host: '0.0.0.0' });
}

main().catch((err) => {
  // eslint-disable-next-line no-console -- last-resort startup failure, before the structured logger exists
  console.error('Failed to start INFINICUS API server', err);
  process.exit(1);
});
