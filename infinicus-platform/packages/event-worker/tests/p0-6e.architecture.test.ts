/**
 * P0-6e architecture guard (no database): the controlled execution wiring. It pins what is wired, what is NOT, and every ownership rule the
 * wiring must keep:  ABA authorizes only | BO claims, executes, owns the reorder fields | DATA moves events | OM verifies | CL learns nothing yet.
 *
 *   package authorization != execution      claim != execution (the consumer hands the claim over; the engine decides)
 *   capability != activation                activation != authorization (it never replaces ABA, the claim, the fresh check or the boundaries)
 *   production default = CLOSED             one trigger, one executor, one writer, one outbox, one retry policy
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { loadWorkerConfig, WORKER_ENV, WorkerConfigError } from '../src/index.js';

const PLATFORM = resolve(__dirname, '../../..');
const SKIP = new Set(['node_modules', 'dist', '.turbo', '.next', 'coverage']);
function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx|js|mjs)$/.test(name)) yield full;
  }
}
const isTest = (rel: string): boolean => /(^|\/)(tests?|__tests__)\//.test(rel) || /\.test\.[tj]sx?$/.test(rel);
const stripComments = (s: string): string => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const production: { rel: string; code: string }[] = [];
for (const root of ['apps', 'packages', 'layers']) {
  for (const file of walk(join(PLATFORM, root))) {
    const rel = relative(PLATFORM, file).split('\\').join('/');
    if (!isTest(rel)) production.push({ rel, code: stripComments(readFileSync(file, 'utf8')) });
  }
}
const read = (rel: string): string => production.find((f) => f.rel === rel)?.code ?? '';
const raw = (rel: string): string => readFileSync(join(PLATFORM, rel), 'utf8');
const sql = (rel: string): string => raw(rel).split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
const under = (prefix: string) => production.filter((f) => f.rel.startsWith(prefix));
const filesMatching = (re: RegExp) => production.filter((f) => re.test(f.code)).map((f) => f.rel).sort();

const BO = 'packages/business-operations-runtime/src/';
const CONSUMER = `${BO}authorized-action/AuthorizedActionNotificationConsumer.ts`;
const ENGINE = `${BO}authorized-action-execution/AuthorizedActionExecutionService.ts`;
const GATE = `${BO}execution-activation/GovernedExecutionGate.ts`;
const ACTIVATION_SERVICE = `${BO}execution-activation/ExecutionActivationService.ts`;
const ACTIVATION_REPO = 'packages/database/src/repositories/bo/ExecutionCapabilityActivationRepository.ts';
const COMPOSE = 'packages/event-worker/src/compose.ts';
const ROUTE = 'apps/api/src/routes/executionActivations.ts';
const M0195 = 'infrastructure/database/migrations/0195_create_bo_execution_capability_activations.sql';

describe('P0-6e architecture', () => {
  it('scans the real production tree (not vacuous)', () => {
    expect(production.length).toBeGreaterThan(200);
    for (const rel of [CONSUMER, ENGINE, GATE, ACTIVATION_SERVICE, ACTIVATION_REPO, COMPOSE, ROUTE]) expect(read(rel).length, rel).toBeGreaterThan(400);
  });

  it('ONE executor, TWO declared drivers: the engine is invoked only by the BO notification consumer and the BO claim-recovery consumer (P0-6g), and nothing drives it from a timer, route, queue or cron', () => {
    expect(filesMatching(/\.executeClaim\(/).filter((rel) => rel !== ENGINE).sort()).toEqual([CONSUMER, `${BO}authorized-action/ClaimRecoveryConsumer.ts`].sort()); // the engine's own runDue is unreferenced (below); the second driver is the claim's own durable recovery signal (P0-6g)
    expect(filesMatching(/\.runDue\(/)).toEqual([`${BO}authorized-action/ClaimRecoveryOperatorService.ts`]); // no polling trigger exists; the ONLY caller is the interim operator control (P0-6h: bo:admin, audited, gate-checked), never the worker
    expect(filesMatching(/new AuthorizedActionExecutionService\(/).sort()).toEqual(['apps/api/src/claimRecoveryComposition.ts', COMPOSE].sort()); // constructed only in composition roots: the worker and (P0-6h) the API operator control
    for (const f of production) {
      if (!/AuthorizedActionExecutionService|executeClaim/.test(f.code) || f.rel === ENGINE) continue;
      expect(f.code, f.rel).not.toMatch(/setInterval|setTimeout|node-cron|cron\.|schedule\(/);
    }
    expect(under('apps/api/src/').filter((f) => /AuthorizedActionExecutionService|executeClaim/.test(f.code)).map((f) => f.rel)).toEqual(['apps/api/src/claimRecoveryComposition.ts']); // the API names the engine only in its operator composition root (P0-6h) ...
    expect(under('apps/api/src/routes/').filter((f) => /AuthorizedActionExecutionService|executeClaim|runDue/.test(f.code)).map((f) => f.rel)).toEqual([]); // ... and no request route executes: the route calls the BO operator service only
  });

  it('claim != execution: the consumer hands over only after intake claimed and the ABA mirror was attempted; it never writes inventory itself', () => {
    const c = read(CONSUMER);
    expect(c.indexOf('this.deps.intake.intake(')).toBeGreaterThan(-1);
    expect(c.indexOf('this.deps.intake.intake(')).toBeLessThan(c.indexOf('recordConsumed('));
    expect(c.indexOf('recordConsumed(')).toBeLessThan(c.indexOf('executor.executeClaim('));
    expect(c).not.toMatch(/inventory_balances|inventory_movements|reorder_point|OperationalCommandExecutor|UPDATE\s|INSERT\s/i);
  });

  it('package authorization != execution: ABA code (workflow package, ABA layer) never names the engine, the gate, the activation record or a reorder write', () => {
    for (const f of [...under('packages/workflow/'), ...under('layers/approved-business-action/')]) {
      expect(f.code, f.rel).not.toMatch(/AuthorizedActionExecutionService|executeClaim|GovernedExecutionGate|execution_capability_activations|ExecutionActivation|inventory_balances|reorder_point|bo_reorder_policy_writer/);
    }
  });

  it('BO is the sole operational executor and the only writer of the reorder fields: exactly one file carries the writer marker', () => {
    expect(filesMatching(/bo_reorder_policy_writer/)).toEqual([]); // migration 0196: the session-variable convention is gone from application code
    expect(filesMatching(/apply_inventory_reorder_policy\(/)).toEqual([`${BO}OperationalCommandExecutor.ts`]);
    // nothing outside BO and its repositories updates the reorder columns
    for (const f of production) {
      if (f.rel.startsWith(BO) || f.rel.startsWith('packages/database/')) continue;
      expect(f.code, f.rel).not.toMatch(/UPDATE\s+\S*inventory_balances|reorder_point\s*=/i);
    }
  });

  it('capability != activation: the registry is static data with no database, activation or kill-switch reference', () => {
    const r = read(`${BO}authorized-action/boActionCapabilities.ts`);
    expect(r).not.toMatch(/activation|killSwitch|database|withTenantTransaction|process\.env/i);
    expect(r).toMatch(/PRODUCTION_SUPPORTED_ACTION_TYPES: readonly string\[\] = Object\.freeze\(\['inventory_reorder_policy_update@1'\]\)/);
    // the registry entry exists only together with the end-to-end suite that proves it (planning decision 16)
    expect(existsSync(join(PLATFORM, 'packages/event-worker/tests/ExecutionWiring.e2e.test.ts'))).toBe(true);
  });

  it('the gate opens only when ALL THREE keys agree and fails closed on any doubt', () => {
    const g = read(GATE);
    expect(g).toMatch(/killSwitchEngaged\(\) !== false\) return false/);
    expect(g).toMatch(/capabilities\.supports\(/);
    expect(g).toMatch(/activations\.isEnabled\(/);
    expect(g).toMatch(/catch \{\s*return false;/);
    expect(g).not.toMatch(/return true;/); // the only way to open is the record's own answer
    const repo = read(ACTIVATION_REPO);
    expect(repo).toMatch(/current\?\.state === 'ENABLED'/);
    expect(repo).not.toMatch(/\b(UPDATE|DELETE\s+FROM)\b/i); // the record is append-only in code as well as in the database
  });

  it('activation != authorization: the activation surface imports no ABA, status-provider, intake, claim or engine code and creates no claim, receipt or execution', () => {
    for (const rel of [ACTIVATION_SERVICE, ACTIVATION_REPO, GATE, ROUTE]) {
      expect(read(rel), rel).not.toMatch(/@infinicus\/workflow|approved_business_action|AuthoritativePackageStatusProvider|AuthorizedActionIntakeService|AuthorizedActionExecutionService|authorized_action_(claims|receipts|executions)|executeClaim/);
    }
    // the permission is the EXISTING bo:admin; ABA's approval permissions are never activation permissions
    expect(read(ACTIVATION_SERVICE)).toMatch(/EXECUTION_ACTIVATION_PERMISSION = 'bo:admin'/);
    expect(read(ROUTE)).not.toMatch(/'aba:(read|write|admin)'/);
    expect(read(ROUTE)).toMatch(/app\.requirePermission\(EXECUTION_ACTIVATION_ROUTE_PERMISSION\)/);
    expect(read(ROUTE)).toMatch(/requireIdempotencyKey/);
  });

  it('activation rows are written by exactly one code path (the administration service), and never by the engine, consumer, worker, a migration or a seed', () => {
    expect(filesMatching(/recordOnClient\(/)).toEqual([ACTIVATION_SERVICE, ACTIVATION_REPO].sort());
    expect(filesMatching(/execution_capability_activations/)).toEqual([ACTIVATION_REPO]);
    const m = sql(M0195);
    expect(m).not.toMatch(/INSERT\s+INTO\s+business_operations\.execution_capability_activations/i); // no seed, no backfill
    expect(m).not.toMatch(/\bGRANT\b|\bREVOKE\b|CREATE\s+ROLE|ALTER\s+ROLE|\bUPDATE\b\s+\S+\s+SET/i);
    expect(m).toContain("INSERT INTO _migrations (filename) VALUES ('0195_create_bo_execution_capability_activations.sql')");
    expect(m).toMatch(/FORCE ROW LEVEL SECURITY/);
  });

  it('PRODUCTION DEFAULT IS CLOSED: the worker default gate is the governed gate, no environment variable or deployment file can turn execution on, and the browser has no activation surface', () => {
    expect(read(COMPOSE)).toMatch(/options\.gate \?\? new GovernedExecutionGate\(/);
    expect(read(COMPOSE)).not.toMatch(/isEnabled: async \(\) => true|() => true/);
    // BO runtime never reads the process environment (the one kill-switch reader takes the env object as an argument)
    expect(under(BO).filter((f) => /process\.env/.test(f.code)).map((f) => f.rel)).toEqual([]);
    for (const rel of ['infrastructure/deployment/event-worker/docker-compose.event-worker.yml', '.env.example']) {
      const settings = raw(rel).split('\n').filter((l) => !l.trim().startsWith('#')).join('\n'); // comments may explain the gate; settings may not open it
      expect(settings, rel).not.toMatch(/ACTIVAT|EXECUTION_ENABLED|EXECUTE_ENABLED/i);
    }
    // the kill switch can only remove capability
    expect(read(`${BO}execution-activation/killSwitch.ts`)).not.toMatch(/return true;[\s\S]*ENABLED/);
    expect(under('apps/web/').filter((f) => /execution-activations|ExecutionActivation/.test(f.code)).map((f) => f.rel)).toEqual([]);
  });

  it('fresh ABA authority: the status age has no silent default anywhere between the worker environment and the engine, and the engine still asks only under lock', () => {
    expect(() => loadWorkerConfig({})).toThrow(WorkerConfigError);
    const base: Record<string, string> = {
      [WORKER_ENV.workerId]: 'w', [WORKER_ENV.actorUserId]: '00000000-0000-4000-8000-000000000001', [WORKER_ENV.discoveryDatabaseUrl]: 'postgres://x',
      [WORKER_ENV.intakeStatusMaxAgeMs]: '5000', [WORKER_ENV.claimTimeoutMs]: '60000', [WORKER_ENV.batchSize]: '10', [WORKER_ENV.maxScopesPerCycle]: '5', [WORKER_ENV.pollIntervalMs]: '1000',
    };
    expect(() => loadWorkerConfig(base)).toThrow(/INFINICUS_EVENT_WORKER_EXECUTION_STATUS_MAX_AGE_MS is required/);
    expect(loadWorkerConfig({ ...base, [WORKER_ENV.executionStatusMaxAgeMs]: '5000' }).executionStatusMaxAgeMs).toBe(5000);
    expect(read(COMPOSE)).toMatch(/executionStatusMaxAgeMs: config\.executionStatusMaxAgeMs/);
    const e = read(ENGINE);
    expect(e).toMatch(/executionStatusMaxAgeMs: number;/);
    expect(e).not.toMatch(/executionStatusMaxAgeMs\s*\?\?|executionStatusMaxAgeMs = \d/);
    expect(e.indexOf('this.adapter.lockTarget(')).toBeGreaterThan(-1);
    expect(e.indexOf('this.adapter.lockTarget(')).toBeLessThan(e.indexOf('statusProvider.getStatus('));
  });

  it('one outbox, one retry policy, one transport: no second queue, scheduler or retry constants were introduced', () => {
    expect(under('packages/').filter((f) => /EXECUTION_(MAX_ATTEMPTS|BACKOFF_MS|CLAIM_RECOVERY_MS)\s*=/.test(f.code)).map((f) => f.rel)).toEqual([`${BO}authorized-action-execution/constants.ts`]);
    expect(filesMatching(/new OutboxRepository\(\)/).filter((rel) => rel.startsWith(BO) || rel === CONSUMER).sort()).toEqual([`${BO}authorized-action-execution/ExecutionEventPublisher.ts`, `${BO}authorized-action/ClaimRecoveryScheduler.ts`].sort()); // the existing outbox only: the execution announcement (P0-6d) and the claim recovery signal (P0-6g)
    expect(filesMatching(/bullmq|amqplib|node-cron|agenda|bee-queue|setInterval\(/).filter((rel) => rel.startsWith('packages/business-operations-runtime/') || rel === COMPOSE)).toEqual([]);
  });

  it('OM stays verification-only and CL learns nothing: OM never writes BO state, no outcome beyond PENDING/INCONCLUSIVE is assignable, and nothing calls the learning gate', () => {
    for (const f of under('packages/outcome-monitoring-runtime/src/')) expect(f.code, f.rel).not.toMatch(/business_operations\.|AuthorizedActionExecutionRepository|inventory_balances|'OUTCOME_(OBSERVED|VERIFIED|FAILED)'/);
    expect(filesMatching(/learningEligibility\(/).filter((rel) => rel !== 'packages/handoff-contracts/src/execution-evidence/states.ts')).toEqual(['packages/handoff-contracts/src/om-to-cl-learning-release.ts']); // CL-BOUNDARY-1: the one release decision; nothing else (and nothing wired) calls the gate
    expect([...under('packages/database/src/repositories/cl/'), ...under('layers/continuous-learning/')].filter((f) => /action_execution_verifications|operations\.action\.executed|execution-evidence|authorized_action_executions/.test(f.code))).toEqual([]);
  });
});
