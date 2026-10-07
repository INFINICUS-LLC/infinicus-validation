// Secret inventory and redaction — BUILD-24. A declarative schema of every
// environment variable this platform's server-side code actually reads
// (verified against `apps/api`/`packages/database` source, not guessed),
// classifying which ones are secrets, who owns them, and their rotation
// policy. Drives startup validation, log/error redaction, and the
// browser-secret-prevention check (infrastructure/deployment/scripts/
// check-no-browser-secrets.mjs).

export type SecretClassification = 'secret' | 'non-secret';

export interface SecretDefinition {
  name: string;
  classification: SecretClassification;
  /** Required for the application process itself to start. Deploy/CI-only variables (e.g. ADMIN_DATABASE_URL) are false here even though a script may require them. */
  required: boolean;
  owner: string;
  /** Recommended maximum age before rotation, or null if rotation does not apply (non-secrets, or secrets with no meaningful "age", e.g. a static app-behavior flag). */
  rotationPolicyDays: number | null;
  description: string;
}

/**
 * The complete, current inventory of environment variables read by
 * server-side code (apps/api, packages/database, deployment scripts).
 * Update this list whenever a new environment variable is introduced —
 * validateSecretInventory() and the browser-secret check both depend on
 * it being accurate, not aspirational.
 */
export const SECRET_INVENTORY: readonly SecretDefinition[] = [
  {
    name: 'DATABASE_URL',
    classification: 'secret',
    required: true,
    owner: 'platform-database',
    rotationPolicyDays: 90,
    description: 'Application (least-privilege) PostgreSQL connection string, embeds the app role password.',
  },
  {
    name: 'ADMIN_DATABASE_URL',
    classification: 'secret',
    required: false,
    owner: 'platform-database',
    rotationPolicyDays: 90,
    description: 'Administrative PostgreSQL connection string used only by deployment/migration/grant scripts, never by the running application process.',
  },
  { name: 'NODE_ENV', classification: 'non-secret', required: false, owner: 'platform', rotationPolicyDays: null, description: 'Runtime environment name.' },
  { name: 'PORT', classification: 'non-secret', required: false, owner: 'platform', rotationPolicyDays: null, description: 'HTTP listen port.' },
  { name: 'LOG_LEVEL', classification: 'non-secret', required: false, owner: 'platform', rotationPolicyDays: null, description: 'pino log level.' },
  { name: 'RATE_LIMIT_MAX', classification: 'non-secret', required: false, owner: 'platform', rotationPolicyDays: null, description: 'Requests allowed per rate-limit window.' },
  { name: 'RATE_LIMIT_WINDOW_MS', classification: 'non-secret', required: false, owner: 'platform', rotationPolicyDays: null, description: 'Rate-limit window length in milliseconds.' },
  { name: 'TRUST_PROXY', classification: 'non-secret', required: false, owner: 'platform', rotationPolicyDays: null, description: 'Reverse-proxy trust for client-IP derivation: false (default), a hop count (1 = one reverse proxy), or a comma-separated list of proxy IPs/CIDRs. "true" is rejected.' },
  { name: 'WEBHOOK_RATE_LIMIT_IP_MAX', classification: 'non-secret', required: false, owner: 'platform', rotationPolicyDays: null, description: 'Webhook intake: requests allowed per source IP per window, across all connectors. Default is a test value, not a production value.' },
  { name: 'WEBHOOK_RATE_LIMIT_CONNECTOR_MAX', classification: 'non-secret', required: false, owner: 'platform', rotationPolicyDays: null, description: 'Webhook intake: requests allowed per source IP and connector per window. Default is a test value, not a production value.' },
  { name: 'WEBHOOK_RATE_LIMIT_WINDOW_MS', classification: 'non-secret', required: false, owner: 'platform', rotationPolicyDays: null, description: 'Webhook intake rate-limit window length in milliseconds.' },
  { name: 'DB_POOL_MIN', classification: 'non-secret', required: false, owner: 'platform-database', rotationPolicyDays: null, description: 'Minimum PostgreSQL pool connections.' },
  { name: 'DB_POOL_MAX', classification: 'non-secret', required: false, owner: 'platform-database', rotationPolicyDays: null, description: 'Maximum PostgreSQL pool connections.' },
  { name: 'DB_IDLE_TIMEOUT_MS', classification: 'non-secret', required: false, owner: 'platform-database', rotationPolicyDays: null, description: 'Pool idle-connection timeout.' },
  { name: 'DB_CONNECTION_TIMEOUT_MS', classification: 'non-secret', required: false, owner: 'platform-database', rotationPolicyDays: null, description: 'Pool connection-acquisition timeout.' },
  { name: 'DB_STATEMENT_TIMEOUT_MS', classification: 'non-secret', required: false, owner: 'platform-database', rotationPolicyDays: null, description: 'Per-statement timeout.' },
  { name: 'CORS_ALLOWED_ORIGINS', classification: 'non-secret', required: false, owner: 'platform', rotationPolicyDays: null, description: 'Comma-separated browser origins allowed to call this API cross-origin.' },
  {
    name: 'RESEND_API_KEY',
    classification: 'secret',
    required: false,
    owner: 'platform',
    rotationPolicyDays: 180,
    description: 'Resend API key for sending real email-verification messages (packages/authentication). Not read via loadConfig() — resolved independently by resolveEmailConfig() (see its own doc comment). Unset means verification emails are logged, not sent (NoopEmailSender), which never blocks registration.',
  },
  { name: 'EMAIL_FROM_ADDRESS', classification: 'non-secret', required: false, owner: 'platform', rotationPolicyDays: null, description: 'From address for verification emails.' },
  { name: 'EMAIL_VERIFICATION_URL_BASE', classification: 'non-secret', required: false, owner: 'platform', rotationPolicyDays: null, description: 'Base URL the verification link points at (a frontend page that then calls POST /v1/auth/verify-email).' },
  {
    name: 'ANTHROPIC_API_KEY',
    classification: 'secret',
    required: false,
    owner: 'platform',
    rotationPolicyDays: 180,
    description: 'Anthropic API key for AI Decisions recommendations (packages/workflow/BusinessDecisionRecommendationService, via @infinicus/llm-client). Not read via loadConfig() — same "resolved independently, optional" pattern as RESEND_API_KEY. Unset means recommendations fall back to a deterministic threshold-based generator, which never blocks the feature.',
  },
] as const;

/** pino `redact.paths` — structured-log paths that are always redacted regardless of value, independent of redactSecretValues()'s value-based scrubbing. */
export const SECRET_REDACTION_LOG_PATHS: readonly string[] = [
  'req.headers.authorization',
  'config.databaseUrl',
  'config.adminDatabaseUrl',
  '*.password',
  '*.databaseUrl',
  '*.connectionString',
];

/**
 * A secret's value source. EnvSecretProvider (the only implementation
 * today) reads process.env directly — the right choice for this platform's
 * current deployment story (see known-limitations-build24.md: no managed
 * secret store like AWS Secrets Manager/Vault is reachable from this
 * environment). A production deployment can swap in another
 * implementation of this same interface without changing any call site.
 */
export interface SecretProvider {
  get(name: string): string | undefined;
}

export class EnvSecretProvider implements SecretProvider {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  get(name: string): string | undefined {
    return this.env[name];
  }
}

import { ConfigurationError } from './errors.js';

/**
 * Validates that every secret marked `required` in SECRET_INVENTORY has a
 * non-empty value, aggregating every missing name into one error instead
 * of failing on the first (so a misconfigured environment reports its
 * full problem set at once).
 */
export function validateSecretInventory(provider: SecretProvider): void {
  const missing = SECRET_INVENTORY.filter((s) => s.required && !provider.get(s.name)).map((s) => s.name);
  if (missing.length > 0) {
    throw new ConfigurationError(`Missing required environment variable(s): ${missing.join(', ')}`);
  }
}

const LOCAL_OR_TEST_CREDENTIAL_PATTERNS: readonly string[] = [
  'localhost',
  '127.0.0.1',
  'local_admin_pw',
  'local_app_pw',
  'ci_admin_pw',
  'ci_app_pw',
  'infinicus_test_admin',
  'app_test_user',
  'infinicus_ci_admin',
];

/** True if a connection-string-shaped value contains any known local/CI-only credential marker. Used to fail closed against running production with dev/test database credentials. */
export function looksLikeLocalOrTestCredential(value: string): boolean {
  return LOCAL_OR_TEST_CREDENTIAL_PATTERNS.some((pattern) => value.includes(pattern));
}

/**
 * Replaces every occurrence of each configured secret's actual runtime
 * value with `[REDACTED]`. A complement to SECRET_REDACTION_LOG_PATHS'
 * structural (path-based) redaction: this catches a secret value that
 * has leaked into free-form text — an error message, a stack trace, a
 * thrown exception's `.message` — where there is no fixed JSON path to
 * redact ahead of time.
 */
export function redactSecretValues(text: string, provider: SecretProvider): string {
  let result = text;
  for (const secret of SECRET_INVENTORY) {
    if (secret.classification !== 'secret') continue;
    const value = provider.get(secret.name);
    if (!value) continue;
    result = result.split(value).join('[REDACTED]');
  }
  return result;
}
