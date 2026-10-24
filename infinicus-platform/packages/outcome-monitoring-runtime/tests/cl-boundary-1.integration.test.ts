/**
 * CL-BOUNDARY-1 - live PostgreSQL proof (application role, RLS enforced) for the OM -> Control Loop learning boundary.
 *
 * The boundary reads OM's own execution verifications itself, so these tests use the REAL repository, the REAL tables and REAL RLS, with a recording
 * sink. The database cannot hold OUTCOME_VERIFIED (OM-EVID-1), so no real fact is learning-eligible: SUCCEEDED + APPLIED executions with PENDING or
 * INCONCLUSIVE outcomes must all be refused, across tenants nothing is visible, and nothing is written anywhere by an attempt.
 *
 * Requires DATABASE_URL (application role) and ADMIN_DATABASE_URL (fixtures, counts).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { createPool, closePool, withTenantTransaction, ActionExecutionVerificationRepository, MembershipRepository, UserRepository, type TenantContext } from '@infinicus/database';
import { CL_REQUIRED_TARGET_LAYER, OM_TO_CL_CONTRACT_VERSION, type OMToCLHandoff } from '@infinicus/handoff-contracts';
import { createMonitoredAction } from '../../../apps/api/tests/helpers/omFixtures.js';
import { LearningGateRefusedError, LearningReleaseBoundary } from '../src/LearningReleaseBoundary.js';
import { evaluateLearningShadow } from '../src/LearningShadowEvaluation.js';

const run = !!process.env.DATABASE_URL && !!process.env.ADMIN_DATABASE_URL;
const OM = 'outcome_monitoring';
const uc = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const DIGEST = `sha256:${'d'.repeat(64)}`;

let admin: Pool;
interface Scope { ctx: TenantContext; bizId: string; actionId: string; observationId: string }

async function scope(): Promise<Scope> {
  const tenantId = randomUUID(); const workspaceId = randomUUID(); const bizId = randomUUID();
  await admin.query(`INSERT INTO tenancy.tenants (id, name, slug, status, plan_code) VALUES ($1,'CB1 T',$2,'active','test')`, [tenantId, uc('cb1t')]);
  await admin.query(`INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,'CB1 WS',$3,'active')`, [workspaceId, tenantId, uc('cb1w')]);
  const u = await new UserRepository().createUser({ email: `${uc('cb1')}@cb1.example`, passwordHash: '$2a$12$fixturefixturefixturefixturefixturefixture' });
  const userId = (await new UserRepository().activate(u.id)).id;
  const ctx: TenantContext = { tenantId, workspaceId, userId };
  const members = new MembershipRepository();
  const m = await members.create(ctx, userId); await members.activate(ctx, m.id);
  await admin.query(`INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,'CB1 Biz',$4,'active')`, [bizId, tenantId, workspaceId, uc('cb1b')]);
  const actionId = await createMonitoredAction(ctx, bizId);
  const obs = await withTenantTransaction(ctx, (c) => c.query(
    `INSERT INTO ${OM}.outcome_observations (tenant_id, workspace_id, business_id, monitored_action_id, observation_code, latest_version) VALUES ($1,$2,$3,$4,$5,1) RETURNING id`,
    [tenantId, workspaceId, bizId, actionId, uc('obs')]));
  return { ctx, bizId, actionId, observationId: obs.rows[0].id as string };
}

const verification = (s: Scope, over: { outcomeState?: string; mutationResult?: string; monitoredActionId?: string | null } = {}) => withTenantTransaction(s.ctx, (c) => c.query(
  `INSERT INTO ${OM}.action_execution_verifications (tenant_id,workspace_id,business_id,execution_id,source_event_id,contract_version,evidence_digest,package_id,package_version,claim_id,monitored_action_id,action_type_code,action_type_schema_version,target_kind,target_id,execution_outcome,mutation_result,execution_recorded_at,execution_state,outcome_state,outcome_state_reason,correlation_id)
   VALUES ($1,$2,$3,$4,$5,'execution-evidence/1',$6,$7,1,$8,$9,'c','1','k','t','SUCCEEDED',$10,date_trunc('milliseconds', now()),'EXECUTION_VERIFIED',$11,'cb1',$12) RETURNING id`,
  [s.ctx.tenantId, s.ctx.workspaceId, s.bizId, randomUUID(), randomUUID(), DIGEST, randomUUID(), randomUUID(),
   over.monitoredActionId === undefined ? s.actionId : over.monitoredActionId, over.mutationResult ?? 'APPLIED', over.outcomeState ?? 'OUTCOME_PENDING', randomUUID()]));

const handoff = (s: Scope, over: Record<string, unknown> = {}): OMToCLHandoff => ({
  handoffId: 'h', sourceLayer: 'OM', sourceBlock: 'OM-09', targetLayer: 'CL', targetBlock: 'CL-01', correlationId: 'c', status: 'ready', createdAt: '2026-10-21T00:00:00.000Z',
  lineage: [{ layer: 'OM', block: 'OM-09', recordId: s.observationId, timestamp: '2026-10-21T00:00:00.000Z', action: 'observation_recorded' }],
  payload: {
    contractVersion: OM_TO_CL_CONTRACT_VERSION, tenantId: s.ctx.tenantId, workspaceId: s.ctx.workspaceId, businessId: s.bizId, idempotencyKey: 'k', observationId: s.observationId,
    observationVersionId: 'v', observationVersion: 1, feedbackPackageId: 'fb', feedbackPackageVersionId: 'fbv', feedbackStatus: 'ready', summary: 's',
    findings: [{ findingCode: 'f', statement: 's' }], reviewActions: [], varianceSummary: [], evidenceReferences: ['om://x'], omPublicationPackageId: 'p',
    targetLayer: CL_REQUIRED_TARGET_LAYER, targetBlock: 'CL-01', publishedAt: '2026-10-21T00:00:00.000Z', ...over,
  },
}) as OMToCLHandoff;

/** Row counts of every table an attempt could conceivably touch (admin connection, RLS bypassed). */
const TABLES = [
  `${OM}.action_execution_verifications`, `${OM}.outcome_observations`, `${OM}.learning_feedback_packages`, `${OM}.om_publication_packages`,
  'continuous_learning.cl_intake_packages',
];
async function snapshot(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of TABLES) out[t] = Number((await admin.query(`SELECT count(*)::int n FROM ${t}`)).rows[0].n);
  return out;
}

function harness() {
  const sinkCalls: unknown[][] = [];
  const boundary = new LearningReleaseBoundary({ sources: new ActionExecutionVerificationRepository(), sink: async (...a) => { sinkCalls.push(a); } });
  return { boundary, sinkCalls };
}
const reasonsOf = async (p: Promise<unknown>): Promise<readonly string[]> => {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(LearningGateRefusedError); return (e as LearningGateRefusedError).reasons; }
  throw new Error('expected a refusal');
};

describe.runIf(run)('CL-BOUNDARY-1 learning boundary (live PostgreSQL, application role)', () => {
  let a: Scope; let b: Scope;
  beforeAll(async () => {
    createPool({ connectionString: process.env.DATABASE_URL! });
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
    a = await scope(); b = await scope();
  });
  afterAll(async () => { await admin?.end(); await closePool(); });

  it('an observation with no verification is refused (no source)', async () => {
    const { boundary, sinkCalls } = harness();
    expect(await reasonsOf(boundary.release(a.ctx, handoff(a)))).toContain('NO_VERIFIED_EXECUTION_SOURCE');
    expect(sinkCalls).toHaveLength(0);
  });

  it('SUCCEEDED + APPLIED executions with PENDING or INCONCLUSIVE outcomes never open the gate (execution success is not learning)', async () => {
    await verification(a);
    await verification(a, { outcomeState: 'OUTCOME_INCONCLUSIVE', mutationResult: 'NO_CHANGE' });
    const { boundary, sinkCalls } = harness();
    expect(await reasonsOf(boundary.release(a.ctx, handoff(a)))).toContain('LEARNING_GATE_CLOSED');
    expect(sinkCalls).toHaveLength(0);
  });

  it('the database cannot hold a verified outcome, so no real fact can be released (Section XI, enforced below the code)', async () => {
    await expect(verification(a, { outcomeState: 'OUTCOME_VERIFIED' })).rejects.toMatchObject({ code: '23514' });
  });

  it('a verification linked only by the approved action is found and still refused', async () => {
    const { rows } = await withTenantTransaction(a.ctx, (c) => c.query(`SELECT approved_action_id FROM ${OM}.monitored_actions WHERE id=$1`, [a.actionId]));
    expect(rows[0].approved_action_id).toBeTruthy();
    const found = await new ActionExecutionVerificationRepository().learningSourcesForObservation(a.ctx, a.bizId, a.observationId);
    expect(found.observation).toMatchObject({ businessId: a.bizId, monitoredActionId: a.actionId });
    expect(found.facts.length).toBeGreaterThanOrEqual(2);
    expect(found.facts.every((f) => f.tenantId === a.ctx.tenantId && f.businessId === a.bizId)).toBe(true);
  });

  it('cross-tenant: tenant B cannot read tenant A observation or its evidence, and A hand-off presented in B scope is refused', async () => {
    const repo = new ActionExecutionVerificationRepository();
    const seen = await repo.learningSourcesForObservation(b.ctx, a.bizId, a.observationId);
    expect(seen).toEqual({ observation: null, facts: [] });
    const { boundary, sinkCalls } = harness();
    expect(await reasonsOf(boundary.release(b.ctx, handoff(a)))).toContain('SCOPE_MISMATCH');
    // B claims A's identifiers inside a B-scoped hand-off: nothing is visible, so it is refused for lack of an observation.
    const forged = await reasonsOf(boundary.release(b.ctx, handoff(b, { observationId: a.observationId, businessId: a.bizId })));
    expect(forged).toContain('OBSERVATION_NOT_FOUND');
    expect(sinkCalls).toHaveLength(0);
  });

  it('a malformed observation id is refused without a database error', async () => {
    const { boundary, sinkCalls } = harness();
    await reasonsOf(boundary.release(a.ctx, handoff(a, { observationId: 'not-a-uuid' })));
    expect(sinkCalls).toHaveLength(0);
  });

  it('CL-ACT-04: real application-role OM facts rehearse in shadow mode without writes or eligibility', async () => {
    // Create an actual pending verification; no test-only promotion to OUTCOME_VERIFIED.
    await verification(a);
    const reader = new ActionExecutionVerificationRepository();
    const before = await snapshot();
    const found = await reader.learningSourcesForObservation(a.ctx, a.bizId, a.observationId);
    expect(found.observation).not.toBeNull();
    expect(found.facts.length).toBeGreaterThan(0);
    const input = {
      handoff: handoff(a),
      deliveryScope: { tenantId: a.ctx.tenantId, workspaceId: a.ctx.workspaceId },
      observation: found.observation,
      sources: found.facts,
    };
    const first = evaluateLearningShadow(input);
    const second = evaluateLearningShadow(input);
    expect(first).toEqual(second);
    expect(first.candidateEligible).toBe(false);
    expect(first.reasons).toContain('LEARNING_GATE_CLOSED');
    expect(first).toMatchObject({
      mode: 'SHADOW_ONLY', releaseAuthorized: false, learningApplied: false, mutationsPermitted: false,
    });
    expect(await snapshot()).toEqual(before);
  });

  it('CL-ACT-04: PostgreSQL RLS prevents cross-tenant source substitution during shadow evaluation', async () => {
    const before = await snapshot();
    const reader = new ActionExecutionVerificationRepository();
    const foreign = await reader.learningSourcesForObservation(b.ctx, a.bizId, a.observationId);
    expect(foreign).toEqual({ observation: null, facts: [] });
    const candidate = evaluateLearningShadow({
      handoff: handoff(b, { observationId: a.observationId, businessId: a.bizId }),
      deliveryScope: { tenantId: b.ctx.tenantId, workspaceId: b.ctx.workspaceId },
      observation: foreign.observation,
      sources: foreign.facts,
    });
    expect(candidate.candidateEligible).toBe(false);
    expect(candidate.reasons).toContain('OBSERVATION_NOT_FOUND');
    expect(candidate.releaseAuthorized).toBe(false);
    expect(candidate.learningApplied).toBe(false);
    expect(candidate.mutationsPermitted).toBe(false);
    expect(await snapshot()).toEqual(before);
  });

  it('refusals write nothing: no verification, observation, feedback, publication or intake row is created or changed', async () => {
    const before = await snapshot();
    const { boundary } = harness();
    for (const h of [handoff(a), handoff(a, { evidenceReferences: [] }), handoff(a, { tenantId: b.ctx.tenantId })]) await reasonsOf(boundary.release(a.ctx, h));
    await reasonsOf(boundary.release(b.ctx, handoff(a)));
    expect(await snapshot()).toEqual(before);
  });
});
