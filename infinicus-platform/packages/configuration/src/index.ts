// Configuration loader — reads process.env once, fails closed on missing required values.
import { ConfigurationError } from './errors.js';
import { looksLikeLocalOrTestCredential } from './secrets.js';

export { ConfigurationError } from './errors.js';
export {
  SECRET_INVENTORY,
  SECRET_REDACTION_LOG_PATHS,
  EnvSecretProvider,
  validateSecretInventory,
  looksLikeLocalOrTestCredential,
  redactSecretValues,
} from './secrets.js';
export type { SecretClassification, SecretDefinition, SecretProvider } from './secrets.js';

export interface InfinicusConfig {
  env: 'development' | 'staging' | 'production' | 'test';
  databaseUrl: string;
  dbSsl: boolean;
  port: number;
  logLevel: string;
  rateLimitMax: number;
  rateLimitWindowMs: number;
  dbPoolMin: number;
  dbPoolMax: number;
  dbIdleTimeoutMs: number;
  dbConnectionTimeoutMs: number;
  dbStatementTimeoutMs: number;
  corsAllowedOrigins: string[];
}

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new ConfigurationError(`Missing required environment variable: ${key}`);
  return value;
}

function optionalInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new ConfigurationError(`Environment variable ${key} must be a number, got: ${raw}`);
  return parsed;
}

function resolveDbSsl(env: NodeJS.ProcessEnv, databaseUrl: string): boolean {
  const raw = env.DB_SSL;
  if (raw !== undefined) return raw === 'true' || raw === '1';
  try {
    const host = new URL(databaseUrl).hostname;
    return host !== 'localhost' && host !== '127.0.0.1';
  } catch {
    return true;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): InfinicusConfig {
  const nodeEnv = env.NODE_ENV;
  const resolvedEnv: InfinicusConfig['env'] =
    nodeEnv === 'production' || nodeEnv === 'staging' || nodeEnv === 'test' ? nodeEnv : 'development';

  const databaseUrl = requireEnv(env, 'DATABASE_URL');

  if (resolvedEnv === 'production' && looksLikeLocalOrTestCredential(databaseUrl)) {
    throw new ConfigurationError(
      'DATABASE_URL looks like a local/test credential (matches a known dev or CI pattern) but NODE_ENV is production — refusing to start.'
    );
  }

  return {
    env: resolvedEnv,
    databaseUrl,
    dbSsl: resolveDbSsl(env, databaseUrl),
    port: optionalInt(env, 'PORT', 3000),
    logLevel: env.LOG_LEVEL ?? (resolvedEnv === 'production' ? 'info' : 'debug'),
    rateLimitMax: optionalInt(env, 'RATE_LIMIT_MAX', 100),
    rateLimitWindowMs: optionalInt(env, 'RATE_LIMIT_WINDOW_MS', 60_000),
    dbPoolMin: optionalInt(env, 'DB_POOL_MIN', 2),
    dbPoolMax: optionalInt(env, 'DB_POOL_MAX', 10),
    dbIdleTimeoutMs: optionalInt(env, 'DB_IDLE_TIMEOUT_MS', 30_000),
    dbConnectionTimeoutMs: optionalInt(env, 'DB_CONNECTION_TIMEOUT_MS', 5_000),
    dbStatementTimeoutMs: optionalInt(env, 'DB_STATEMENT_TIMEOUT_MS', 30_000),
    corsAllowedOrigins: (env.CORS_ALLOWED_ORIGINS ?? 'https://infini-cus.com,https://www.infini-cus.com')
      .split(',').map((o) => o.trim()).filter((o) => o.length > 0),
  };
}