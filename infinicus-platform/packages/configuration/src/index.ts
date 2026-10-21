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
  /**
   * Fastify `trustProxy` value. `false` (default) = use the socket address.
   * A positive integer = trust that many proxy hops (the deployment's Caddy is
   * exactly one hop). A list = trust only these proxy IPs/CIDRs. Never `true`.
   */
  trustProxy: false | number | string[];
  /** Webhook intake: max requests per source IP per window across ALL connectors. */
  webhookRateLimitIpMax: number;
  /** Webhook intake: max requests per source IP + connector (token prefix) per window. */
  webhookRateLimitConnectorMax: number;
  webhookRateLimitWindowMs: number;
  dbPoolMin: number;
  dbPoolMax: number;
  dbIdleTimeoutMs: number;
  dbConnectionTimeoutMs: number;
  dbStatementTimeoutMs: number;
  corsAllowedOrigins: string[];
  /**
   * OFF-1 offline selling (POST /v1/businesses/:businessId/offline-sales). Both values are OWNER inputs and have no defaults:
   *   futureToleranceSeconds  null = offline selling is NOT ENABLED (the route answers 503); a number = how far a device clock may run ahead of the server.
   *   driftLimitMinorByCurrency  D4 price-drift tolerance per currency in minor units; a currency that is not listed has limit 0 (every difference goes to review).
   */
  offlineSales: { futureToleranceSeconds: number | null; driftLimitMinorByCurrency: Readonly<Record<string, number>> };
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

const TRUST_PROXY_MAX_HOPS = 5;
const PROXY_ADDRESS_PATTERN = /^[0-9a-fA-F:.]+(\/\d{1,3})?$/;

/**
 * TRUST_PROXY decides whose X-Forwarded-For the API believes. Trusting too
 * much lets any client forge its IP (and sidestep or poison rate limiting);
 * trusting nothing behind a reverse proxy collapses every client into the
 * proxy's single address. Hence: default off, explicit hop count or explicit
 * address list, and the catch-all `true` is rejected.
 */
export function parseTrustProxy(raw: string | undefined): false | number | string[] {
  const value = raw?.trim();
  if (!value || value.toLowerCase() === 'false' || value === '0') return false;
  if (value.toLowerCase() === 'true') {
    throw new ConfigurationError(
      'TRUST_PROXY=true is not allowed (it trusts every client-supplied X-Forwarded-For). ' +
      `Use a hop count (e.g. 1 for a single reverse proxy) or a comma-separated list of proxy IPs/CIDRs.`
    );
  }
  if (/^\d+$/.test(value)) {
    const hops = Number(value);
    if (hops < 1 || hops > TRUST_PROXY_MAX_HOPS) {
      throw new ConfigurationError(`TRUST_PROXY hop count must be between 1 and ${TRUST_PROXY_MAX_HOPS}, got: ${value}`);
    }
    return hops;
  }
  const entries = value.split(',').map((e) => e.trim()).filter((e) => e.length > 0);
  if (entries.length === 0 || !entries.every((e) => PROXY_ADDRESS_PATTERN.test(e))) {
    throw new ConfigurationError(`TRUST_PROXY must be false, a hop count, or a comma-separated list of IPs/CIDRs, got: ${value}`);
  }
  return entries;
}

function positiveInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const value = optionalInt(env, key, fallback);
  if (!Number.isInteger(value) || value < 1) {
    throw new ConfigurationError(`Environment variable ${key} must be a positive integer, got: ${env[key]}`);
  }
  return value;
}

const OFFLINE_FUTURE_TOLERANCE_MAX_SECONDS = 3600;
const OFFLINE_DRIFT_LIMIT_MAX_MINOR = 1_000_000_000;

/**
 * OFFLINE_SALES_FUTURE_TOLERANCE_SECONDS: unset or empty = offline selling is not enabled. Otherwise a whole number of seconds from 0 to 3600.
 * OFFLINE_SALES_DRIFT_LIMITS: unset or empty = no drift is ever honoured. Otherwise a JSON object such as {"KWD":500} mapping an upper-case currency
 * code to a whole non-negative number of minor units. Anything else refuses to start; the value itself is never echoed.
 */
export function parseOfflineSales(env: NodeJS.ProcessEnv): InfinicusConfig['offlineSales'] {
  const rawTolerance = env.OFFLINE_SALES_FUTURE_TOLERANCE_SECONDS?.trim();
  let futureToleranceSeconds: number | null = null;
  if (rawTolerance) {
    if (!/^\d{1,4}$/.test(rawTolerance) || Number(rawTolerance) > OFFLINE_FUTURE_TOLERANCE_MAX_SECONDS) {
      throw new ConfigurationError(`OFFLINE_SALES_FUTURE_TOLERANCE_SECONDS must be a whole number of seconds from 0 to ${OFFLINE_FUTURE_TOLERANCE_MAX_SECONDS}`);
    }
    futureToleranceSeconds = Number(rawTolerance);
  }
  const rawLimits = env.OFFLINE_SALES_DRIFT_LIMITS?.trim();
  const driftLimitMinorByCurrency: Record<string, number> = {};
  if (rawLimits) {
    let parsed: unknown;
    try { parsed = JSON.parse(rawLimits); } catch { throw new ConfigurationError('OFFLINE_SALES_DRIFT_LIMITS must be a JSON object such as {"KWD":500}'); }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ConfigurationError('OFFLINE_SALES_DRIFT_LIMITS must be a JSON object such as {"KWD":500}');
    }
    for (const [code, limit] of Object.entries(parsed as Record<string, unknown>)) {
      if (!/^[A-Z]{3}$/.test(code) || typeof limit !== 'number' || !Number.isInteger(limit) || limit < 0 || limit > OFFLINE_DRIFT_LIMIT_MAX_MINOR) {
        throw new ConfigurationError(`OFFLINE_SALES_DRIFT_LIMITS: each key must be an upper-case currency code and each value a whole number of minor units from 0 to ${OFFLINE_DRIFT_LIMIT_MAX_MINOR}`);
      }
      driftLimitMinorByCurrency[code] = limit;
    }
  }
  return { futureToleranceSeconds, driftLimitMinorByCurrency };
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
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    // TEST DEFAULTS, NOT PRODUCTION VALUES. No production webhook volume is
    // known or documented. These are deliberately conservative placeholders
    // (2 requests/second sustained per connector per source IP; a batch array
    // is one request) until real sender volume is measured; set the
    // WEBHOOK_RATE_LIMIT_* variables per environment once it is.
    webhookRateLimitIpMax: positiveInt(env, 'WEBHOOK_RATE_LIMIT_IP_MAX', 300),
    webhookRateLimitConnectorMax: positiveInt(env, 'WEBHOOK_RATE_LIMIT_CONNECTOR_MAX', 120),
    webhookRateLimitWindowMs: positiveInt(env, 'WEBHOOK_RATE_LIMIT_WINDOW_MS', 60_000),
    dbPoolMin: optionalInt(env, 'DB_POOL_MIN', 2),
    dbPoolMax: optionalInt(env, 'DB_POOL_MAX', 10),
    dbIdleTimeoutMs: optionalInt(env, 'DB_IDLE_TIMEOUT_MS', 30_000),
    dbConnectionTimeoutMs: optionalInt(env, 'DB_CONNECTION_TIMEOUT_MS', 5_000),
    dbStatementTimeoutMs: optionalInt(env, 'DB_STATEMENT_TIMEOUT_MS', 30_000),
    corsAllowedOrigins: (env.CORS_ALLOWED_ORIGINS ?? 'https://infini-cus.com,https://www.infini-cus.com')
      .split(',').map((o) => o.trim()).filter((o) => o.length > 0),
    offlineSales: parseOfflineSales(env),
  };
}