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

function resolveDbSsl(env: NodeJS.ProcessEnv, databaseUrl: string, resolvedEnv: InfinicusConfig['env']): boolean {
  const raw = env.DB_SSL;
  if (raw !== undefined) return raw === 'true' || raw === '1';

  // DB_SSL wasn't set explicitly. Previously this silently guessed `true`
  // for any non-localhost hostname — but plenty of real non-localhost
  // Postgres targets (a Docker Compose service name, a private VPC host)
  // don't speak TLS at all, so that guess caused a full outage once a
  // deploy used one. Guessing wrong here means either a refused connection
  // or, worse, a connection that silently drops TLS protection — both are
  // unacceptable to leave to a guess in a real deployment, so this now
  // fails closed exactly like every other required value in this file.
  if (resolvedEnv === 'production' || resolvedEnv === 'staging') {
    throw new ConfigurationError(
      'DB_SSL is not set. Set it explicitly ("true" or "false") for production/staging — ' +
        'this value is not guessed from the database hostname.'
    );
  }

  // Local development/test only: keep the old heuristic as a convenience
  // (most devs never set DB_SSL for a local Postgres), but make the guess
  // visible instead of silent so a misconfigured non-local dev DB is caught
  // early rather than discovered as a connection failure.
  try {
    const host = new URL(databaseUrl).hostname;
    const guessed = host !== 'localhost' && host !== '127.0.0.1';
    if (guessed) {
      // eslint-disable-next-line no-console
      console.warn(
        `[configuration] DB_SSL not set; guessing dbSsl=true because DATABASE_URL host "${host}" isn't localhost. ` +
          'Set DB_SSL explicitly to silence this warning and avoid relying on the guess.'
      );
    }
    return guessed;
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
    dbSsl: resolveDbSsl(env, databaseUrl, resolvedEnv),
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