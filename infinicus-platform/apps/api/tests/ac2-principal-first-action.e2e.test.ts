/**
 * AC-2 Block 8 - THE principal completion proof for inventory_reorder_policy_update@1 (real PostgreSQL, production buildApp, real worker).
 *
 *   source data -> DAL -> BO truth -> BI evidence -> BDT state -> ADI recommendation -> ABA approval -> AuthorizedActionPackage
 *   -> BO claim -> fresh authority -> baseline CAS -> reorder-policy execution -> ExecutionEvidence -> operations.action.executed@1
 *   -> OM EXECUTION_VERIFIED -> OUTCOME_PENDING -> CL ineligible
 *
 * Nothing in Business Operations is seeded by this test: the item, warehouse, receipt with cost and currency, dated issue history and balance enter ONLY as
 * published Data Acquisition records through the BO intake; the first policy is stated through the BO-owned route and the currency through the business-admin
 * declaration (rulings D2, D3). There is no recommendation fixture and no simulation (governed NOT_APPLICABLE, ruling C-1).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '@infinicus/configuration';
import { closePool, createPool } from '@infinicus/database';
import { learningEligibility, proposalEvidenceProblems } from '@infinicus/handoff-contracts';
import { buildEventWorker } from '../../../packages/event-worker/src/index.js';
import { buildApp } from '../src/app.js';
import { ACTION, FINAL, chainKit, type AdiChain, type Session } from './helpers/authorizedPackageChain.js';
import { dalKit, firstActionRecords, unique, type World } from './helpers/dalIngestion.js';
import { deleteMovementsForTenants } from './helpers/movementCleanup.js';

const run = !!process.env.DATABASE_URL && !!process.env.ADMIN_DATABASE_URL;
const ACTOR = randomUUID();
const BO = 'business_operations';
const ABA = 'approved_business_action';
const ADI = 'ai_decision_intelligence';
const MAX_AGE = 5000;

let admin: Pool;
let app: FastifyInstance;
const tenantIds: string[] = [];
let ck: ReturnType<typeof chainKit>;
let dk: ReturnType<typeof dalKit>;

const q = async (sql: string, args: unknown[]) => (await admin.query(sql, args)).rows;
const worker = (c: AdiChain) => buildEventWorker({
  config: { workerId: `w-${randomUUID().slice(0, 6)}`, actorUserId: ACTOR, discoveryDatabaseUrl: 'unused', intakeStatusMaxAgeMs: MAX_AGE, executionStatusMaxAgeMs: MAX_AGE, claimTimeoutMs: 60_000, batchSize: 10, maxScopesPerCycle: 5, pollIntervalMs: 1000 },
  discovery: { discover: async () => [{ tenantId: c.s.ctx.tenantId, workspaceId: c.s.ctx.workspaceId }] },
  killSwitchEngaged: () => false,
});
async function drain(w: ReturnType<typeof worker>, max = 6): Promise<void> { for (let i = 0; i < max; i += 1) { const r = await w.runOnce(); if (r.claimed === 0) return; } }
const balance = async (balanceId: string) => (await q(`SELECT reorder_point::float rp, reorder_quantity::float rq, version, reorder_policy_state state, quantity_on_hand::float qty FROM ${BO}.inventory_balances WHERE id=$1`, [balanceId]))[0];
const put = (w: World, url: string, payload: unknown) => app.inject({ method: 'PUT', url, headers: dk.headers(w, { 'idempotency-key': unique('key') }), payload: payload as never });

/** The DAL-fed seed: the source records enter through Data Acquisition and the BO intake; the first policy and the currency through their own governed routes. */
function dalSeed(w: World) {
  return async (_s: Session) => {
    const ids = await dk.ingestFirstAction(w, 'SKU-P', 'WH-P', firstActionRecords('SKU-P', 'WH-P'));
    expect((await put(w, `/v1/businesses/${w.businessId}/inventory-items/${ids.itemId}/warehouses/${ids.warehouseId}/initial-reorder-policy`, { reorderPoint: 170, reorderQuantity: 190 })).statusCode).toBe(200);
    expect((await put(w, `/v1/businesses/${w.businessId}/declared-currency`, { currency: 'USD', expectedVersion: null, reason: 'initial declaration' })).statusCode).toBe(201);
    return { itemId: ids.itemId!, warehouseId: ids.warehouseId!, balanceId: ids.balanceId! };
  };
}
const sessionOf = (w: World): Session => ({ ctx: w.ctx, token: w.token, bizId: w.businessId, membershipId: w.membershipId });

describe.runIf(run)('AC-2 Block 8: the principal first-action chain, source data to OM verification', () => {
  beforeAll(async () => {
    createPool({ connectionString: process.env.DATABASE_URL! });
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
    app = await buildApp(loadConfig({ DATABASE_URL: process.env.DATABASE_URL!, NODE_ENV: 'test', LOG_LEVEL: 'silent', RATE_LIMIT_MAX: '5000' }));
    await app.ready();
    ck = chainKit({ app, admin, tenantIds });
    dk = dalKit({ app, admin, tenantIds });
  }, 60_000);
  afterAll(async () => {
    await app?.close();
    if (tenantIds.length > 0) {
      const c = await admin.connect();
      try {
        await c.query('BEGIN'); await c.query("SET LOCAL session_replication_role = 'replica'");
        await c.query('DELETE FROM audit.audit_events WHERE tenant_id = ANY($1)', [tenantIds]);
        await c.query('DELETE FROM business_operations.inventory_policy_evaluations WHERE tenant_id = ANY($1)', [tenantIds]);
        await c.query('COMMIT');
      } catch { await c.query('ROLLBACK').catch(() => undefined); } finally { c.release(); }
      await deleteMovementsForTenants(admin, tenantIds);
    }
    await admin?.end(); await closePool();
  });

  /** The whole chain up to (not including) activation, with every upstream link asserted. Returns the authored chain. */
  async function authoredFromSource(mode: 'plain' | 'modify') {
    const w = await dk.world();
    const c = await ck.authorFromAdi({ mode, session: sessionOf(w), seed: dalSeed(w) });
    const tenant = c.s.ctx.tenantId;

    // 1. DAL: every source record was accepted with provenance; the collection run was published to Business Operations
    const runs = await q(`SELECT state, records_received, records_accepted, records_rejected FROM data_acquisition.collection_runs WHERE business_id=$1`, [w.businessId]);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ records_received: 15, records_accepted: 15, records_rejected: 0 });
    expect((await q(`SELECT 1 FROM data_acquisition.provenance_records WHERE business_id=$1`, [w.businessId]))).toHaveLength(15);
    // 2. BO truth came ONLY from DAL: every canonical master record carries the DAL source; nothing was seeded
    expect(await q(`SELECT source_system FROM platform.inventory_items WHERE business_id=$1`, [w.businessId])).toEqual([{ source_system: 'INFINICUS_DA' }]);
    expect(await q(`SELECT source_system FROM platform.warehouses WHERE business_id=$1`, [w.businessId])).toEqual([{ source_system: 'INFINICUS_DA' }]);
    expect(await q(`SELECT 1 FROM ${BO}.inventory_movements WHERE business_id=$1`, [w.businessId])).toHaveLength(13);
    // 3. BI evidence and the BDT state describe those BO facts and share one digest
    const biVersion = (await q(`SELECT id, metric_value_ids FROM business_intelligence.insight_package_versions WHERE business_id=$1`, [w.businessId]));
    expect(biVersion).toHaveLength(1);
    expect(biVersion[0].metric_value_ids).toHaveLength(3);
    const twin = await q(`SELECT s.id, s.status, v.value_json FROM business_digital_twin.digital_twin_snapshots s JOIN business_digital_twin.digital_twin_snapshot_versions sv ON sv.snapshot_id = s.id JOIN business_digital_twin.digital_twin_snapshot_values v ON v.snapshot_version_id = sv.id WHERE s.business_id=$1`, [w.businessId]);
    expect(twin).toHaveLength(1);
    expect(twin[0]).toMatchObject({ status: 'published' });
    expect(twin[0].value_json.references.biInsightPackageVersionId).toBe(biVersion[0].id);
    // 4. the ADI recommendation is the producer's (no fixture), derived from that governed evidence
    const stored = c.proposal;
    expect(proposalEvidenceProblems(stored)).toEqual([]);
    expect(stored.provenance).toMatchObject({ producer: 'adi-reorder-policy-recommendation-producer', method: 'DETERMINISTIC_RULE', ruleSetVersion: 'inventory-reorder-policy/v1.1.0' });
    const kinds = (stored.evidenceReferences as { kind: string; id?: string; digest: string }[]);
    expect(kinds.find((e) => e.kind === 'bi_inventory_evidence')!.id).toBe(biVersion[0].id);
    expect(kinds.find((e) => e.kind === 'bdt_inventory_item_state')!.id).toBe(twin[0].id);
    expect(new Set(kinds.map((e) => e.digest)).size).toBe(1);
    expect(twin[0].value_json.factsDigest).toBe(kinds[0].digest);
    expect(stored.proposedParameters).toEqual({ reorderPoint: 175, reorderQuantity: 190 }); // 12 x 75 issued over 90 days, cost 10 USD, baseline 170/190
    const version = (await q(`SELECT twin_snapshot_id, risk_class FROM ${ADI}.decision_recommendation_versions WHERE id=$1`, [c.recommendationVersionId]))[0];
    expect(version).toMatchObject({ twin_snapshot_id: twin[0].id, risk_class: 'medium' }); // canonical base risk, not an ADI literal
    expect(await q(`SELECT 1 FROM simulation.simulation_runs WHERE business_id=$1`, [w.businessId])).toHaveLength(0); // governed NOT_APPLICABLE: none fabricated
    // 5. ABA: decision, capture (the captured proposal IS ADI's), sealed package
    const cap = (await q(`SELECT decision_status, modification, proposed, final_parameters FROM ${ABA}.authorized_action_captures WHERE business_id=$1`, [w.businessId]))[0];
    expect(cap.proposed.value.source).toEqual({ layer: 'ADI', recordType: 'decision_recommendation', recordId: c.recommendationId });
    expect(cap.proposed.value.parameters).toEqual(stored.proposedParameters);
    if (mode === 'plain') { expect(cap.decision_status).toBe('approved'); expect(cap.modification.state).toBe('NOT_APPLICABLE'); expect(cap.final_parameters).toEqual(stored.proposedParameters); }
    else { expect(cap.decision_status).toBe('approved_with_modifications'); expect(cap.final_parameters).toEqual(FINAL); }
    expect(await q(`SELECT 1 FROM ${BO}.authorized_action_claims WHERE tenant_id=$1`, [tenant])).toHaveLength(0); // nothing has executed yet
    return { c, w, stored };
  }

  /** Activate, issue, run the worker. */
  async function authorizeAndRun(c: AdiChain) {
    expect((await ck.activate(c)).statusCode).toBe(200);
    const issued = await ck.issue(c);
    expect(issued.statusCode, issued.body).toBe(201);
    expect(issued.json()).toMatchObject({ outcome: 'ISSUED', status: 'ISSUED' });
    await drain(worker(c));
    return { packageId: issued.json().packageId as string };
  }

  async function expectExecutedAndVerified(c: AdiChain, packageId: string, finalValues: { reorderPoint: number; reorderQuantity: number }, versionBefore: number) {
    const tenant = c.s.ctx.tenantId;
    const claims = await q(`SELECT * FROM ${BO}.authorized_action_claims WHERE tenant_id=$1`, [tenant]);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ package_id: packageId });
    const ex = await q(`SELECT * FROM ${BO}.authorized_action_executions WHERE tenant_id=$1`, [tenant]);
    expect(ex).toHaveLength(1);
    expect(ex[0]).toMatchObject({ outcome: 'SUCCEEDED', mutation_result: 'APPLIED', authority_verdict: 'CURRENT', claim_id: claims[0].id, package_id: packageId });
    expect(JSON.stringify(ex[0].evidence)).toContain('BO_EVALUATION_EVIDENCE'); // the compare-and-set baseline came from BO's own evaluation records
    expect(ex[0].evidence.contractVersion).toBe('execution-evidence/1');
    expect(await balance(c.balanceId)).toMatchObject({ rp: finalValues.reorderPoint, rq: finalValues.reorderQuantity, version: versionBefore + 1, state: 'CONFIGURED', qty: 100 });
    const executed = await q(`SELECT * FROM events.outbox_events WHERE tenant_id=$1 AND event_type='operations.action.executed'`, [tenant]);
    expect(executed).toHaveLength(1);
    const v = await q('SELECT * FROM outcome_monitoring.action_execution_verifications WHERE tenant_id=$1', [tenant]);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ execution_id: ex[0].id, execution_state: 'EXECUTION_VERIFIED', outcome_state: 'OUTCOME_PENDING' });
    expect(learningEligibility({ executionState: v[0].execution_state, outcomeState: v[0].outcome_state, executionOutcome: v[0].execution_outcome, mutationResult: v[0].mutation_result }).eligible).toBe(false); // CL cannot consume OUTCOME_PENDING
    expect(await q('SELECT 1 FROM events.dead_letter_events WHERE tenant_id=$1', [tenant])).toHaveLength(0);
  }

  it('PRINCIPAL PROOF: source data -> DAL -> BO -> BI -> BDT -> ADI -> ABA (unmodified approval) -> package -> BO claim, fresh authority, baseline CAS, execution -> evidence -> executed event -> OM EXECUTION_VERIFIED / OUTCOME_PENDING -> CL ineligible', async () => {
    const { c, stored } = await authoredFromSource('plain');
    const before = await balance(c.balanceId);
    expect(before).toMatchObject({ rp: 170, rq: 190, state: 'CONFIGURED' }); // the BO-owned first policy; the proposal changes it only through ABA -> BO execution
    const { packageId } = await authorizeAndRun(c);
    await expectExecutedAndVerified(c, packageId, stored.proposedParameters as { reorderPoint: number; reorderQuantity: number }, before.version);
  }, 120_000);

  it('the same chain with an approver\'s MODIFICATION: BO executes the FINAL governed parameters; the original ADI proposal stays in the lineage', async () => {
    const { c } = await authoredFromSource('modify');
    const before = await balance(c.balanceId);
    const { packageId } = await authorizeAndRun(c);
    await expectExecutedAndVerified(c, packageId, FINAL, before.version);
  }, 120_000);

  it('baseline changed before execution: the newer BO state is NEVER overwritten and the action is refused (BASELINE_CHANGED)', async () => {
    const { c } = await authoredFromSource('plain');
    const bump = await admin.connect();
    try { await bump.query('BEGIN'); await bump.query("SET LOCAL session_replication_role = 'replica'"); await bump.query(`UPDATE ${BO}.inventory_balances SET reorder_point=171, reorder_quantity=191, version = version + 1 WHERE id=$1`, [c.balanceId]); await bump.query('COMMIT'); }
    catch (e) { await bump.query('ROLLBACK').catch(() => undefined); throw e; } finally { bump.release(); }
    const versionAfterBump = (await balance(c.balanceId)).version;
    const { packageId } = await authorizeAndRun(c);
    const ex = await q(`SELECT * FROM ${BO}.authorized_action_executions WHERE tenant_id=$1`, [c.s.ctx.tenantId]);
    expect(ex).toHaveLength(1);
    expect(ex[0]).toMatchObject({ outcome: 'REFUSED', mutation_result: 'NOT_APPLICABLE', package_id: packageId });
    expect(JSON.stringify(ex[0])).toContain('BASELINE_CHANGED');
    expect(await balance(c.balanceId)).toMatchObject({ rp: 171, rq: 191, version: versionAfterBump });
    const v = await q('SELECT * FROM outcome_monitoring.action_execution_verifications WHERE tenant_id=$1', [c.s.ctx.tenantId]);
    for (const row of v) expect(learningEligibility({ executionState: row.execution_state, outcomeState: row.outcome_state, executionOutcome: row.execution_outcome, mutationResult: row.mutation_result }).eligible).toBe(false);
  }, 120_000);

  it('this proof seeds nothing: its own source has no direct write to Business Operations or the platform master data, and never calls the SQL seeding of the shared kit', () => {
    const whole = readFileSync(__filename, 'utf8');
    const source = whole.slice(0, whole.indexOf("it('this proof seeds nothing")).split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n'); // everything before this guard (the guard names the forbidden tokens)
    expect(source).not.toMatch(/INSERT\s+INTO\s+(business_operations|platform)\./i);
    expect(source).not.toMatch(/seedBo\s*\(/);
    expect(source).not.toMatch(/createAbaFixture|fixtureProposal/);
    expect(ACTION).toEqual({ code: 'inventory_reorder_policy_update', schemaVersion: '1' });
  });
});
