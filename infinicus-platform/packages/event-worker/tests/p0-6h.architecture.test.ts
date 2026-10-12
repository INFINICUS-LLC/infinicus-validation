import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * P0-6h architecture guard (no database): the interim OPERATOR recovery control is the existing scoped `runDue` behind a governed request, nothing
 * more - one business, one action type, `bo:admin`, audited before and after, refused while the gate is closed, never reachable from the worker.
 */
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
const under = (prefix: string) => production.filter((f) => f.rel.startsWith(prefix));
const filesMatching = (re: RegExp) => production.filter((f) => re.test(f.code)).map((f) => f.rel).sort();

const BO = 'packages/business-operations-runtime/src/';
const OPERATOR = `${BO}authorized-action/ClaimRecoveryOperatorService.ts`;
const ROUTE = 'apps/api/src/routes/claimRecovery.ts';
const SCHEMA = 'apps/api/src/schemas/claimRecovery.ts';
const COMPOSITION = 'apps/api/src/claimRecoveryComposition.ts';
const APP = 'apps/api/src/app.ts';
const ENGINE = `${BO}authorized-action-execution/AuthorizedActionExecutionService.ts`;
const REPO = 'packages/database/src/repositories/bo/AuthorizedActionExecutionRepository.ts';

describe('P0-6h architecture', () => {
  it('scans the real production tree (not vacuous)', () => {
    expect(production.length).toBeGreaterThan(200);
    for (const rel of [OPERATOR, ROUTE, SCHEMA, COMPOSITION, APP, ENGINE, REPO]) expect(read(rel).length, rel).toBeGreaterThan(300);
  });

  it('the operator control is the existing runDue and nothing else: it is the ONLY runDue caller, the worker package never references it, and no second executor exists', () => {
    expect(filesMatching(/\.runDue\(/)).toEqual([OPERATOR]);
    expect(under('packages/event-worker/src/').filter((f) => /ClaimRecoveryOperator|claimRecoveryComposition|execution-recoveries/.test(f.code)).map((f) => f.rel)).toEqual([]);
    expect(filesMatching(/new AuthorizedActionExecutionService\(/).sort()).toEqual([COMPOSITION, 'packages/event-worker/src/compose.ts'].sort());
    expect(read(OPERATOR)).not.toMatch(/executeClaim\(|insertExecution|inventory_|InventoryReorderPolicyExecutionAdapter|OperationalCommandExecutor|AuthorizedActionIntake|receiveAndClaim|INSERT INTO|UPDATE |DELETE FROM/);
  });

  it('governed: the existing bo:admin permission (nothing invented), enforced by the route preHandler AND re-checked by the service; Idempotency-Key and an active subscription are required', () => {
    expect(read(OPERATOR)).toMatch(/CLAIM_RECOVERY_OPERATOR_PERMISSION = EXECUTION_ACTIVATION_PERMISSION/);
    expect(read(OPERATOR)).toMatch(/if \(permissionCode !== CLAIM_RECOVERY_OPERATOR_PERMISSION\) throw new ClaimRecoveryOperatorError\('PERMISSION_INVALID'/);
    expect(read(`${BO}execution-activation/ExecutionActivationService.ts`)).toMatch(/EXECUTION_ACTIVATION_PERMISSION = 'bo:admin'/);
    expect(read(ROUTE)).toMatch(/preHandler: \[app\.authenticate, app\.resolveTenantContext, app\.requirePermission\(CLAIM_RECOVERY_OPERATOR_PERMISSION\), app\.requireActiveSubscription\(\), app\.requireIdempotencyKey\]/);
    expect(filesMatching(/CREATE (OR REPLACE )?(FUNCTION|POLICY|ROLE)|GRANT /).filter((rel) => rel === OPERATOR || rel === ROUTE || rel === COMPOSITION)).toEqual([]);
  });

  it('scoped: ONE business and ONE action type per request, server-authoritative scope, and the body cannot name a claim, scope, owner or permission (strict)', () => {
    expect(read(SCHEMA)).toMatch(/claimRecoveryBodySchema = z\.object\(\{[\s\S]*\}\)\.strict\(\)/);
    const bodySchema = read(SCHEMA).slice(read(SCHEMA).indexOf('claimRecoveryBodySchema'), read(SCHEMA).indexOf('claimRecoveryResponseSchema'));
    expect(bodySchema).not.toMatch(/claimId|tenantId|workspaceId|businessId|permission|state|owner/);
    expect(read(ROUTE)).toMatch(/businesses\.getById\(request\.ctx!, businessId\)/);
    expect(read(ROUTE)).toMatch(/recover\(request\.ctx!, CLAIM_RECOVERY_OPERATOR_PERMISSION, \{ businessId, actionType, reason/);
    expect(read(OPERATOR)).toMatch(/runDue\(ctx, \{ limit, businessId: request\.businessId, actionType: \{ code, schemaVersion \} \}\)/);
    expect(read(REPO)).toMatch(/\$2::uuid IS NULL OR c\.business_id = \$2::uuid/);
    // no cross-tenant listing is added: the awaiting-claims read still runs in the caller's tenant transaction (RLS), with no admin pool
    expect(read(REPO)).not.toMatch(/ADMIN_DATABASE_URL|BYPASSRLS|SECURITY DEFINER/);
  });

  it('never bypasses the gate and never terminalizes on a closed one: the gate is checked BEFORE the audit and BEFORE the engine runs', () => {
    const o = read(OPERATOR);
    const gate = o.indexOf('.isEnabled(scope');
    expect(gate).toBeGreaterThan(-1);
    expect(o).toMatch(/\.then\(\(v\) => v === true, \(\) => false\)/); // a gate that cannot answer is closed
    expect(gate).toBeLessThan(o.indexOf('CLAIM_RECOVERY_OPERATOR_AUDIT_ACTIONS.requested', gate));
    expect(gate).toBeLessThan(o.indexOf('.runDue('));
    expect(read(COMPOSITION)).toMatch(/new GovernedExecutionGate\(\{ capabilities, killSwitchEngaged, actorUserId: ctx\.userId \}\)/);
  });

  it('audited as a USER action before and after, bounded, and with no retry policy, timer or queue of its own', () => {
    const o = read(OPERATOR);
    expect(o.indexOf('CLAIM_RECOVERY_OPERATOR_AUDIT_ACTIONS.requested', o.indexOf('.isEnabled(scope'))).toBeLessThan(o.indexOf('.runDue('));
    expect(o.indexOf('.runDue(')).toBeLessThan(o.indexOf('CLAIM_RECOVERY_OPERATOR_AUDIT_ACTIONS.completed'));
    expect(read(REPO)).toMatch(/'user',\$4,\$5,'authorized_action_recovery_request'/);
    expect(o).toMatch(/CLAIM_RECOVERY_MAX_LIMIT = 25/);
    for (const rel of [OPERATOR, ROUTE, COMPOSITION]) expect(read(rel), rel).not.toMatch(/setTimeout|setInterval|node-cron|bullmq|amqplib|maxAttempts|backoff|EXECUTION_MAX_ATTEMPTS|EXECUTION_BACKOFF_MS|\b60_?000\b/);
  });

  it('the ABA status provider is joined to the engine ONLY in the API composition root: the BO service and the route import no ABA/workflow code', () => {
    expect(filesMatching(/AbaPackageStatusProvider/).filter((rel) => rel.startsWith('apps/api/src/'))).toEqual([COMPOSITION]);
    for (const rel of [OPERATOR, ROUTE]) expect(read(rel), rel).not.toMatch(/@infinicus\/workflow|approved_business_action|AbaPackage|AuthorizedActionPackageRepository/);
    expect(read(APP)).toMatch(/app\.register\(claimRecoveryRoutes, \{ operator: buildClaimRecoveryOperator\(options\.claimRecovery\) \}\)/);
  });

  it('no migration, schema or grant change: the newest migration is still 0195', () => {
    const migrations = readdirSync(join(PLATFORM, 'infrastructure/database/migrations')).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    expect(migrations[migrations.length - 1]).toMatch(/^0195_/);
  });
});
