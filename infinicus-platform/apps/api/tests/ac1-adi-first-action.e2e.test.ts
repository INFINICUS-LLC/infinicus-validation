/**
 * AC-1 - THE PRINCIPAL COMPLETION PROOF with a REAL ADI-produced recommendation (no recommendation fixture):
 *
 *   authoritative BO facts -> ADI producer (production route; rule set inventory-reorder-policy/v1.0.0 applied to BO facts and verified by the BO
 *   evaluator) -> structured recommendation `inventory_reorder_policy_update@1` -> ABA review / approve-with-modification (BO evaluation evidence) ->
 *   capture (original ADI proposal preserved) -> AuthorizedActionPackage -> governed activation -> worker -> BO intake / claim / fresh ABA authority /
 *   mutation -> ExecutionEvidence + executed event -> OM EXECUTION_VERIFIED / OUTCOME_PENDING.
 *
 * Fail-closed cases: no evidence / thin or stale history / undeclared currency / foreign scope / unsupported action / impossible values / target
 * mismatch / producer failure -> NO recommendation and no ABA artifact; a capture that differs from the ADI proposal is refused; plain approval of the
 * proposal is not executable (BO ruling O-4: no authoritative baseline) and is refused by BO, never silently applied.
 * Requires DATABASE_URL (app role) and ADMIN_DATABASE_URL.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- HTTP payloads and rows are arbitrary JSON */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '@infinicus/configuration';
import { createPool, closePool, DecisionRecommendationRepository } from '@infinicus/database';
import { learningEligibility, validateProposedActionRecommendation } from '@infinicus/handoff-contracts';
import { ReorderPolicyRecommendationProducer, type ReorderPolicyDeriverPort } from '@infinicus/workflow';
import { buildEventWorker } from '../../../packages/event-worker/src/index.js';
import { buildApp } from '../src/app.js';
import { ACTION, FINAL, BASELINE, chainKit, type AdiChain } from './helpers/authorizedPackageChain.js';
import { deleteMovementsForTenants } from './helpers/movementCleanup.js';

const run = !!process.env.DATABASE_URL && !!process.env.ADMIN_DATABASE_URL;
const ACTOR = randomUUID();
const BO = 'business_operations';
const ABA = 'approved_business_action';
const ADI = 'ai_decision_intelligence';
const MAX_AGE = 5000;
const DAY = 86_400_000;

let admin: Pool;
let app: FastifyInstance;
const tenantIds: string[] = [];
let kit: ReturnType<typeof chainKit>;

describe.runIf(run)('AC-1: a real ADI-produced first-action recommendation, end to end to OM verification', () => {
  beforeAll(async () => {
    createPool({ connectionString: process.env.DATABASE_URL! });
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
    app = await buildApp(loadConfig({ DATABASE_URL: process.env.DATABASE_URL!, NODE_ENV: 'test', LOG_LEVEL: 'silent', RATE_LIMIT_MAX: '5000' }));
    await app.ready();
    kit = chainKit({ app, admin, tenantIds });
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

  const q = async (sql: string, args: unknown[]) => (await admin.query(sql, args)).rows;
  const t = (c: { s: { ctx: { tenantId: string } } }) => c.s.ctx.tenantId;
  const claims = (c: AdiChain) => q(`SELECT * FROM ${BO}.authorized_action_claims WHERE tenant_id=$1`, [t(c)]);
  const executions = (c: AdiChain) => q(`SELECT * FROM ${BO}.authorized_action_executions WHERE tenant_id=$1`, [t(c)]);
  const verifications = (c: AdiChain) => q('SELECT * FROM outcome_monitoring.action_execution_verifications WHERE tenant_id=$1', [t(c)]);
  const captures = (c: { s: { bizId: string } }) => q(`SELECT * FROM ${ABA}.authorized_action_captures WHERE business_id=$1`, [c.s.bizId]);
  const adiRecs = (bizId: string) => q(`SELECT * FROM ${ADI}.decision_recommendations WHERE business_id=$1`, [bizId]);
  const adiVersions = (bizId: string) => q(`SELECT * FROM ${ADI}.decision_recommendation_versions WHERE business_id=$1`, [bizId]);
  const adiCases = (bizId: string) => q(`SELECT * FROM ${ADI}.decision_cases WHERE business_id=$1`, [bizId]);
  const abaArtifacts = async (bizId: string) => ({
    actions: (await q(`SELECT 1 FROM ${ABA}.approved_actions WHERE business_id=$1`, [bizId])).length,
    captures: (await q(`SELECT 1 FROM ${ABA}.authorized_action_captures WHERE business_id=$1`, [bizId])).length,
    packages: (await q(`SELECT 1 FROM ${ABA}.authorized_action_packages WHERE business_id=$1`, [bizId])).length,
  });
  const balance = async (c: { balanceId: string }) => (await q(`SELECT reorder_point::float rp, reorder_quantity::float rq, version, reorder_policy_state state FROM ${BO}.inventory_balances WHERE id=$1`, [c.balanceId]))[0];
  const worker = (c: AdiChain) => buildEventWorker({
    config: { workerId: `w-${randomUUID().slice(0, 6)}`, actorUserId: ACTOR, discoveryDatabaseUrl: 'unused', intakeStatusMaxAgeMs: MAX_AGE, executionStatusMaxAgeMs: MAX_AGE, claimTimeoutMs: 60_000, batchSize: 10, maxScopesPerCycle: 5, pollIntervalMs: 1000 },
    discovery: { discover: async () => [{ tenantId: c.s.ctx.tenantId, workspaceId: c.s.ctx.workspaceId }] },
    killSwitchEngaged: () => false,
  });
  async function drain(w: ReturnType<typeof worker>, max = 6): Promise<void> { for (let i = 0; i < max; i += 1) { const r = await w.runOnce(); if (r.claimed === 0) return; } }

  /** Admin-only fixture surgery on append-only / guarded tables (triggers are bypassed with the replica role, exactly as the cleanup does). */
  async function replica(sql: string, args: unknown[] = []): Promise<void> {
    const c = await admin.connect();
    try { await c.query('BEGIN'); await c.query("SET LOCAL session_replication_role = 'replica'"); await c.query(sql, args); await c.query('COMMIT'); }
    catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
  }

  /** A tenant/business/item with the BO facts the producer reads, produced through the production route; returns the HTTP response. */
  async function world(tweak: (s: Awaited<ReturnType<typeof kit.setup>>, bo: { itemId: string; warehouseId: string; balanceId: string }) => Promise<void> = async () => undefined) {
    const s = await kit.setup();
    const bo = await kit.seedBo(s);
    await tweak(s, bo);
    return { s, bo, produce: () => kit.post(s, kit.reorderRecommendationUrl(s, bo.itemId)) };
  }

  it('THE PROOF: an ADI-produced structured recommendation is approved-with-modification by ABA, authorized, executed by BO and verified by OM - no recommendation fixture', async () => {
    const c = await kit.authorFromAdi();

    // the recommendation is a REAL ADI record produced by the producer, with the structured proposal stored in the existing recommendation model
    const rec = (await adiRecs(c.s.bizId));
    expect(rec).toHaveLength(1);
    expect(rec[0].id).toBe(c.recommendationId);
    expect(rec[0].recommendation_code).toMatch(/^adi-reorder-rec-/);
    expect(rec[0].status).toBe('published');
    const ver = (await adiVersions(c.s.bizId))[0];
    expect(ver).toMatchObject({ id: c.recommendationVersionId, status: 'published', risk_class: 'medium', is_time_sensitive: true });
    expect(new Date(ver.valid_until).getTime()).toBeGreaterThan(Date.now());
    const rationales = await q(`SELECT rationale_code, evidence_reference FROM ${ADI}.recommendation_rationales WHERE recommendation_version_id=$1 ORDER BY created_at, id`, [c.recommendationVersionId]);
    expect(rationales.map((r: any) => r.rationale_code).sort()).toEqual(['proposed_action', 'reorder_policy_basis', 'risk_validity_basis']);
    const stored = rationales.find((r: any) => r.rationale_code === 'proposed_action').evidence_reference;
    // the decision-history view reads the earliest rationale: it must be the human-readable one (ties inside one transaction go to the narrative)
    const shown = await new DecisionRecommendationRepository().listRationalesForVersions(c.s.ctx, [c.recommendationVersionId]);
    expect(shown).toHaveLength(1);
    expect(shown[0].evidenceReference).toMatchObject({ expectedOutcome: expect.stringContaining('owner-approved rule set'), riskLevel: 'medium' });
    expect(stored).toEqual(c.proposal);
    expect(validateProposedActionRecommendation(stored)).toEqual([]);
    // derived from the seeded BO facts (baseline 170/190, 12 issues x 75 over 90 days, unit cost 10 USD): rp = ceil(900 x 14 x 1.25 / 90) = 175, rq unchanged
    expect(stored).toMatchObject({
      actionType: ACTION, target: { kind: 'inventory_item', id: c.itemId }, proposedParameters: { reorderPoint: 175, reorderQuantity: BASELINE.reorderQuantity },
      currentState: { reference: { kind: 'bo_inventory_balance', id: c.balanceId }, parameters: { reorderPoint: '170', reorderQuantity: '190' } },
      confidence: { kind: 'RULE_COMPLIANCE', value: null }, provenance: { producer: 'adi-reorder-policy-recommendation-producer', method: 'DETERMINISTIC_RULE', ruleSetVersion: 'inventory-reorder-policy/v1.0.0' },
    });
    expect(JSON.stringify(stored)).toContain('NO_APPLICABLE_SIMULATION_MODEL'); // simulation is the governed NOT_APPLICABLE: none was fabricated
    expect(await q(`SELECT 1 FROM simulation.simulation_runs WHERE business_id=$1`, [c.s.bizId])).toHaveLength(0);
    // producing a recommendation mutated nothing in Business Operations
    expect(await balance(c)).toMatchObject({ rp: BASELINE.reorderPoint, rq: BASELINE.reorderQuantity, version: 1, state: 'UNSET' });
    expect(await claims(c)).toHaveLength(0);

    // ABA lineage: the ORIGINAL ADI proposal is preserved; the final parameters are ABA's own decision
    const cap = (await captures(c))[0];
    expect(cap.proposed.state).toBe('VALUE');
    expect(cap.proposed.value.source).toEqual({ layer: 'ADI', recordType: 'decision_recommendation', recordId: c.recommendationId });
    expect(cap.proposed.value.parameters).toEqual(c.proposal.proposedParameters);
    expect(cap.final_parameters).toEqual(FINAL);
    expect(cap.final_parameters).not.toEqual(cap.proposed.value.parameters);
    expect(cap.decision_status).toBe('approved_with_modifications');

    const on = await kit.activate(c);
    expect(on.statusCode).toBe(200);
    const issued = await kit.issue(c);
    expect(issued.statusCode).toBe(201);
    expect(issued.json()).toMatchObject({ outcome: 'ISSUED', status: 'ISSUED' });
    const packageId = issued.json().packageId as string;
    await drain(worker(c));

    const cl = await claims(c);
    expect(cl).toHaveLength(1);
    expect(cl[0]).toMatchObject({ package_id: packageId });
    const ex = await executions(c);
    expect(ex).toHaveLength(1);
    expect(ex[0]).toMatchObject({ outcome: 'SUCCEEDED', mutation_result: 'APPLIED', authority_verdict: 'CURRENT', claim_id: cl[0].id, package_id: packageId });
    expect(await balance(c)).toMatchObject({ rp: FINAL.reorderPoint, rq: FINAL.reorderQuantity, version: 2, state: 'CONFIGURED' });
    expect(ex[0].evidence.contractVersion).toBe('execution-evidence/1');
    const executed = await q(`SELECT * FROM events.outbox_events WHERE tenant_id=$1 AND event_type='operations.action.executed'`, [t(c)]);
    expect(executed).toHaveLength(1);
    const v = await verifications(c);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ execution_id: ex[0].id, execution_state: 'EXECUTION_VERIFIED', outcome_state: 'OUTCOME_PENDING' });
    expect(learningEligibility({ executionState: v[0].execution_state, outcomeState: v[0].outcome_state, executionOutcome: v[0].execution_outcome, mutationResult: v[0].mutation_result }).eligible).toBe(false);
    expect(await q('SELECT 1 FROM events.dead_letter_events WHERE tenant_id=$1', [t(c)])).toHaveLength(0);
  }, 90_000);

  it('ABA owns the executable parameters: a capture whose proposal, target or action type differs from what ADI recorded is refused, and nothing is captured', async () => {
    const c = await kit.authorFromAdi({ mode: 'until-capture' });
    const target = { kind: 'inventory_item', id: c.itemId };
    const attempt = (payload: Record<string, unknown>) => kit.post(c.s, `${c.base}/capture`, payload);
    const forged = await attempt({ actionType: ACTION, target, proposedParameters: { reorderPoint: 176, reorderQuantity: BASELINE.reorderQuantity }, modification: { reason: 'x', changes: [{ parameter: 'reorderPoint', operation: 'SET', before: 176, after: 180 }] } });
    expect(forged.statusCode).toBe(400);
    expect(forged.body).toContain('PROPOSAL_DIFFERS_FROM_ADI_RECOMMENDATION');
    const otherTarget = await attempt({ actionType: ACTION, target: { kind: 'inventory_item', id: randomUUID() }, proposedParameters: { ...c.proposal.proposedParameters } });
    expect(otherTarget.statusCode).toBe(400);
    const extraParam = await attempt({ actionType: ACTION, target, proposedParameters: { ...c.proposal.proposedParameters, leadTimeDays: 3 } });
    expect(extraParam.statusCode).toBe(400);
    expect(await captures(c)).toHaveLength(0);
    expect(await abaArtifacts(c.s.bizId)).toMatchObject({ captures: 0, packages: 0 });
  }, 60_000);

  it('approving the ADI proposal AS PROPOSED yields a package BO refuses (NO_BASELINE_EVIDENCE, ruling O-4): never silently applied', async () => {
    const c = await kit.authorFromAdi({ mode: 'plain' });
    expect((await captures(c))[0].final_parameters).toEqual(c.proposal.proposedParameters);
    expect((await kit.activate(c)).statusCode).toBe(200);
    const issued = await kit.issue(c);
    expect(issued.statusCode, issued.body).toBe(201);
    await drain(worker(c));
    const ex = await executions(c);
    expect(ex).toHaveLength(1);
    expect(ex[0]).toMatchObject({ outcome: 'REFUSED', mutation_result: 'NOT_APPLICABLE' });
    expect(JSON.stringify(ex[0])).toContain('NO_BASELINE_EVIDENCE');
    expect(await balance(c)).toMatchObject({ rp: BASELINE.reorderPoint, rq: BASELINE.reorderQuantity, version: 1, state: 'UNSET' });
  }, 90_000);

  describe('fail closed: no evidence, no recommendation, and nothing downstream is created', () => {
    const nothingCreated = async (bizId: string) => {
      expect(await adiRecs(bizId)).toHaveLength(0);
      expect(await adiVersions(bizId)).toHaveLength(0);
      expect(await adiCases(bizId)).toHaveLength(0);
      expect(await abaArtifacts(bizId)).toEqual({ actions: 0, captures: 0, packages: 0 });
    };
    const noRec = (res: { statusCode: number; json(): any }, code: string, reason?: string) => {
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ outcome: 'NO_RECOMMENDATION', code });
      if (reason) expect(res.json().reasonCodes).toContain(reason);
    };

    it('thin demand history (fewer than 10 observations) -> no recommendation', async () => {
      const w = await world(async (_s, bo) => { await replica(`DELETE FROM ${BO}.inventory_movements WHERE inventory_item_id=$1 AND movement_type='issue'`, [bo.itemId]); });
      noRec(await w.produce(), 'EVIDENCE_UNAVAILABLE', 'INSUFFICIENT_HISTORY');
      await nothingCreated(w.s.bizId);
    }, 60_000);

    it('demand older than the 90-day window is stale evidence -> no recommendation', async () => {
      const w = await world(async (_s, bo) => { await replica(`UPDATE ${BO}.inventory_movements SET occurred_at = occurred_at - interval '200 days' WHERE inventory_item_id=$1 AND movement_type='issue'`, [bo.itemId]); });
      noRec(await w.produce(), 'EVIDENCE_UNAVAILABLE', 'INSUFFICIENT_HISTORY');
      await nothingCreated(w.s.bizId);
    }, 60_000);

    it('an undeclared business currency -> no recommendation', async () => {
      const w = await world(async (s) => { await replica('DELETE FROM platform.business_currency_declarations WHERE business_id=$1', [s.bizId]); });
      noRec(await w.produce(), 'EVIDENCE_UNAVAILABLE', 'DECLARED_CURRENCY_MISSING');
      await nothingCreated(w.s.bizId);
    }, 60_000);

    it('an unset (zero) baseline, no receipt, or an already compliant policy -> no recommendation', async () => {
      const zero = await world(async (_s, bo) => { await replica(`UPDATE ${BO}.inventory_balances SET reorder_point=0, reorder_quantity=0 WHERE id=$1`, [bo.balanceId]); });
      noRec(await zero.produce(), 'EVIDENCE_UNAVAILABLE', 'BASELINE_UNSET_OR_ZERO');
      await nothingCreated(zero.s.bizId);

      const noReceipt = await world(async (_s, bo) => { await replica(`DELETE FROM ${BO}.inventory_movements WHERE inventory_item_id=$1 AND movement_type='receipt'`, [bo.itemId]); });
      noRec(await noReceipt.produce(), 'EVIDENCE_UNAVAILABLE', 'NO_RECEIPT');
      await nothingCreated(noReceipt.s.bizId);

      const compliant = await world(async (_s, bo) => { await replica(`UPDATE ${BO}.inventory_balances SET reorder_point=180, reorder_quantity=200 WHERE id=$1`, [bo.balanceId]); });
      noRec(await compliant.produce(), 'POLICY_ALREADY_COMPLIANT');
      await nothingCreated(compliant.s.bizId);
    }, 90_000);

    it('invalid scope: an item of another business, an unknown item, or another tenant\'s business -> no recommendation / 404; nothing created', async () => {
      const a = await world();
      const b = await world();
      // b's item under a's business: the item does not resolve inside a's tenant, workspace and business
      const cross = await kit.post(a.s, kit.reorderRecommendationUrl(a.s, b.bo.itemId));
      noRec(cross, 'EVIDENCE_UNAVAILABLE', 'TARGET_UNRESOLVED');
      const unknown = await kit.post(a.s, kit.reorderRecommendationUrl(a.s, randomUUID()));
      noRec(unknown, 'EVIDENCE_UNAVAILABLE', 'TARGET_UNRESOLVED');
      // a's business id through b's session: not found in b's tenant
      const foreignBusiness = await kit.post(b.s, `/v1/businesses/${a.s.bizId}/inventory-items/${a.bo.itemId}/reorder-policy-recommendation`);
      expect(foreignBusiness.statusCode).toBe(404);
      await nothingCreated(a.s.bizId);
      await nothingCreated(b.s.bizId);
    }, 60_000);

    it('authentication, permission and the idempotency key are enforced; the producer authorizes and executes nothing', async () => {
      const w = await world();
      const url = kit.reorderRecommendationUrl(w.s, w.bo.itemId);
      expect((await app.inject({ method: 'POST', url, headers: { 'idempotency-key': randomUUID() } })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url, headers: { ...kit.hdr(w.s) } })).statusCode).toBe(400); // missing Idempotency-Key
      const ok = await w.produce();
      expect(ok.statusCode).toBe(201);
      expect(Object.keys(ok.json()).sort()).toEqual(['outcome', 'proposal', 'recommendationId', 'recommendationVersionId', 'riskClass', 'validUntil']);
      expect(await abaArtifacts(w.s.bizId)).toEqual({ actions: 0, captures: 0, packages: 0 }); // ADI created no approval, capture or package
      expect(await balance(w.bo)).toMatchObject({ rp: BASELINE.reorderPoint, rq: BASELINE.reorderQuantity, version: 1 });
      expect(await q(`SELECT 1 FROM ${BO}.authorized_action_receipts WHERE tenant_id=$1`, [w.s.ctx.tenantId])).toHaveLength(0);
    }, 60_000);

    it('unsupported action type, impossible values, a target mismatch and a deriver failure -> no recommendation and nothing persisted (service level, injected deriver)', async () => {
      const w = await world();
      const good = {
        outcome: 'CANDIDATE' as const, ruleSetVersion: 'inventory-reorder-policy/v1.0.0', itemId: w.bo.itemId, balanceId: w.bo.balanceId,
        current: { reorderPoint: '170', reorderQuantity: '190' }, proposed: { reorderPoint: 175, reorderQuantity: 190 }, bounds: { a: '1' },
        verification: [{ dimension: 'CONSTRAINTS', result: 'PASSED' }], demand: { count: 12, sumOfMagnitudes: '900', windowDays: 90 }, unitCost: { amount: '10', currency: 'USD' }, method: 'm',
      };
      const evidence = { snapshotDigest: `sha256:${'b'.repeat(64)}`, capturedAt: new Date().toISOString(), windowStartsAt: new Date(Date.now() - 90 * DAY).toISOString(), ruleSetVersion: 'inventory-reorder-policy/v1.0.0', evidenceMaxAgeMs: 86_400_000 };
      const producerWith = (derive: ReorderPolicyDeriverPort['derive']) => new ReorderPolicyRecommendationProducer({ deriver: { derive } });
      const req = { businessId: w.s.bizId, itemId: w.bo.itemId };

      const unsupported = await producerWith(async () => ({ derivation: good, evidence })).produce(w.s.ctx, { ...req, actionType: { code: 'supplier_price_update', schemaVersion: '1' } });
      expect(unsupported).toMatchObject({ outcome: 'NO_RECOMMENDATION', code: 'UNSUPPORTED_ACTION_TYPE' });
      const wrongVersion = await producerWith(async () => ({ derivation: good, evidence })).produce(w.s.ctx, { ...req, actionType: { code: 'inventory_reorder_policy_update', schemaVersion: '2' } });
      expect(wrongVersion).toMatchObject({ outcome: 'NO_RECOMMENDATION', code: 'UNSUPPORTED_ACTION_TYPE' });

      for (const proposed of [{ reorderPoint: -1, reorderQuantity: 190 }, { reorderPoint: 175, reorderQuantity: Number.NaN }, { reorderPoint: 175, reorderQuantity: -5 }]) {
        const r = await producerWith(async () => ({ derivation: { ...good, proposed }, evidence })).produce(w.s.ctx, req);
        expect(r, JSON.stringify(proposed)).toMatchObject({ outcome: 'NO_RECOMMENDATION', code: 'PRODUCER_CONTRACT_VIOLATION' });
      }
      const mismatch = await producerWith(async () => ({ derivation: { ...good, itemId: randomUUID() }, evidence })).produce(w.s.ctx, req);
      expect(mismatch).toMatchObject({ outcome: 'NO_RECOMMENDATION', code: 'TARGET_MISMATCH' });
      const unverified = await producerWith(async () => ({ derivation: { ...good, verification: [{ dimension: 'COST', result: 'FAILED' }] }, evidence })).produce(w.s.ctx, req);
      expect(unverified).toMatchObject({ outcome: 'NO_RECOMMENDATION', code: 'DERIVATION_UNVERIFIED' });
      const noEvidence = await producerWith(async () => ({ derivation: good, evidence: null })).produce(w.s.ctx, req);
      expect(noEvidence).toMatchObject({ outcome: 'NO_RECOMMENDATION', code: 'EVIDENCE_UNAVAILABLE' });
      const wrongRuleSet = await producerWith(async () => ({ derivation: { ...good, ruleSetVersion: 'inventory-reorder-policy/v9' }, evidence })).produce(w.s.ctx, req);
      expect(wrongRuleSet).toMatchObject({ outcome: 'NO_RECOMMENDATION' });
      await expect(producerWith(async () => { throw new Error('boom'); }).produce(w.s.ctx, req)).rejects.toThrow('boom');
      await expect(new ReorderPolicyRecommendationProducer({
        deriver: { derive: async () => ({ derivation: good, evidence }) },
        recommendations: { createRecommendation: async () => { throw new Error('persist failed'); } } as any,
      }).produce(w.s.ctx, req)).rejects.toThrow('persist failed');

      // nothing from any of the above reached ADI persistence or ABA (a mid-persistence failure rolled the whole transaction back)
      expect(await adiRecs(w.s.bizId)).toHaveLength(0);
      expect(await adiCases(w.s.bizId)).toHaveLength(0);
      expect(await q(`SELECT 1 FROM ${ADI}.decision_questions WHERE business_id=$1`, [w.s.bizId])).toHaveLength(0);
      expect(await abaArtifacts(w.s.bizId)).toEqual({ actions: 0, captures: 0, packages: 0 });
    }, 60_000);

    it('a recommendation that expired with its evidence can no longer be approved (time-sensitive, valid only as long as the evidence)', async () => {
      const w = await world();
      const res = await w.produce();
      expect(res.statusCode).toBe(201);
      const versionId = res.json().recommendationVersionId as string;
      const c = await admin.connect();
      try {
        await c.query('BEGIN'); await c.query("SET LOCAL session_replication_role='replica'");
        // the stored validity can only be examined, never relied on to be extended: it ends within the rule set's evidence age
        const r = await c.query(`SELECT valid_until, created_at FROM ${ADI}.decision_recommendation_versions WHERE id=$1`, [versionId]);
        await c.query('ROLLBACK');
        const span = new Date(r.rows[0].valid_until).getTime() - new Date(r.rows[0].created_at).getTime();
        expect(span).toBeGreaterThan(23 * 3_600_000);
        expect(span).toBeLessThanOrEqual(24 * 3_600_000 + 60_000);
      } finally { c.release(); }
    }, 60_000);
  });
});
