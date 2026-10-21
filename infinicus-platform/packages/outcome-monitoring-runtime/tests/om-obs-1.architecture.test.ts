/**
 * OM-OBS-1 architecture guard (no database): Outcome Monitoring observability is read-only, has no second source of truth, and cannot trigger anything.
 *
 *   route (bo:admin, GET)  ->  OutcomeMonitoringHealthService (pure classification)  ->  OutcomeMonitoringHealthRepository (SELECT only)
 *
 * It must not verify, replay, mutate, emit, reach the learning gate or the Control Loop, or invent a state. A later change that does any of those
 * is a different block and must update this test deliberately.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const PLATFORM = resolve(__dirname, '../../..');
const SKIP = new Set(['node_modules', 'dist', '.turbo', '.next', 'coverage', 'out']);
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
const users = (re: RegExp, except: string[] = []) => production.filter((f) => re.test(f.code) && !except.includes(f.rel)).map((f) => f.rel).sort();

const REPO = 'packages/database/src/repositories/om/OutcomeMonitoringHealthRepository.ts';
const SERVICE = 'packages/outcome-monitoring-runtime/src/OutcomeMonitoringHealthService.ts';
const ROUTE = 'apps/api/src/routes/outcomeMonitoringHealth.ts';
const SCHEMA = 'apps/api/src/schemas/outcomeMonitoringHealth.ts';
const APP = 'apps/api/src/app.ts';

describe('OM-OBS-1 - read-only observability', () => {
  it('scans the real production tree (not vacuous)', () => {
    expect(production.length).toBeGreaterThan(200);
    for (const rel of [REPO, SERVICE, ROUTE, SCHEMA, APP]) expect(read(rel).length, rel).toBeGreaterThan(300);
  });

  it('the repository only SELECTs: no INSERT, UPDATE, DELETE, TRUNCATE, DDL, function calls that write, or advisory locks', () => {
    const code = read(REPO);
    expect(code).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+[a-z_.]+\s+SET|DELETE\s+FROM|TRUNCATE|ALTER\s+TABLE|CREATE\s+(TABLE|INDEX|POLICY)|DROP\s|GRANT\s|COPY\s)/i);
    expect(code).not.toMatch(/\bFOR\s+(UPDATE|SHARE)\b|pg_advisory|set_config|nextval|emit_|SECURITY\s+DEFINER/i);
    expect(code).toMatch(/withTenantTransaction/);            // always under the caller's tenant and workspace (RLS)
    expect(code).not.toMatch(/withTransaction\(/);            // never the RLS-bypassing/untenanted helper
  });

  it('the repository never returns stored event bodies or free-text failure messages', () => {
    const code = read(REPO);
    expect(code).not.toMatch(/failure_message|response_body|\bAS\s+original_event\b|d\.original_event\s+AS|SELECT\s+\*|d\.\*|e\.\*|e\.payload\s+AS\s+payload/i);
    expect(code).not.toMatch(/failure_reason\s+AS|d\.failure_reason,/i);
  });

  it('the service and route only read: no writes, no event emission, no verification, no replay, no learning, no Control Loop', () => {
    for (const rel of [SERVICE, ROUTE]) {
      const code = read(rel);
      expect(code, rel).not.toMatch(/\.(record|create|insert|update|delete|replay|markReplayApproved|publish|emit|append)\w*\(/);
      expect(code, rel).not.toMatch(/ExecutionVerificationService|ActionExecutedConsumer|DeadLetterRepository|OutboxDispatcher|LearningReleaseBoundary|learningEligibility|decideLearningRelease|CLIntakeRepository|LearningFeedbackPackageRepository|OMPublicationRepository/);
      expect(code, rel).not.toMatch(/\.query\(|SELECT |INSERT |UPDATE |DELETE /);
    }
  });

  it('the service invents no outcome state: it reads the vocabulary from the contracts and names none itself', () => {
    const code = read(SERVICE);
    expect(code).toMatch(/INITIAL_OUTCOME_STATES/);
    expect(code).toMatch(/EXECUTION_STATES/);
    expect(code).not.toMatch(/['"](OUTCOME_(PENDING|OBSERVED|VERIFIED|INCONCLUSIVE|FAILED|EFFECTIVE)|EXECUTION_(VERIFIED|DONE|COMPLETE\w*))['"]/);
  });

  it('the repository and the service are used by one route and nothing else', () => {
    expect(users(/\bOutcomeMonitoringHealthRepository\b/, [REPO, 'packages/database/src/index.ts', 'packages/database/src/repositories/om/index.ts', SERVICE])).toEqual([]);
    expect(users(/\bOutcomeMonitoringHealthService\b/, [SERVICE, 'packages/outcome-monitoring-runtime/src/index.ts', ROUTE])).toEqual([]);
    expect(users(/outcomeMonitoringHealthRoutes/, [ROUTE])).toEqual([APP]);
  });

  it('the route is a single GET behind the existing bo:admin permission, after authentication and tenant resolution', () => {
    const code = read(ROUTE);
    expect(code.match(/server\.(get|post|put|patch|delete)\(/g)).toEqual(['server.get(']);
    expect(code).toMatch(/preHandler:\s*\[app\.authenticate,\s*app\.resolveTenantContext,\s*app\.requirePermission\(OUTCOME_MONITORING_HEALTH_PERMISSION\)\]/);
    expect(read(SERVICE)).toMatch(/OUTCOME_MONITORING_HEALTH_PERMISSION\s*=\s*'bo:admin'/);
    expect(code).toMatch(/businesses\.getById\(request\.ctx!,\s*businessId\)/);   // a business outside the caller's scope is a plain 404
  });

  it('no migration was added by this block and no new permission was invented', () => {
    const migrations = readdirSync(join(PLATFORM, 'infrastructure/database/migrations')).filter((f) => /^02(1\d|[2-9]\d)_/.test(f));
    expect(migrations).toEqual([]);
    expect(read(ROUTE) + read(SERVICE)).not.toMatch(/['"](om|aba|bi|dt|sim|adi|cl):(admin|monitor|observe|health)['"]/);
  });

  it('dead letters are listed, never replayed: nothing in the observability path touches replay', () => {
    expect(read(REPO)).not.toMatch(/replay_status\s*=\s*'(replayed|abandoned)'\s*,|SET\s+replay/i);
    expect(read(SERVICE) + read(ROUTE)).not.toMatch(/replay\w*\s*\(|markReplay|replay_event|DeadLetter\w*Repository/i);
  });
});
