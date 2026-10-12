/**
 * Worker configuration from the process environment. Every operational parameter is REQUIRED: a missing or malformed value stops the
 * worker at start instead of silently choosing a default for an authorization-pipeline setting. Nothing here enables the pipeline: the
 * execution capability gate (P0-6e) is separate, and closed by default.
 */
export interface EventWorkerConfig {
  workerId: string;
  actorUserId: string;
  discoveryDatabaseUrl: string;
  /** Maximum age of the authoritative status/authority answer judged at BO claim (intake). */
  intakeStatusMaxAgeMs: number;
  claimTimeoutMs: number;
  batchSize: number;
  maxScopesPerCycle: number;
  pollIntervalMs: number;
}

export class WorkerConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`invalid event worker configuration: ${problems.join('; ')}`);
    this.name = 'WorkerConfigError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const ENV = Object.freeze({
  workerId: 'INFINICUS_EVENT_WORKER_ID',
  actorUserId: 'INFINICUS_EVENT_WORKER_ACTOR_USER_ID',
  discoveryDatabaseUrl: 'INFINICUS_EVENT_WORKER_DISCOVERY_DATABASE_URL',
  intakeStatusMaxAgeMs: 'INFINICUS_EVENT_WORKER_INTAKE_STATUS_MAX_AGE_MS',
  claimTimeoutMs: 'INFINICUS_EVENT_WORKER_CLAIM_TIMEOUT_MS',
  batchSize: 'INFINICUS_EVENT_WORKER_BATCH_SIZE',
  maxScopesPerCycle: 'INFINICUS_EVENT_WORKER_MAX_SCOPES_PER_CYCLE',
  pollIntervalMs: 'INFINICUS_EVENT_WORKER_POLL_INTERVAL_MS',
});

export function loadWorkerConfig(env: Readonly<Record<string, string | undefined>>): EventWorkerConfig {
  const problems: string[] = [];
  const text = (name: string): string => {
    const v = env[name];
    if (typeof v !== 'string' || v.trim().length === 0) { problems.push(`${name} is required`); return ''; }
    return v.trim();
  };
  const positiveInt = (name: string): number => {
    const raw = text(name);
    if (raw === '') return 0;
    if (!/^\d+$/.test(raw) || Number(raw) <= 0 || !Number.isSafeInteger(Number(raw))) { problems.push(`${name} must be a positive integer`); return 0; }
    return Number(raw);
  };
  const config: EventWorkerConfig = {
    workerId: text(ENV.workerId),
    actorUserId: text(ENV.actorUserId),
    discoveryDatabaseUrl: text(ENV.discoveryDatabaseUrl),
    intakeStatusMaxAgeMs: positiveInt(ENV.intakeStatusMaxAgeMs),
    claimTimeoutMs: positiveInt(ENV.claimTimeoutMs),
    batchSize: positiveInt(ENV.batchSize),
    maxScopesPerCycle: positiveInt(ENV.maxScopesPerCycle),
    pollIntervalMs: positiveInt(ENV.pollIntervalMs),
  };
  if (config.actorUserId !== '' && !UUID.test(config.actorUserId)) problems.push(`${ENV.actorUserId} must be a lowercase UUID`);
  if (config.batchSize > 100) problems.push(`${ENV.batchSize} must be at most 100`);
  if (config.maxScopesPerCycle > 500) problems.push(`${ENV.maxScopesPerCycle} must be at most 500`);
  if (problems.length > 0) throw new WorkerConfigError(problems);
  return config;
}
