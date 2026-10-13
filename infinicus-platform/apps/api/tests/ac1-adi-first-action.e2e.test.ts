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
import { createPool, closePool, DecisionRecommendationRepository, ApprovedActionRepository } from '@infinicus/database';
import { STRUCTURED_ADI_PROPOSAL_REQUIRED, boEvaluationReferences, canonicalBaseRiskClass, learningEligibility, proposalEvidenceProblems, validateProposedActionRecommendation } from '@infinicus/handoff-contracts';
import { ReorderPolicyRecommendationProducer, DEFAULT_APPROVER_ASSIGNMENT_CODE, type ReorderPolicyDeriverPort } from '@infinicus/workflow';
import { ReorderPolicyBaselineEvidenceRecorder, ReorderPolicyDerivationService } from '@infinicus/business-operations-runtime';
import { buildEventWorker } from '../../../packages/event-worker/src/index.js';
import { buildApp } from '../src/app.js';
import { ACTION, FINAL, BASELINE, chainKit, type AdiChain } from './helpers/authorizedPackageChain.js';
import { deleteMovementsForTenants } from './helpers/movementCleanup.js';
import { createAbaFixture, APPROVABLE_FACTS, uc } from './helpers/abaFixtures.js';

/** AC-2 owner ruling 1: the canonical base risk of the first action is MEDIUM; the test reads it from the contract and also pins the ruling. */
const CANONICAL_BASE = canonicalBaseRiskClass('inventory_reorder_policy_update', '1');

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

  /** Shared assertions: the recommendation is a REAL ADI record produced by the producer, with the structured proposal inside the existing model. */
  async function expectRealAdiRecommendation(c: AdiChain) {
    const rec = await adiRecs(c.s.bizId);
    expect(rec).toHaveLength(1);
    expect(rec[0].id).toBe(c.recommendationId);
    expect(rec[0].recommendation_code).toMatch(/^adi-reorder-rec-/);
    expect(rec[0].status).toBe('published');
    // AC-2: the class is the canonical action-type BASE risk (medium), read from the canonical contract - ADI authors no level of its own
    const ver = (await adiVersions(c.s.bizId))[0];
    expect(ver).toMatchObject({ id: c.recommendationVersionId, status: 'published', risk_class: CANONICAL_BASE, is_time_sensitive: true });
    expect(new Date(ver.valid_until).getTime()).toBeGreaterThan(Date.now());
    const rationales = await q(`SELECT rationale_code, evidence_reference FROM ${ADI}.recommendation_rationales WHERE recommendation_version_id=$1`, [c.recommendationVersionId]);
    expect(rationales.map((r: any) => r.rationale_code).sort()).toEqual(['proposed_action', 'reorder_policy_basis', 'risk_validity_basis']);
    const stored = rationales.find((r: any) => r.rationale_code === 'proposed_action').evidence_reference;
    const shown = await new DecisionRecommendationRepository().listRationalesForVersions(c.s.ctx, [c.recommendationVersionId]);
    expect(shown[0].evidenceReference).toMatchObject({ expectedOutcome: expect.stringContaining('owner-approved rule set') });
    expect(stored).toEqual(c.proposal);
    expect(validateProposedActionRecommendation(stored)).toEqual([]);
    expect(proposalEvidenceProblems(stored)).toEqual([]);
    // derived from the seeded BO facts (baseline 170/190, 12 issues x 75 over 90 days, unit cost 10 USD): rp = ceil(900 x 14 x 1.25 / 90) = 175, rq unchanged
    expect(stored).toMatchObject({
      actionType: ACTION, target: { kind: 'inventory_item', id: c.itemId }, proposedParameters: { reorderPoint: 175, reorderQuantity: BASELINE.reorderQuantity },
      currentState: { reference: { kind: 'bo_inventory_balance', id: c.balanceId }, parameters: { reorderPoint: '170', reorderQuantity: '190' } },
      confidence: { kind: 'RULE_COMPLIANCE', value: null }, constraints: { ruleSetVersion: 'inventory-reorder-policy/v1.1.0' },
      provenance: { producer: 'adi-reorder-policy-recommendation-producer', method: 'DETERMINISTIC_RULE', ruleSetVersion: 'inventory-reorder-policy/v1.1.0' },
    });
    // the proposal cites the facts it was derived from AND BO's four evaluation records of exactly its parameters (the authoritative baseline)
    expect(boEvaluationReferences(stored).map((r) => r.dimension).sort()).toEqual(['CONSTRAINTS', 'COST', 'EXPECTED_OUTCOME', 'RESOURCE_REQUIREMENTS']);
    const evals = await q(`SELECT dimension, result, rule_set_version, inputs->>'snapshotDigest' d FROM ${BO}.inventory_policy_evaluations WHERE business_id=$1`, [c.s.bizId]);
    expect(evals.filter((e: any) => boEvaluationReferences(stored).some((r) => r.dimension === e.dimension))).toEqual(expect.arrayContaining([expect.objectContaining({ result: 'PASSED', rule_set_version: 'inventory-reorder-policy/v1.1.0' })]));
    expect(stored.evidenceReferences.every((e: any) => e.digest === stored.evidenceReferences[0].digest)).toBe(true);
    expect(JSON.stringify(stored)).toContain('NO_APPLICABLE_SIMULATION_MODEL'); // simulation is the governed NOT_APPLICABLE: none was fabricated
    expect(await q(`SELECT 1 FROM simulation.simulation_runs WHERE business_id=$1`, [c.s.bizId])).toHaveLength(0);
    // producing a recommendation mutated nothing in Business Operations
    expect(await balance(c)).toMatchObject({ rp: BASELINE.reorderPoint, rq: BASELINE.reorderQuantity, version: 1, state: 'UNSET' });
    expect(await claims(c)).toHaveLength(0);
    return stored;
  }

  /** Activate, issue, run the worker; returns the single execution row. */
  async function authorizeAndRun(c: AdiChain) {
    expect((await kit.activate(c)).statusCode).toBe(200);
    const issued = await kit.issue(c);
    expect(issued.statusCode, issued.body).toBe(201);
    expect(issued.json()).toMatchObject({ outcome: 'ISSUED', status: 'ISSUED' });
    await drain(worker(c));
    return { packageId: issued.json().packageId as string, digest: issued.json().digest as string };
  }

  /** The shared tail of both principal proofs: BO executed under fresh authority with baseline CAS, evidence and event committed together, OM verified. */
  async function expectExecutedAndVerified(c: AdiChain, packageId: string, finalValues: { reorderPoint: number; reorderQuantity: number }) {
    const cl = await claims(c);
    expect(cl).toHaveLength(1);
    expect(cl[0]).toMatchObject({ package_id: packageId });
    const ex = await executions(c);
    expect(ex).toHaveLength(1);
    expect(ex[0]).toMatchObject({ outcome: 'SUCCEEDED', mutation_result: 'APPLIED', authority_verdict: 'CURRENT', claim_id: cl[0].id, package_id: packageId });
    // the compare-and-set baseline came from BO's own evaluation records, the same four the ADI proposal cites
    expect(ex[0].evidence.mutation?.baselineSource ?? ex[0].evidence.baselineSource ?? JSON.stringify(ex[0].evidence)).toContain('BO_EVALUATION_EVIDENCE');
    expect(await balance(c)).toMatchObject({ rp: finalValues.reorderPoint, rq: finalValues.reorderQuantity, version: 2, state: 'CONFIGURED' });
    expect(ex[0].evidence.contractVersion).toBe('execution-evidence/1');
    const executed = await q(`SELECT * FROM events.outbox_events WHERE tenant_id=$1 AND event_type='operations.action.executed'`, [t(c)]);
    expect(executed).toHaveLength(1);
    const v = await verifications(c);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ execution_id: ex[0].id, execution_state: 'EXECUTION_VERIFIED', outcome_state: 'OUTCOME_PENDING' });
    expect(learningEligibility({ executionState: v[0].execution_state, outcomeState: v[0].outcome_state, executionOutcome: v[0].execution_outcome, mutationResult: v[0].mutation_result }).eligible).toBe(false);
    expect(await q('SELECT 1 FROM events.dead_letter_events WHERE tenant_id=$1', [t(c)])).toHaveLength(0);
    return ex[0];
  }

  it('PRINCIPAL PROOF A (unmodified): ADI proposes, ABA approves it UNCHANGED, BO executes it under fresh authority with baseline CAS, OM verifies - no recommendation fixture, no artificial modification', async () => {
    const c = await kit.authorFromAdi({ mode: 'plain' });
    const proposal = await expectRealAdiRecommendation(c);
    // ABA lineage: the approval is plain; the final parameters ARE the original ADI proposal
    const cap = (await captures(c))[0];
    expect(cap.decision_status).toBe('approved');
    expect(cap.modification.state).toBe('NOT_APPLICABLE');
    expect(cap.proposed.value.source).toEqual({ layer: 'ADI', recordType: 'decision_recommendation', recordId: c.recommendationId });
    expect(cap.proposed.value.parameters).toEqual(proposal.proposedParameters);
    expect(cap.final_parameters).toEqual(proposal.proposedParameters);
    const { packageId } = await authorizeAndRun(c);
    const ex = await expectExecutedAndVerified(c, packageId, proposal.proposedParameters);
    expect(JSON.stringify(ex.evidence)).toContain(boEvaluationReferences(proposal)[0].id); // the baseline evidence is the proposal's own cited record
  }, 90_000);

  it('PRINCIPAL PROOF B (modified): ADI proposes, ABA modifies with a final governed BO evaluation, BO executes the FINAL parameters with baseline CAS, OM verifies; the original proposal stays in the lineage', async () => {
    const c = await kit.authorFromAdi({ mode: 'modify' });
    const proposal = await expectRealAdiRecommendation(c);
    const cap = (await captures(c))[0];
    expect(cap.decision_status).toBe('approved_with_modifications');
    expect(cap.proposed.value.source).toEqual({ layer: 'ADI', recordType: 'decision_recommendation', recordId: c.recommendationId });
    expect(cap.proposed.value.parameters).toEqual(proposal.proposedParameters);
    expect(cap.final_parameters).toEqual(FINAL);
    expect(cap.final_parameters).not.toEqual(cap.proposed.value.parameters);
    const { packageId } = await authorizeAndRun(c);
    await expectExecutedAndVerified(c, packageId, FINAL);
  }, 90_000);

  describe('baseline compare-and-set protection (both approval kinds)', () => {
    const bump = (c: AdiChain, rp: number, rq: number) => replica(`UPDATE ${BO}.inventory_balances SET reorder_point=$2, reorder_quantity=$3, version = version + 1 WHERE id=$1`, [c.balanceId, rp, rq]);
    const refusal = async (c: AdiChain, packageId: string) => {
      const ex = await executions(c);
      expect(ex).toHaveLength(1);
      expect(ex[0]).toMatchObject({ outcome: 'REFUSED', mutation_result: 'NOT_APPLICABLE', package_id: packageId });
      return JSON.stringify(ex[0]);
    };

    it('PLAIN approval: a live balance that changed since the proposal was evaluated is BASELINE_CHANGED and the newer state is never overwritten', async () => {
      const c = await kit.authorFromAdi({ mode: 'plain' });
      await bump(c, 171, 191); // someone changed the policy after the ADI evaluation and before execution
      const { packageId } = await authorizeAndRun(c);
      expect(await refusal(c, packageId)).toContain('BASELINE_CHANGED');
      expect(await balance(c)).toMatchObject({ rp: 171, rq: 191, version: 2 });
    }, 90_000);

    it('MODIFIED approval: the same protection holds', async () => {
      const c = await kit.authorFromAdi({ mode: 'modify' });
      await bump(c, 171, 191);
      const { packageId } = await authorizeAndRun(c);
      expect(await refusal(c, packageId)).toContain('BASELINE_CHANGED');
      expect(await balance(c)).toMatchObject({ rp: 171, rq: 191, version: 2 });
    }, 90_000);

    it('PLAIN approval whose proposal no longer cites the complete BO evidence is NO_BASELINE_EVIDENCE: no baseline, no execution (O-4 is not weakened)', async () => {
      const c = await kit.authorFromAdi({ mode: 'plain' });
      // tamper AFTER the approval: the stored proposal loses one of the evaluation references BO resolves its baseline from
      await replica(`UPDATE ${ADI}.recommendation_rationales
                        SET evidence_reference = jsonb_set(evidence_reference, '{evidenceReferences}',
                              (SELECT jsonb_agg(e) FROM jsonb_array_elements(evidence_reference->'evidenceReferences') e WHERE e->>'dimension' IS DISTINCT FROM 'COST'))
                      WHERE recommendation_version_id=$1 AND rationale_code='proposed_action'`, [c.recommendationVersionId]);
      const { packageId } = await authorizeAndRun(c);
      expect(await refusal(c, packageId)).toContain('NO_BASELINE_EVIDENCE');
      expect(await balance(c)).toMatchObject({ rp: BASELINE.reorderPoint, rq: BASELINE.reorderQuantity, version: 1 });
    }, 90_000);

    it('PLAIN approval whose cited evaluation was made for DIFFERENT parameters is NO_BASELINE_EVIDENCE', async () => {
      const c = await kit.authorFromAdi({ mode: 'plain' });
      await replica(`UPDATE ${BO}.inventory_policy_evaluations SET subject_digest = 'sha256:' || repeat('0', 64) WHERE business_id=$1 AND dimension='COST'`, [c.s.bizId]);
      const { packageId } = await authorizeAndRun(c);
      expect(await refusal(c, packageId)).toContain('NO_BASELINE_EVIDENCE');
      expect(await balance(c)).toMatchObject({ rp: BASELINE.reorderPoint, version: 1 });
    }, 90_000);
  });

  describe('the structured proposal is MANDATORY for inventory_reorder_policy_update@1 (owner ruling 2)', () => {
    const target = (c: AdiChain) => ({ kind: 'inventory_item', id: c.itemId });
    const capture = (c: AdiChain, payload: Record<string, unknown>) => kit.post(c.s, `${c.base}/capture`, payload);
    const plainPayload = (c: AdiChain) => ({ actionType: ACTION, target: target(c), proposedParameters: { ...c.proposal.proposedParameters } });
    const refused = async (c: AdiChain, res: { statusCode: number; body: string }, fragment: string) => {
      expect(res.statusCode, res.body).toBeGreaterThanOrEqual(400);
      expect(res.body).toContain(fragment);
      expect(await captures(c)).toHaveLength(0);
      expect(await abaArtifacts(c.s.bizId)).toMatchObject({ captures: 0, packages: 0 });
    };
    const tamper = (c: AdiChain, expr: string) => replica(`UPDATE ${ADI}.recommendation_rationales SET evidence_reference = ${expr} WHERE recommendation_version_id=$1 AND rationale_code='proposed_action'`, [c.recommendationVersionId]);

    it('the control: an untampered ADI proposal is accepted by capture', async () => {
      const c = await kit.authorFromAdi({ mode: 'until-capture' });
      const res = await capture(c, plainPayload(c));
      expect(res.statusCode, res.body).toBe(201);
    }, 60_000);

    it('a NARRATIVE-ONLY recommendation (no structured proposal) cannot be captured, whatever parameters the caller supplies', async () => {
      const s = await kit.setup();
      await kit.governance(s);
      expect((await kit.post(s, `/v1/businesses/${s.bizId}/approver-assignments`, { approverUserId: s.ctx.userId, assignmentCode: DEFAULT_APPROVER_ASSIGNMENT_CODE, roleCode: 'business-owner' })).statusCode).toBe(201);
      const bo = await kit.seedBo(s);
      const { intakePackageId, recommendationId } = await createAbaFixture(s.ctx, s.bizId, APPROVABLE_FACTS);
      const d = await kit.post(s, `/v1/businesses/${s.bizId}/decisions`, { intakePackageId, reviewCode: uc('r'), summary: 'narrative only', assignmentCode: DEFAULT_APPROVER_ASSIGNMENT_CODE, decisionCode: uc('d'), outcome: 'approve' });
      expect(d.statusCode, d.body).toBe(201);
      const actions = new ApprovedActionRepository();
      const action = await actions.createAction(s.ctx, s.bizId, d.json().id, uc('act'), recommendationId);
      await actions.createVersion(s.ctx, action.id, s.bizId, 'narrative');
      const res = await kit.post(s, `/v1/businesses/${s.bizId}/authorized-actions/${action.id}/capture`, { actionType: ACTION, target: { kind: 'inventory_item', id: bo.itemId }, proposedParameters: { reorderPoint: 175, reorderQuantity: 190 } });
      expect(res.statusCode, res.body).toBeGreaterThanOrEqual(400);
      expect(res.body).toContain('ADI_PROPOSAL_REQUIRED');
      expect(await q(`SELECT 1 FROM ${ABA}.authorized_action_captures WHERE business_id=$1`, [s.bizId])).toHaveLength(0);
    }, 60_000);

    it('a caller-supplied proposal that differs from the stored ADI proposal (parameters, target, extra parameter) is refused', async () => {
      const c = await kit.authorFromAdi({ mode: 'until-capture' });
      await refused(c, await capture(c, { ...plainPayload(c), proposedParameters: { reorderPoint: 176, reorderQuantity: 190 } }), 'PROPOSAL_DIFFERS_FROM_ADI_RECOMMENDATION');
      await refused(c, await capture(c, { ...plainPayload(c), target: { kind: 'inventory_item', id: randomUUID() } }), 'PROPOSAL_DIFFERS_FROM_ADI_RECOMMENDATION');
      await refused(c, await capture(c, { ...plainPayload(c), proposedParameters: { ...c.proposal.proposedParameters, leadTimeDays: 3 } }), 'not declared');
    }, 60_000);

    it('a recommendation of ANOTHER business cannot back this action: scope must match', async () => {
      const c = await kit.authorFromAdi({ mode: 'until-capture' });
      const biz2 = randomUUID();
      await admin.query(`INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,'ZZ Other Biz',$4,'active')`, [biz2, c.s.ctx.tenantId, c.s.ctx.workspaceId, uc('other')]);
      // re-point the action's source recommendation to a recommendation owned by the other business
      const s2 = { ...c.s, bizId: biz2 };
      const bo2 = await kit.seedBo(s2);
      const produced = await kit.post(s2, kit.reorderRecommendationUrl(s2, bo2.itemId));
      expect(produced.statusCode, produced.body).toBe(201);
      await replica(`UPDATE ${ABA}.approved_actions SET source_recommendation_id=$2 WHERE id=$1`, [c.actionId, produced.json().recommendationId]);
      const res = await capture(c, { actionType: ACTION, target: { kind: 'inventory_item', id: bo2.itemId }, proposedParameters: { ...produced.json().proposal.proposedParameters } });
      expect(res.statusCode, res.body).toBeGreaterThanOrEqual(400);
      expect(res.body).toContain('ADI_PROPOSAL_SCOPE_MISMATCH');
      expect(await captures(c)).toHaveLength(0);
    }, 90_000);

    it('proposal provenance is required: a stored proposal without it is unusable (integrity error), never ignored', async () => {
      const c = await kit.authorFromAdi({ mode: 'until-capture' });
      await tamper(c, "evidence_reference - 'provenance'");
      const res = await capture(c, plainPayload(c));
      await refused(c, res, 'provenance');
    }, 60_000);

    it('the proposal must cite the evidence it rests on: removed evaluation references, a different snapshot digest, or an evaluation of other parameters are refused', async () => {
      const c = await kit.authorFromAdi({ mode: 'until-capture' });
      // (a) evidence removed
      await tamper(c, `jsonb_set(evidence_reference, '{evidenceReferences}', (SELECT jsonb_agg(e) FROM jsonb_array_elements(evidence_reference->'evidenceReferences') e WHERE e->>'kind' = 'bo_inventory_policy_facts'))`);
      await refused(c, await capture(c, plainPayload(c)), 'ADI_PROPOSAL_EVIDENCE_INCOMPLETE');
      // (b) a different fact-snapshot digest on the facts reference
      await tamper(c, `jsonb_set(evidence_reference, '{evidenceReferences}', (SELECT jsonb_agg(CASE WHEN e->>'kind'='bo_inventory_policy_facts' THEN jsonb_set(e,'{digest}',to_jsonb('sha256:' || repeat('a',64))) ELSE e END) FROM jsonb_array_elements((SELECT evidence_reference->'evidenceReferences' FROM ${ADI}.recommendation_rationales WHERE recommendation_version_id='${c.recommendationVersionId}' AND rationale_code='proposed_action')) e))`);
      await refused(c, await capture(c, plainPayload(c)), 'ADI_PROPOSAL_EVIDENCE');
    }, 60_000);

    it('evidence bound to DIFFERENT parameters, an unknown evaluation record and STALE evidence are each refused by the authoritative verifier', async () => {
      const wrongParams = await kit.authorFromAdi({ mode: 'until-capture' });
      await replica(`UPDATE ${BO}.inventory_policy_evaluations SET subject_digest = 'sha256:' || repeat('0', 64) WHERE business_id=$1 AND dimension='COST'`, [wrongParams.s.bizId]);
      await refused(wrongParams, await capture(wrongParams, plainPayload(wrongParams)), 'ADI_PROPOSAL_EVIDENCE_NOT_VERIFIED');

      const unknown = await kit.authorFromAdi({ mode: 'until-capture' });
      await tamper(unknown, `jsonb_set(evidence_reference, '{evidenceReferences}', (SELECT jsonb_agg(CASE WHEN e->>'dimension'='COST' THEN jsonb_set(e,'{id}',to_jsonb('${randomUUID()}'::text)) ELSE e END) FROM jsonb_array_elements((SELECT evidence_reference->'evidenceReferences' FROM ${ADI}.recommendation_rationales WHERE recommendation_version_id='${unknown.recommendationVersionId}' AND rationale_code='proposed_action')) e))`);
      await refused(unknown, await capture(unknown, plainPayload(unknown)), 'ADI_PROPOSAL_EVIDENCE_NOT_VERIFIED');

      const stale = await kit.authorFromAdi({ mode: 'until-capture' });
      await replica(`UPDATE ${BO}.inventory_policy_evaluations SET evaluated_at = evaluated_at - interval '2 days' WHERE business_id=$1`, [stale.s.bizId]);
      await refused(stale, await capture(stale, plainPayload(stale)), 'maximum evidence age');
    }, 120_000);

    it('the rule is per action type: another type is not subject to it (the requirement set holds exactly inventory_reorder_policy_update@1)', () => {
      expect([...STRUCTURED_ADI_PROPOSAL_REQUIRED]).toEqual(['inventory_reorder_policy_update@1']);
    });
  });

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

    it('unsupported action type, impossible values, a target mismatch, a failed evidence recording and a deriver failure -> no recommendation and nothing persisted (service level, injected deriver)', async () => {
      const w = await world();
      const RS = 'inventory-reorder-policy/v1.1.0';
      const good = {
        outcome: 'CANDIDATE' as const, ruleSetVersion: RS, itemId: w.bo.itemId, balanceId: w.bo.balanceId,
        current: { reorderPoint: '170', reorderQuantity: '190' }, proposed: { reorderPoint: 175, reorderQuantity: 190 }, bounds: { a: '1' },
        verification: [{ dimension: 'CONSTRAINTS', result: 'PASSED' }], demand: { count: 12, sumOfMagnitudes: '900', windowDays: 90 }, method: 'm',
      };
      const digest = `sha256:${'b'.repeat(64)}`;
      const evidence = { snapshotDigest: digest, capturedAt: new Date().toISOString(), windowStartsAt: new Date(Date.now() - 90 * DAY).toISOString(), ruleSetVersion: RS, evidenceMaxAgeMs: 86_400_000 };
      const okRecord = async () => ({ ok: true as const, snapshotDigest: digest, references: ['CONSTRAINTS', 'RESOURCE_REQUIREMENTS', 'COST', 'EXPECTED_OUTCOME'].map((dimension) => ({ kind: 'bo_inventory_policy_evaluation', id: randomUUID(), dimension })) });
      const producerWith = (derive: ReorderPolicyDeriverPort['derive'], recordBaselineEvidence: ReorderPolicyDeriverPort['recordBaselineEvidence'] = okRecord) => new ReorderPolicyRecommendationProducer({ deriver: { derive, recordBaselineEvidence } });
      const req = { businessId: w.s.bizId, itemId: w.bo.itemId };
      const rc = { permissionUsed: 'bo:write' };

      // the control: with a well-formed derivation and recording the injected producer does produce (so each refusal below is caused by its own defect)
      const control = await producerWith(async () => ({ derivation: good, evidence })).produce(w.s.ctx, req, rc);
      expect(control).toMatchObject({ outcome: 'RECOMMENDED' });
      await replica(`DELETE FROM ${ADI}.recommendation_rationales WHERE business_id=$1`, [w.s.bizId]).catch(() => undefined);

      const before = (await adiRecs(w.s.bizId)).length;
      const unsupported = await producerWith(async () => ({ derivation: good, evidence })).produce(w.s.ctx, { ...req, actionType: { code: 'supplier_price_update', schemaVersion: '1' } }, rc);
      expect(unsupported).toMatchObject({ outcome: 'NO_RECOMMENDATION', code: 'UNSUPPORTED_ACTION_TYPE' });
      const wrongVersion = await producerWith(async () => ({ derivation: good, evidence })).produce(w.s.ctx, { ...req, actionType: { code: 'inventory_reorder_policy_update', schemaVersion: '2' } }, rc);
      expect(wrongVersion).toMatchObject({ outcome: 'NO_RECOMMENDATION', code: 'UNSUPPORTED_ACTION_TYPE' });
      const noPermission = await producerWith(async () => ({ derivation: good, evidence })).produce(w.s.ctx, req, { permissionUsed: '' });
      expect(noPermission).toMatchObject({ outcome: 'NO_RECOMMENDATION', code: 'INVALID_REQUEST' });

      for (const proposed of [{ reorderPoint: -1, reorderQuantity: 190 }, { reorderPoint: 175, reorderQuantity: Number.NaN }, { reorderPoint: 175, reorderQuantity: -5 }]) {
        const r = await producerWith(async () => ({ derivation: { ...good, proposed }, evidence })).produce(w.s.ctx, req, rc);
        expect(r, JSON.stringify(proposed)).toMatchObject({ outcome: 'NO_RECOMMENDATION', code: 'PRODUCER_CONTRACT_VIOLATION' });
      }
      expect(await producerWith(async () => ({ derivation: { ...good, itemId: randomUUID() }, evidence })).produce(w.s.ctx, req, rc)).toMatchObject({ outcome: 'NO_RECOMMENDATION', code: 'TARGET_MISMATCH' });
      expect(await producerWith(async () => ({ derivation: { ...good, verification: [{ dimension: 'COST', result: 'FAILED' }] }, evidence })).produce(w.s.ctx, req, rc)).toMatchObject({ outcome: 'NO_RECOMMENDATION', code: 'DERIVATION_UNVERIFIED' });
      expect(await producerWith(async () => ({ derivation: good, evidence: null })).produce(w.s.ctx, req, rc)).toMatchObject({ outcome: 'NO_RECOMMENDATION', code: 'EVIDENCE_UNAVAILABLE' });
      expect(await producerWith(async () => ({ derivation: { ...good, ruleSetVersion: 'inventory-reorder-policy/v1.0.0' }, evidence })).produce(w.s.ctx, req, rc)).toMatchObject({ outcome: 'NO_RECOMMENDATION' });
      // BO's evidence recording refuses (facts changed / not passed) or comes back inconsistent
      expect(await producerWith(async () => ({ derivation: good, evidence }), async () => ({ ok: false, code: 'EVIDENCE_CHANGED', detail: 'facts changed' })).produce(w.s.ctx, req, rc)).toMatchObject({ outcome: 'NO_RECOMMENDATION', code: 'EVIDENCE_CHANGED' });
      expect(await producerWith(async () => ({ derivation: good, evidence }), async () => ({ ...(await okRecord()), snapshotDigest: `sha256:${'c'.repeat(64)}` })).produce(w.s.ctx, req, rc)).toMatchObject({ outcome: 'NO_RECOMMENDATION', code: 'EVIDENCE_CHANGED' });
      expect(await producerWith(async () => ({ derivation: good, evidence }), async () => ({ ...(await okRecord()), references: [] })).produce(w.s.ctx, req, rc)).toMatchObject({ outcome: 'NO_RECOMMENDATION', code: 'PRODUCER_CONTRACT_VIOLATION' });
      await expect(producerWith(async () => { throw new Error('boom'); }).produce(w.s.ctx, req, rc)).rejects.toThrow('boom');
      expect((await adiRecs(w.s.bizId)).length).toBe(before);

      // atomicity: BO's REAL evaluation facts, written for a real candidate, roll back with a later ADI persistence failure
      const real = new ReorderPolicyDerivationService(); const recorder = new ReorderPolicyBaselineEvidenceRecorder();
      const evalCount = async () => (await q(`SELECT 1 FROM ${BO}.inventory_policy_evaluations WHERE business_id=$1`, [w.s.bizId])).length;
      const evalsBefore = await evalCount();
      await expect(new ReorderPolicyRecommendationProducer({
        deriver: { derive: (ctx, r) => real.derive(ctx, r), recordBaselineEvidence: (ctx, r) => recorder.record(ctx, r) },
        recommendations: { createRecommendation: async () => { throw new Error('persist failed'); } } as any,
      }).produce(w.s.ctx, req, rc)).rejects.toThrow('persist failed');
      expect(await evalCount()).toBe(evalsBefore); // no orphan BO evaluation facts
      expect((await adiRecs(w.s.bizId)).length).toBe(before);
      expect(await abaArtifacts(w.s.bizId)).toEqual({ actions: 0, captures: 0, packages: 0 });
    }, 90_000);

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
