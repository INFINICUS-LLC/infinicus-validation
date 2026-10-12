/**
 * P0-6b architecture guard (no database): the pipeline is request-free (separate process), reference-only, gated closed by default, ends at
 * claim + mirror (no execution), and touches nothing outside its boundary.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

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
const DISPATCHER = 'packages/database/src/eventing/OutboxDispatcher.ts';
const ANNOUNCER = 'packages/workflow/src/ActionAuthorizedAnnouncer.ts';
const CONSUMER = 'packages/business-operations-runtime/src/authorized-action/AuthorizedActionNotificationConsumer.ts';
const COMPOSE = 'packages/event-worker/src/compose.ts';

describe('P0-6b architecture', () => {
  it('scans the real production tree (not vacuous)', () => {
    expect(production.length).toBeGreaterThan(200);
    for (const rel of [DISPATCHER, ANNOUNCER, CONSUMER, COMPOSE]) expect(read(rel).length, rel).toBeGreaterThan(500);
  });

  it('the dispatcher runs ONLY in the separate worker process: no app, API route or other package starts, polls or schedules it', () => {
    const users = production.filter((f) => /OutboxDispatcher|buildEventWorker|\bEventWorker\b/.test(f.code)).map((f) => f.rel).sort();
    expect(users).toEqual([
      'packages/database/src/eventing/OutboxDispatcher.ts', 'packages/database/src/eventing/index.ts', 'packages/database/src/index.ts',
      'packages/event-worker/src/EventWorker.ts', 'packages/event-worker/src/compose.ts', 'packages/event-worker/src/index.ts', 'packages/event-worker/src/main.ts',
    ]);
    for (const app of ['apps/api', 'apps/web', 'apps/admin']) {
      const pkg = existsSync(join(PLATFORM, app, 'package.json')) ? raw(`${app}/package.json`) : '';
      expect(pkg, app).not.toContain('@infinicus/event-worker');
    }
    expect(production.filter((f) => f.rel.startsWith('apps/api/src/') && /setInterval|setTimeout\(.*dispatch|claimBatch|dispatchScope/.test(f.code)).map((f) => f.rel)).toEqual([]);
  });

  it('the dispatcher cannot sweep unrelated outbox rows: the event types are mandatory and the worker passes only the two declared types (authorized: P0-6b; executed: P0-6d)', () => {
    expect(read(DISPATCHER)).toMatch(/requires an explicit, non-empty list of event types/);
    expect(read(DISPATCHER)).toMatch(/eventTypes: \[\.\.\.d\.eventTypes\]/);
    expect(read(COMPOSE)).toMatch(/const eventTypes = \[ACTION_AUTHORIZED_EVENT_TYPE, ACTION_EXECUTED_EVENT_TYPE\]/);
  });

  it('everything defaults closed: the issuer has no announcer of its own, an absent announcer gate is deny-all, governed (closed-by-default) gate in the consumer composition and worker', () => {
    expect(read(ANNOUNCER)).toContain('gate: deps.gate ?? DENY_ALL_EXECUTION_GATE');
    // P0-6e: the worker's default gate is the GOVERNED gate (registry + per-business activation record + kill switch), which is closed until an administrator enables a business.
    expect(read(COMPOSE)).toContain('const gate = options.gate ?? new GovernedExecutionGate({');
    expect(read(COMPOSE)).not.toContain('DENY_ALL_EXECUTION_GATE');
    expect(read(COMPOSE)).not.toMatch(/explicitCapabilities|PRODUCTION_SUPPORTED_ACTION_TYPES\s*=/);
    expect(read('packages/workflow/src/AuthorizedActionPackageIssuer.ts')).not.toMatch(/new ActionAuthorizedAnnouncer/);
    // P0-6f: the ONE production construction of the announcer is the API composition root, which gives it the GOVERNED gate (never a literal open one).
    expect(production.filter((f) => /new ActionAuthorizedAnnouncer/.test(f.code)).map((f) => f.rel)).toEqual(['apps/api/src/abaPackageAnnouncement.ts']);
    expect(read('packages/business-operations-runtime/src/authorized-action/boActionCapabilities.ts')).toMatch(/PRODUCTION_SUPPORTED_ACTION_TYPES: readonly string\[\] = Object\.freeze\(\['inventory_reorder_policy_update@1'\]\)/);
    // the gate is required by the consumer (no default inside it) and a throwing gate is closed
    expect(read(CONSUMER)).not.toContain('DENY_ALL_EXECUTION_GATE');
    expect(read(CONSUMER)).toMatch(/\(\) => false\)/);
    expect(read(ANNOUNCER)).toMatch(/\(\) => false\)/);
  });

  it('the pipeline ends at claim + mirror: no execution, inventory write, evidence or activation anywhere in the P0-6b files', () => {
    for (const rel of [DISPATCHER, ANNOUNCER, CONSUMER, COMPOSE, 'packages/event-worker/src/EventWorker.ts', 'packages/event-worker/src/main.ts']) {
      // P0-6d: only the composition root may name the executed event (to register OM's verifier); every other file stays free of it.
      const executedAllowed = rel === COMPOSE ? /ACTION_EXECUTED_EVENT_TYPE|registerActionExecutedContract|ActionExecutedConsumer|BoExecutionEvidenceReader/g : null;
      const code = executedAllowed ? read(rel).replace(executedAllowed, '') : read(rel);
      expect(code, rel).not.toMatch(/OperationalCommandExecutor|inventory_balances|inventory_movements|reorder_point|ExecutionEvidence|operations\.action\.executed|ACTION_EXECUTED|execution_capability_activations/);
      expect(read(rel), rel).not.toMatch(/UPDATE\s+business_operations|INSERT\s+INTO\s+business_operations/i);
    }
  });

  it('the event is reference-only: the announcer copies named fields and never the package body, parameters or boundaries', () => {
    const code = read(ANNOUNCER);
    expect(code).not.toMatch(/action\.parameters|\.preconditions|\.budget|\.rollback|\.monitoring|accountableOwner|lineage\.(proposed|modification)|JSON\.stringify\(pkg\)|\.\.\.pkg/);
    const contract = read('packages/event-contracts/src/action-authorized.ts');
    expect(contract).toContain('exactKeys');
  });

  it('the producer writes only an outbox row (through the repository, on the issuance transaction); the consumer reaches ABA only through shared ports', () => {
    expect(read(ANNOUNCER)).toContain('enqueueIfAbsent');
    expect(read(ANNOUNCER)).not.toMatch(/\.query\(|business_operations|OperationalCommand/);
    expect(read(CONSUMER)).not.toMatch(/approved_business_action|@infinicus\/workflow|AuthorizedActionPackageRepository|\.query\(/);
  });

  it('ABA and BO are joined only in the worker composition root', () => {
    const both = production.filter((f) => /@infinicus\/workflow/.test(f.code) && /@infinicus\/business-operations-runtime/.test(f.code) && !f.rel.startsWith('apps/')).map((f) => f.rel);
    expect(both).toEqual([COMPOSE]);
  });

  it('migration 0190 is additive: one nullable column and an index, no data change, no role statements, no backfill', () => {
    const sql = raw('infrastructure/database/migrations/0190_add_outbox_claimed_at.sql').split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS claimed_at timestamptz;/);
    expect(sql).not.toMatch(/\bUPDATE\b|\bDELETE\b|\bDROP\b|\bTRUNCATE\b|\bGRANT\b|CREATE ROLE|NOT NULL DEFAULT/i);
    const files = readdirSync(join(PLATFORM, 'infrastructure/database/migrations')).filter((f) => /^\d{4}_/.test(f)).sort();
    expect(files.indexOf('0190_add_outbox_claimed_at.sql')).toBe(files.indexOf('0189_add_inventory_reorder_policy_state.sql') + 1);
  });

  it('deployment: the worker is a separate image behind a compose profile (never started by default) and its discovery credential is inventoried as a secret', () => {
    const compose = raw('infrastructure/deployment/event-worker/docker-compose.event-worker.yml');
    expect(compose).toMatch(/profiles:\s*\["event-worker"\]/);
    expect(compose).not.toMatch(/ports:/);
    for (const stack of ['hetzner', 'oci']) expect(raw(`infrastructure/deployment/${stack}/docker-compose.yml`)).not.toContain('event-worker');
    expect(raw('packages/configuration/src/secrets.ts')).toContain("name: 'INFINICUS_EVENT_WORKER_DISCOVERY_DATABASE_URL'");
    expect(raw('infrastructure/deployment/event-worker/Dockerfile')).toContain('--filter=@infinicus/event-worker...');
  });

  it('legacy ABA blocks 17/19/20/21 stay unimported', () => {
    expect(production.filter((f) => !f.rel.startsWith('layers/approved-business-action/') && /approved-business-action\/blocks/.test(f.code))).toEqual([]);
  });
});
