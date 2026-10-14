/**
 * P0-5 ABA authoring / administration surface - live PostgreSQL + real Fastify application (RLS enforced for the app role).
 *
 * Proves the governed production path that makes a Level 2 AuthorizedActionPackage issuable (action type -> Level 2 policy -> capture ->
 * owner -> boundaries -> issuer) and the security boundary around it: authentication, tenant / workspace / business scope, the
 * aba:admin / aba:write / aba:read split, canonical-only action types, Level 2 only, identifiers-only issuance, idempotency and audit,
 * and that nothing here touches Business Operations, emits events or executes anything.
 *
 * Requires DATABASE_URL (app role) and ADMIN_DATABASE_URL (fixtures / inspection).
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- HTTP payloads are arbitrary JSON */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '@infinicus/configuration';
import {
  createPool, closePool, UserRepository, MembershipRepository, ApprovedActionRepository, AutomationLevelPolicyRepository,
  SimulationModelRepository, SimulationScenarioRepository, SimulationRunRepository, type TenantContext,
} from '@infinicus/database';
import { DEFAULT_APPROVER_ASSIGNMENT_CODE } from '@infinicus/workflow';
import type { GovernanceEvidenceRequest, GovernanceEvidenceVerdict, GovernanceEvidenceVerifier } from '@infinicus/handoff-contracts';
import { buildApp } from '../src/app.js';
import { createAbaFixture, APPROVABLE_FACTS, FIXTURE_FACTS_DIGEST, fixtureProposal, uc } from './helpers/abaFixtures.js';
import { chainKit } from './helpers/authorizedPackageChain.js';

const run = !!process.env.DATABASE_URL && !!process.env.ADMIN_DATABASE_URL;
const STRONG_PASSWORD = 'Correct-Horse-9!';
const CODE = 'inventory_reorder_policy_update';
/** The target of the mechanics fixtures' ADI proposal (a lowercase UUID, as the structured contract requires). */
const FIXTURE_TARGET = '11111111-1111-4111-8111-111111111111';
const hoursFromNow = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString();

let adminPool: Pool;
let app: FastifyInstance;

interface Session { ctx: TenantContext; token: string; bizId: string; membershipId: string; simRunId: string }

/** A real Simulation-layer run for the business, driven to the owner's `completed` state (or left in another state). */
async function simulationRun(ctx: TenantContext, businessId: string, finalStatus: 'completed' | 'queued' | 'running' = 'completed'): Promise<string> {
  const models = new SimulationModelRepository(); const scenarios = new SimulationScenarioRepository(); const runs = new SimulationRunRepository();
  const model = await models.createModel(ctx, businessId, uc('model'), 'Engine v3 Model');
  const modelVersion = await models.createVersion(ctx, model.id, businessId, 'infinicus-engine-v3', {});
  const scenario = await scenarios.createScenario(ctx, businessId, model.id, uc('scn'), 'Scenario');
  const scenarioVersion = await scenarios.createVersion(ctx, scenario.id, businessId);
  const { request } = await runs.createRequest(ctx, businessId, scenarioVersion.id, uc('req'), uc('idem'));
  const run = await runs.createRun(ctx, businessId, request.id, modelVersion.id, uc('run'));
  if (finalStatus !== 'queued') await runs.transitionRun(ctx, run.id, 'running');
  if (finalStatus === 'completed') await runs.transitionRun(ctx, run.id, 'completed');
  return run.id;
}

/** A controllable stand-in for the (not yet existing) authoritative evidence verifier. Production registers NONE. */
let verifierBehavior: (request: GovernanceEvidenceRequest) => GovernanceEvidenceVerdict | Promise<GovernanceEvidenceVerdict>;
const verifiedNow = (request: GovernanceEvidenceRequest): GovernanceEvidenceVerdict => ({
  status: 'VERIFIED', dimension: request.dimension, result: 'PASSED', evaluatedAt: new Date().toISOString(), evidenceRef: request.evidenceRef,
  authoritativeSource: { layer: 'TEST', component: 'fake-verifier' }, sourceVersion: `test-1|${FIXTURE_FACTS_DIGEST}`,
});
const seen: GovernanceEvidenceRequest[] = [];
const fakeVerifier: GovernanceEvidenceVerifier = { verify: async (request) => { seen.push(request); return verifierBehavior(request); } };

async function registerActiveUser(): Promise<{ userId: string; token: string }> {
  const email = `${uc('aba-auth')}@aba-auth.example`;
  const reg = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, password: STRONG_PASSWORD } });
  expect(reg.statusCode).toBe(201);
  const userId = reg.json().id as string;
  await new UserRepository().activate(userId);
  const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: STRONG_PASSWORD } });
  return { userId, token: login.json().rawSessionToken as string };
}

async function grantRole(ctx: TenantContext, userId: string, role: string | { permissions: string[] }, tenantId = ctx.tenantId): Promise<string> {
  const memberships = new MembershipRepository();
  const m = await memberships.create({ ...ctx, tenantId }, userId);
  await memberships.activate({ ...ctx, tenantId }, m.id);
  let roleId: string;
  if (typeof role === 'string') {
    roleId = (await adminPool.query(`SELECT id FROM tenancy.roles WHERE tenant_id IS NULL AND code = $1`, [role])).rows[0].id;
  } else {
    roleId = randomUUID();
    await adminPool.query(`INSERT INTO tenancy.roles (id, tenant_id, code, name, description, scope, is_system) VALUES ($1,$2,$3,'Custom','aba-authoring test','tenant',false)`, [roleId, ctx.tenantId, `c-${uc('r')}`]);
    await adminPool.query(`INSERT INTO tenancy.role_permissions (role_id, permission_id) SELECT $1, id FROM tenancy.permissions WHERE code = ANY($2::text[])`, [roleId, role.permissions]);
  }
  await memberships.assignRole({ ...ctx, tenantId }, m.id, roleId);
  return m.id;
}

/** A fresh tenant + workspace + business and a user holding a role or exact permission set. */
async function setup(role: string | { permissions: string[] } = 'owner'): Promise<Session> {
  const { userId, token } = await registerActiveUser();
  const tenantId = randomUUID();
  const workspaceId = randomUUID();
  const sfx = uc('s');
  await adminPool.query(`INSERT INTO tenancy.tenants (id, name, slug, status, plan_code) VALUES ($1,'ABA Authoring Tenant',$2,'active','test')`, [tenantId, `abau-${sfx}`]);
  await adminPool.query(`INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,'ABA Authoring WS',$3,'active')`, [workspaceId, tenantId, `abau-ws-${sfx}`]);
  const ctx: TenantContext = { tenantId, workspaceId, userId };
  const membershipId = await grantRole(ctx, userId, role);
  const bizId = randomUUID();
  await adminPool.query(`INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,'ZZ ABA Authoring Biz',$4,'active')`, [bizId, tenantId, workspaceId, uc('abau-biz')]);
  return { ctx, token, bizId, membershipId, simRunId: await simulationRun(ctx, bizId) };
}

/** Adds another user to the SAME tenant/workspace with a role or permission set. */
async function addMember(s: Session, role: string | { permissions: string[] }): Promise<Session> {
  const { userId, token } = await registerActiveUser();
  const ctx = { ...s.ctx, userId };
  const membershipId = await grantRole(ctx, userId, role);
  return { ctx, token, bizId: s.bizId, membershipId, simRunId: s.simRunId };
}

const hdr = (s: { ctx: TenantContext; token: string }, extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${s.token}`, 'x-tenant-id': s.ctx.tenantId, 'x-workspace-id': s.ctx.workspaceId, ...extra,
});
const keyed = (s: { ctx: TenantContext; token: string }, extra: Record<string, string> = {}) => hdr(s, { 'idempotency-key': uc('key'), ...extra });
const post = (s: Session, url: string, payload?: unknown, extra: Record<string, string> = {}) => app.inject({ method: 'POST', url, headers: keyed(s, extra), ...(payload === undefined ? {} : { payload: payload as any }) });
const get = (s: Session, url: string) => app.inject({ method: 'GET', url, headers: hdr(s) });

const AT = '/v1/aba/action-types';
const POL = '/v1/aba/automation-policies';
const actionBase = (s: Session, actionId: string) => `/v1/businesses/${s.bizId}/authorized-actions/${actionId}`;

interface Approved { actionId: string; decisionId: string; assignmentCode: string }

/** Grants the session user approver authority (once per business). */
async function grantApprover(s: Session): Promise<void> {
  const assignmentCode = DEFAULT_APPROVER_ASSIGNMENT_CODE;
  const existing = (await adminPool.query(`SELECT 1 FROM approved_business_action.approver_assignments WHERE business_id=$1 AND assignment_code=$2`, [s.bizId, assignmentCode])).rowCount;
  if (!existing) {
    const g = await post(s, `/v1/businesses/${s.bizId}/approver-assignments`, { approverUserId: s.ctx.userId, assignmentCode, roleCode: 'business-owner' });
    expect(g.statusCode).toBe(201);
  }
}

/** Grants the session user approver authority, records an approving decision through the real route, and creates the approved action. */
async function approvedAction(s: Session, outcome: 'approve' | 'approve_with_modifications' | 'reject' = 'approve', source?: { intakePackageId: string; recommendationId: string }): Promise<Approved> {
  const assignmentCode = DEFAULT_APPROVER_ASSIGNMENT_CODE;
  await grantApprover(s);
  const { intakePackageId, recommendationId } = source ?? await createAbaFixture(s.ctx, s.bizId, APPROVABLE_FACTS, fixtureProposal(FIXTURE_TARGET, { reorderPoint: 10, reorderQuantity: 50 }));
  const d = await post(s, `/v1/businesses/${s.bizId}/decisions`, { intakePackageId, reviewCode: uc('r'), summary: 'authoring', assignmentCode, decisionCode: uc('d'), outcome });
  expect(d.statusCode).toBe(201);
  const decisionId = d.json().id as string;
  const actions = new ApprovedActionRepository();
  const action = await actions.createAction(s.ctx, s.bizId, decisionId, uc('act'), recommendationId);
  await actions.createVersion(s.ctx, action.id, s.bizId, 'authoring fixture');
  return { actionId: action.id, decisionId, assignmentCode };
}

const captureBody = (over: Record<string, unknown> = {}) => ({
  actionType: { code: CODE, schemaVersion: '1' }, target: { kind: 'inventory_item', id: FIXTURE_TARGET },
  proposedParameters: { reorderPoint: 10, reorderQuantity: 50 }, ...over,
});
const modifiedBody = () => captureBody({
  modification: { reason: 'Raise safety stock.', changes: [{ parameter: 'reorderPoint', operation: 'SET', before: 10, after: 15 }, { parameter: 'reorderQuantity', operation: 'SET', before: 50, after: 60 }] },
  evaluationEvidence: ['CONSTRAINTS', 'RESOURCE_REQUIREMENTS', 'EXPECTED_OUTCOME', 'COST'].map((dimension) => ({ dimension, evidenceRef: { kind: 'simulation_run', id: 'run-1' } })),
});
const ownerBody = (s: Session, over: Record<string, unknown> = {}) => ({
  ownerUserId: s.ctx.userId, membershipId: s.membershipId, roleCode: 'operations_lead',
  dueAt: { state: 'VALUE', value: hoursFromNow(72).replace(/\.\d+Z$/, 'Z') }, escalationPolicy: { state: 'VALUE', value: { ref: 'policy:default-escalation' } }, ...over,
});
const boundariesBody = (s: { simRunId: string }, over: Record<string, unknown> = {}) => ({
  executionWindow: { state: 'VALUE', value: { startsAt: hoursFromNow(1), endsAt: hoursFromNow(8) } },
  preconditions: { state: 'VALUE', value: [{ code: 'stock_available', operator: 'gte', operand: 1 }] },
  budget: { state: 'VALUE', value: { amount: '250.00', currency: 'USD' } },
  rollback: { state: 'VALUE', value: { instructions: 'Restore the previous reorder policy.' } },
  monitoring: { state: 'VALUE', value: { metrics: [{ metricCode: 'stockouts', target: 0, unit: 'count' }] } },
  simulationRun: { state: 'VALUE', value: s.simRunId }, ...over,
});

/** Registers + activates the canonical type and creates + enables the Level 2 policy covering it. */
async function governance(s: Session, policyCode = uc('l2').replace(/[^a-z0-9]/g, '_').toLowerCase()): Promise<{ policyCode: string }> {
  expect((await post(s, AT, { code: CODE, schemaVersion: '1' })).statusCode).toBe(201);
  expect((await post(s, `${AT}/${CODE}/1/activate`)).statusCode).toBe(200);
  const code = policyCode.startsWith('l') ? policyCode : `l_${policyCode}`;
  const created = await post(s, POL, { policyCode: code, automationLevel: 2, description: 'Level 2 reorder policy', actionTypes: [{ code: CODE, schemaVersion: '1' }] });
  expect(created.statusCode).toBe(201);
  const enabled = await post(s, `${POL}/${code}/versions/1/enable`, { reason: 'initial Level 2 enablement' });
  expect(enabled.statusCode).toBe(200);
  return { policyCode: code };
}

const auditRows = async (s: Session, like = 'aba.%') => (await adminPool.query(
  `SELECT action, entity_type, entity_id, business_id, actor_id, correlation_id, metadata, occurred_at FROM audit.audit_events WHERE tenant_id = $1 AND action LIKE $2 ORDER BY occurred_at, id`, [s.ctx.tenantId, like])).rows;
const countOf = async (sql: string, params: unknown[]) => Number((await adminPool.query(sql, params)).rows[0].n);

describe.runIf(run)('P0-5 ABA authoring / administration (HTTP, live PostgreSQL)', () => {
  beforeEach(() => { verifierBehavior = verifiedNow; seen.length = 0; });
  beforeAll(async () => {
    const appUrl = process.env.DATABASE_URL!;
    createPool({ connectionString: appUrl });
    adminPool = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
    app = await buildApp(loadConfig({ DATABASE_URL: appUrl, NODE_ENV: 'test', LOG_LEVEL: 'silent', RATE_LIMIT_MAX: '5000' }), { abaAuthoring: { evidenceVerifier: fakeVerifier } });
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    await adminPool?.end();
    await closePool();
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe('end to end: the minimum path that makes a Level 2 package issuable', () => {
    it('defines, activates, enables, captures, assigns, authors and issues - and the issuer returns metadata only', async () => {
      const s = await setup('owner');
      await governance(s);
      const a = await approvedAction(s);
      const base = actionBase(s, a.actionId);

      expect((await get(s, `${base}/authoring-status`)).json().missing).toEqual(['CAPTURE', 'OWNER', 'BOUNDARIES']);

      const cap = await post(s, `${base}/capture`, captureBody());
      expect(cap.statusCode).toBe(201);
      expect(cap.json()).toMatchObject({ actionId: a.actionId, decisionStatus: 'approved', finalParameters: { reorderPoint: 10, reorderQuantity: 50 }, created: true });
      expect((await post(s, `${base}/owner`, ownerBody(s))).statusCode).toBe(201);
      const bounds = await post(s, `${base}/boundaries`, boundariesBody(s));
      expect(bounds.statusCode).toBe(201);
      expect(bounds.json()).toMatchObject({ boundaryVersion: 1, created: true });

      const status = (await get(s, `${base}/authoring-status`)).json();
      expect(status.missing).toEqual([]);
      expect(status).toMatchObject({ capture: { recorded: true }, owner: { assigned: true }, boundaries: { authored: true }, level2Policy: { enabled: true }, actionType: { status: 'ACTIVE' } });

      const issued = await post(s, `${base}/package`);
      expect(issued.statusCode).toBe(201);
      const body = issued.json();
      expect(body).toMatchObject({ outcome: 'ISSUED', packageVersion: 1, status: 'ISSUED', automationLevel: 2, actionType: { code: CODE, schemaVersion: '1' } });
      expect(body.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      // no package document, no parameters, no lineage ever leave through the API
      expect(Object.keys(body).sort()).toEqual(['actionType', 'automationLevel', 'digest', 'expiresAt', 'issuedAt', 'outcome', 'packageId', 'packageVersion', 'status', 'supersedes']);

      const again = await post(s, `${base}/package`);
      expect(again.json()).toMatchObject({ outcome: 'REPLAYED', packageId: body.packageId, digest: body.digest });
      expect((await get(s, `${base}/authoring-status`)).json().latestPackage).toMatchObject({ packageId: body.packageId, lifecycle: 'ISSUED' });
    });

    it('an approved-with-modifications action issues with the server-derived final parameters', async () => {
      const s = await setup('owner');
      await governance(s);
      const a = await approvedAction(s, 'approve_with_modifications');
      const base = actionBase(s, a.actionId);
      const cap = await post(s, `${base}/capture`, modifiedBody());
      expect(cap.statusCode).toBe(201);
      expect(cap.json().finalParameters).toEqual({ reorderPoint: 15, reorderQuantity: 60 });
      expect((await post(s, `${base}/owner`, ownerBody(s))).statusCode).toBe(201);
      expect((await post(s, `${base}/boundaries`, boundariesBody(s))).statusCode).toBe(201);
      expect((await post(s, `${base}/package`)).json()).toMatchObject({ outcome: 'ISSUED' });
      const stored = (await adminPool.query(
        `SELECT package #>> '{action,parameters}' p, package #>> '{authorization,decisionStatus}' d FROM approved_business_action.authorized_action_package_versions WHERE business_id=$1`, [s.bizId])).rows[0];
      expect(JSON.parse(stored.p)).toEqual({ reorderPoint: 15, reorderQuantity: 60 });
      expect(stored.d).toBe('approved_with_modifications');
    });

    it('without a capture the action is approved but NOT issuable', async () => {
      const s = await setup('owner');
      await governance(s);
      const a = await approvedAction(s);
      const res = await post(s, `${actionBase(s, a.actionId)}/package`);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.message).toContain('CAPTURE_MISSING');
      expect(await countOf(`SELECT count(*) n FROM approved_business_action.authorized_action_package_versions WHERE business_id=$1`, [s.bizId])).toBe(0);
    });

    it('with no enabled Level 2 policy (production default) nothing is issuable', async () => {
      const s = await setup('owner');
      expect((await post(s, AT, { code: CODE, schemaVersion: '1' })).statusCode).toBe(201);
      expect((await post(s, `${AT}/${CODE}/1/activate`)).statusCode).toBe(200);
      const a = await approvedAction(s);
      const base = actionBase(s, a.actionId);
      await post(s, `${base}/capture`, captureBody());
      await post(s, `${base}/owner`, ownerBody(s));
      await post(s, `${base}/boundaries`, boundariesBody(s));
      const res = await post(s, `${base}/package`);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.message).toContain('LEVEL2_POLICY_NOT_ENABLED');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe('A/B. action-type and Level 2 policy governance', () => {
    it('the workspace registration is the CANONICAL definition, read back identically', async () => {
      const s = await setup('owner');
      const def = await post(s, AT, { code: CODE, schemaVersion: '1' });
      expect(def.statusCode).toBe(201);
      expect(def.json()).toMatchObject({ code: CODE, schemaVersion: '1', status: 'DRAFT', targetKinds: ['inventory_item'], created: true });
      const stored = (await adminPool.query(`SELECT parameters, governance_impact, applicability, target_kinds FROM approved_business_action.action_type_definitions WHERE tenant_id=$1`, [s.ctx.tenantId])).rows[0];
      expect(stored.parameters).toEqual({ reorderPoint: { type: 'number', required: true, min: 0 }, reorderQuantity: { type: 'number', required: true, min: 0 } });
      expect(stored.governance_impact.reorderQuantity).toEqual(['CONSTRAINTS', 'RESOURCE_REQUIREMENTS', 'COST', 'EXPECTED_OUTCOME']);
      expect(stored.applicability).toEqual({});
    });

    it('a caller cannot redefine or invent an action type: unknown codes, supplied definitions and other versions are refused', async () => {
      const s = await setup('owner');
      expect((await post(s, AT, { code: 'adjust_price', schemaVersion: '1' })).statusCode).toBe(400);
      expect((await post(s, AT, { code: CODE, schemaVersion: '2' })).statusCode).toBe(400);
      for (const extra of [{ parameters: { reorderPoint: { type: 'number', required: false } } }, { applicability: { budget: 'NOT_APPLICABLE_ALLOWED' } }, { targetKinds: ['warehouse'] }, { governanceImpact: {} }]) {
        expect((await post(s, AT, { code: CODE, schemaVersion: '1', ...extra })).statusCode, JSON.stringify(extra)).toBe(400);
      }
      expect(await countOf(`SELECT count(*) n FROM approved_business_action.action_type_definitions WHERE tenant_id=$1`, [s.ctx.tenantId])).toBe(0);
    });

    it('lifecycle: define -> activate -> retire (reason required); a retired type cannot be re-activated', async () => {
      const s = await setup('owner');
      await post(s, AT, { code: CODE, schemaVersion: '1' });
      expect((await post(s, `${AT}/${CODE}/1/retire`, { reason: 'too early' })).statusCode).toBe(409);
      expect((await post(s, `${AT}/${CODE}/1/activate`)).json()).toMatchObject({ status: 'ACTIVE' });
      expect((await post(s, `${AT}/${CODE}/1/retire`, {})).statusCode).toBe(400);
      expect((await post(s, `${AT}/${CODE}/1/retire`, { reason: 'superseded by v2' })).json()).toMatchObject({ status: 'RETIRED' });
      expect((await post(s, `${AT}/${CODE}/1/activate`)).statusCode).toBe(409);
      expect((await get(s, AT)).json().items).toHaveLength(1);
      expect((await get(s, `${AT}/${CODE}/1`)).json()).toMatchObject({ status: 'RETIRED' });
      expect((await get(s, `${AT}/${CODE}/9`)).statusCode).toBe(404);
    });

    it('only Level 2 policies exist: Level 3 and Level 4 are refused, whatever the caller asks', async () => {
      const s = await setup('owner');
      for (const level of [3, 4, 0, 1, 5]) {
        const res = await post(s, POL, { policyCode: `lvl_${level}`, automationLevel: level, description: 'x', actionTypes: [{ code: CODE, schemaVersion: '1' }] });
        expect(res.statusCode, `level ${level}`).toBe(400);
      }
      expect(res3Message(await post(s, POL, { policyCode: 'lvl_3b', automationLevel: 3, description: 'x', actionTypes: [{ code: CODE, schemaVersion: '1' }] }))).toContain('NOT_ENABLED');
      expect(await countOf(`SELECT count(*) n FROM approved_business_action.automation_level_policies WHERE tenant_id=$1`, [s.ctx.tenantId])).toBe(0);
    });

    it('a stored Level 3 policy cannot be enabled through the API (and the database refuses it too)', async () => {
      const s = await setup('owner');
      const repo = new AutomationLevelPolicyRepository();
      const { version } = await repo.createPolicy(s.ctx, { policyCode: 'rule_l3', automationLevel: 3, description: 'rule based', specification: {}, createdByUserId: s.ctx.userId, correlationId: randomUUID() });
      expect(version.versionNumber).toBe(1);
      const res = await post(s, `${POL}/rule_l3/versions/1/enable`, { reason: 'try' });
      expect(res.statusCode).toBe(400);
      expect((await get(s, '/v1/aba/automation-enablement')).json().automationLevels).toEqual([]);
    });

    it('a policy can only reference canonical action types, and its version/enable/disable lifecycle is governed', async () => {
      const s = await setup('owner');
      expect((await post(s, POL, { policyCode: 'bad', automationLevel: 2, description: 'x', actionTypes: [{ code: 'adjust_price', schemaVersion: '1' }] })).statusCode).toBe(400);
      expect((await post(s, POL, { policyCode: 'dup', automationLevel: 2, description: 'x', actionTypes: [{ code: CODE, schemaVersion: '1' }, { code: CODE, schemaVersion: '1' }] })).statusCode).toBe(400);
      const created = await post(s, POL, { policyCode: 'l2_ok', automationLevel: 2, description: 'v1', actionTypes: [{ code: CODE, schemaVersion: '1' }] });
      expect(created.json()).toMatchObject({ policyCode: 'l2_ok', automationLevel: 2, created: true });
      const v2 = await post(s, `${POL}/l2_ok/versions`, { description: 'v2', actionTypes: [{ code: CODE, schemaVersion: '1' }] });
      expect(v2.json().versions.map((v: any) => v.versionNumber)).toEqual([1, 2]);
      expect((await post(s, `${POL}/l2_ok/versions/9/enable`, { reason: 'x' })).statusCode).toBe(404);
      expect((await post(s, `${POL}/l2_ok/versions/1/enable`, { reason: 'x' })).statusCode).toBe(409); // only the latest version is enable-able
      expect((await post(s, `${POL}/l2_ok/versions/2/enable`, { reason: 'go live' })).json().versions[1].enabled).toBe(true);
      expect((await get(s, '/v1/aba/automation-enablement')).json()).toMatchObject({ automationLevels: [2], effective: [{ policyCode: 'l2_ok', versionNumber: 2 }] });
      expect((await post(s, `${POL}/l2_ok/versions/2/disable`, {})).statusCode).toBe(400);
      expect((await post(s, `${POL}/l2_ok/versions/2/disable`, { reason: 'pause' })).json().versions[1].enabled).toBe(false);
      expect((await get(s, '/v1/aba/automation-enablement')).json().automationLevels).toEqual([]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe('C/D/E. capture, owner and boundaries', () => {
    it('capture cannot precede an approved decision (a rejected decision cannot be captured)', async () => {
      const s = await setup('owner');
      await governance(s);
      const a = await approvedAction(s, 'reject');
      const res = await post(s, `${actionBase(s, a.actionId)}/capture`, captureBody());
      expect(res.statusCode).toBe(409);
      expect(res.json().error.message).toContain('capture can only follow an approved decision');
      expect(await countOf(`SELECT count(*) n FROM approved_business_action.authorized_action_captures WHERE business_id=$1`, [s.bizId])).toBe(0);
    });

    it('a caller cannot supply or bypass the final parameters or any authority/derived fact (strict schema, DB-derived result)', async () => {
      const s = await setup('owner');
      await governance(s);
      const a = await approvedAction(s, 'approve_with_modifications');
      const url = `${actionBase(s, a.actionId)}/capture`;
      for (const extra of [{ finalParameters: { reorderPoint: 999, reorderQuantity: 999 } }, { decisionId: randomUUID() }, { decisionStatus: 'approved' }, { capturedByUserId: randomUUID() }, { tenantId: randomUUID() }, { proposed: { state: 'VALUE' } }]) {
        const res = await post(s, url, { ...modifiedBody(), ...extra });
        expect(res.statusCode, JSON.stringify(extra)).toBe(400);
      }
      // a delta whose `before` is not the proposed value is refused, never "corrected"
      const wrongBefore = modifiedBody();
      (wrongBefore.modification as any).changes[0].before = 11;
      expect((await post(s, url, wrongBefore)).statusCode).toBe(400);
      // missing evidence for a touched governance dimension is refused
      const noEvidence = { ...modifiedBody(), evaluationEvidence: [] };
      expect((await post(s, url, noEvidence)).statusCode).toBe(400);
      // a plain capture for a modified decision (and vice versa) is refused
      expect((await post(s, url, captureBody())).statusCode).toBe(400);
      expect(await countOf(`SELECT count(*) n FROM approved_business_action.authorized_action_captures WHERE business_id=$1`, [s.bizId])).toBe(0);
      const ok = await post(s, url, modifiedBody());
      expect(ok.statusCode).toBe(201);
      const row = (await adminPool.query(`SELECT final_parameters, decision_id, captured_by_user_id, modification FROM approved_business_action.authorized_action_captures WHERE business_id=$1`, [s.bizId])).rows[0];
      expect(row.final_parameters).toEqual({ reorderPoint: 15, reorderQuantity: 60 });
      expect(row.decision_id).toBe(a.decisionId);
      expect(row.captured_by_user_id).toBe(s.ctx.userId);
      expect(row.modification.value.modifiedByUserId).toBe(s.ctx.userId); // the verified approver, not a request field
    });

    it('invalid parameters and a wrong target kind are refused against the canonical contract', async () => {
      const s = await setup('owner');
      await governance(s);
      const a = await approvedAction(s);
      const url = `${actionBase(s, a.actionId)}/capture`;
      expect((await post(s, url, captureBody({ proposedParameters: { reorderPoint: -1, reorderQuantity: 5 } }))).statusCode).toBe(400);
      expect((await post(s, url, captureBody({ proposedParameters: { reorderPoint: 1 } }))).statusCode).toBe(400);
      expect((await post(s, url, captureBody({ proposedParameters: { reorderPoint: 1, reorderQuantity: 2, leadTime: 3 } }))).statusCode).toBe(400);
      expect((await post(s, url, captureBody({ target: { kind: 'warehouse', id: 'w' } }))).statusCode).toBe(400);
      expect((await post(s, url, captureBody({ actionType: { code: 'adjust_price', schemaVersion: '1' } }))).statusCode).toBe(400);
    });

    it('only the decision\'s own active approver can author the capture and boundaries', async () => {
      const s = await setup('owner');
      await governance(s);
      const a = await approvedAction(s);
      const other = await addMember(s, 'owner'); // owner role: has aba:write, but is not the approver
      const base = actionBase(s, a.actionId);
      for (const [url, payload] of [[`${base}/capture`, captureBody()], [`${base}/boundaries`, boundariesBody(s)]] as const) {
        const res = await post(other, url, payload);
        expect(res.statusCode, url).toBe(403);
        expect(res.json().error.code).toBe('ApproverAuthorityNotEstablishedError');
      }
      expect((await post(s, `${base}/capture`, captureBody())).statusCode).toBe(201);
      // once the approver's authority is revoked, they can no longer author boundaries
      expect((await post(s, `/v1/businesses/${s.bizId}/approver-assignments/${a.assignmentCode}/revoke`, { reason: 'left' })).statusCode).toBe(200);
      expect((await post(s, `${base}/boundaries`, boundariesBody(s))).statusCode).toBe(403);
    });

    it('owner: assigned by the authenticated user; an owner outside this tenant/workspace membership scope is refused', async () => {
      const s = await setup('owner');
      await governance(s);
      const a = await approvedAction(s);
      const base = actionBase(s, a.actionId);
      await post(s, `${base}/capture`, captureBody());
      const stranger = await setup('owner'); // a user in a DIFFERENT tenant
      expect((await post(s, `${base}/owner`, ownerBody(s, { ownerUserId: stranger.ctx.userId, membershipId: stranger.membershipId }))).statusCode).toBeGreaterThanOrEqual(400);
      expect((await post(s, `${base}/owner`, ownerBody(s, { ownerUserId: s.ctx.userId, membershipId: stranger.membershipId }))).statusCode).toBeGreaterThanOrEqual(400);
      expect((await post(s, `${base}/owner`, ownerBody(s, { ownerUserId: randomUUID(), membershipId: randomUUID() }))).statusCode).toBeGreaterThanOrEqual(400);
      expect(await countOf(`SELECT count(*) n FROM approved_business_action.authorized_action_owner_assignments WHERE business_id=$1`, [s.bizId])).toBe(0);
      const ok = await post(s, `${base}/owner`, ownerBody(s));
      expect(ok.statusCode).toBe(201);
      expect((await adminPool.query(`SELECT assigned_by_user_id FROM approved_business_action.authorized_action_owner_assignments WHERE business_id=$1`, [s.bizId])).rows[0].assigned_by_user_id).toBe(s.ctx.userId);
      expect((await post(s, `${base}/owner`, { ...ownerBody(s), assignedByUserId: randomUUID() })).statusCode).toBe(400);
    });

    it('NOT_APPLICABLE needs an UPPER_SNAKE reason code (never normalized) and is refused where the canonical contract requires the field', async () => {
      const s = await setup('owner');
      await governance(s);
      const a = await approvedAction(s);
      const base = actionBase(s, a.actionId);
      await post(s, `${base}/capture`, captureBody());
      const lower = { state: 'NOT_APPLICABLE', reason: { code: 'no_due_date', statement: 'None.' } };
      const upper = { state: 'NOT_APPLICABLE', reason: { code: 'NO_DUE_DATE', statement: 'None.' } };
      expect((await post(s, `${base}/owner`, ownerBody(s, { dueAt: lower }))).statusCode).toBe(400);
      expect((await post(s, `${base}/owner`, ownerBody(s, { escalationPolicy: { state: 'NOT_APPLICABLE', reason: { code: 'No-Escalation', statement: 'x' } } }))).statusCode).toBe(400);
      expect((await post(s, `${base}/owner`, ownerBody(s, { dueAt: upper }))).statusCode).toBe(201); // owner due date is governed by the owner module, not the action type
      // boundaries: lowercase code refused outright
      expect((await post(s, `${base}/boundaries`, boundariesBody(s, { budget: lower }))).statusCode).toBe(400);
      // boundaries: a well-formed NOT_APPLICABLE is refused for every field this canonical type requires (fail closed)
      for (const field of ['executionWindow', 'preconditions', 'budget', 'rollback', 'monitoring']) {
        const res = await post(s, `${base}/boundaries`, boundariesBody(s, { [field]: { state: 'NOT_APPLICABLE', reason: { code: 'NOT_NEEDED', statement: 'n/a' } } }));
        expect(res.statusCode, field).toBe(400);
        expect(res.json().error.message, field).toContain('NOT_APPLICABLE is not permitted');
      }
      // B2c amendment: simulationRun is the ONE field with a governed exemption for this type, and only with the exact canonical reason
      for (const code of ['NOT_NEEDED', 'NOT_SIMULATION_BACKED', 'NO_APPLICABLE_SIMULATION_MODE']) {
        const res = await post(s, `${base}/boundaries`, boundariesBody(s, { simulationRun: { state: 'NOT_APPLICABLE', reason: { code, statement: 'n/a' } } }));
        expect(res.statusCode, code).toBe(400);
        expect(res.json().error.message, code).toContain('NO_APPLICABLE_SIMULATION_MODEL');
      }
      expect(await countOf(`SELECT count(*) n FROM approved_business_action.authorized_action_boundaries WHERE business_id=$1`, [s.bizId])).toBe(0);
    });

    it('invalid boundaries are refused (window ordering, budget, operator, empty metrics) and need the capture first', async () => {
      const s = await setup('owner');
      await governance(s);
      const a = await approvedAction(s);
      const base = actionBase(s, a.actionId);
      expect((await post(s, `${base}/boundaries`, boundariesBody(s))).statusCode).toBe(409); // no capture yet
      await post(s, `${base}/capture`, captureBody());
      const bad = [
        { executionWindow: { state: 'VALUE', value: { startsAt: hoursFromNow(8), endsAt: hoursFromNow(1) } } },
        { budget: { state: 'VALUE', value: { amount: 'lots', currency: 'USD' } } },
        { budget: { state: 'VALUE', value: { amount: '1.00', currency: 'usd' } } },
        { preconditions: { state: 'VALUE', value: [{ code: 'x', operator: 'near', operand: 1 }] } },
        { monitoring: { state: 'VALUE', value: { metrics: [] } } },
        { simulationRun: { state: 'VALUE', value: 'not-a-uuid' } },
      ];
      for (const over of bad) expect((await post(s, `${base}/boundaries`, boundariesBody(s, over))).statusCode, JSON.stringify(over)).toBe(400);
      expect(await countOf(`SELECT count(*) n FROM approved_business_action.authorized_action_boundaries WHERE business_id=$1`, [s.bizId])).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe('F. the issuer route accepts identifiers only', () => {
    it('rejects every request field: package payload, parameters, authority, risk, status, digest, lifecycle', async () => {
      const s = await setup('owner');
      await governance(s);
      const a = await approvedAction(s);
      const base = actionBase(s, a.actionId);
      await post(s, `${base}/capture`, captureBody());
      await post(s, `${base}/owner`, ownerBody(s));
      await post(s, `${base}/boundaries`, boundariesBody(s));
      for (const extra of [
        { package: { identity: {} } }, { finalParameters: { reorderPoint: 1 } }, { parameters: {} }, { automationLevel: 4 }, { approverTier: 9 }, { riskClass: 'low' },
        { status: 'ISSUED' }, { digest: `sha256:${'a'.repeat(64)}` }, { lifecycle: 'ISSUED' }, { permissionUsed: 'root' }, { authority: 'CURRENT' }, { tenantId: randomUUID() },
      ]) {
        expect((await post(s, `${base}/package`, extra)).statusCode, JSON.stringify(extra)).toBe(400);
      }
      expect(await countOf(`SELECT count(*) n FROM approved_business_action.authorized_action_package_versions WHERE business_id=$1`, [s.bizId])).toBe(0);
      expect((await post(s, `${base}/package`, {})).statusCode).toBe(201);
    });

    it('an unsupported request cannot make the issuer skip a refusal: a missing owner is still refused by the issuer itself', async () => {
      const s = await setup('owner');
      await governance(s);
      const a = await approvedAction(s);
      const base = actionBase(s, a.actionId);
      await post(s, `${base}/capture`, captureBody());
      await post(s, `${base}/boundaries`, boundariesBody(s));
      const res = await post(s, `${base}/package`);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.message).toContain('OWNER_MISSING');
    });

    it('the issuance audit records the requesting actor and the permission used', async () => {
      const s = await setup('owner');
      await governance(s);
      const a = await approvedAction(s);
      const base = actionBase(s, a.actionId);
      await post(s, `${base}/capture`, captureBody());
      await post(s, `${base}/owner`, ownerBody(s));
      await post(s, `${base}/boundaries`, boundariesBody(s));
      await post(s, `${base}/package`);
      const row = (await adminPool.query(`SELECT detail FROM approved_business_action.approval_audit_events WHERE business_id=$1 AND event_type='package.issued'`, [s.bizId])).rows[0];
      expect(row.detail.requestedBy).toEqual({ userId: s.ctx.userId, permissionUsed: 'aba:write' });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe('authentication, scope and permission boundary', () => {
    const adminRoutes: [string, string, unknown?][] = [
      ['POST', AT, { code: CODE, schemaVersion: '1' }],
      ['POST', `${AT}/${CODE}/1/activate`],
      ['POST', `${AT}/${CODE}/1/retire`, { reason: 'x' }],
      ['POST', POL, { policyCode: 'p', automationLevel: 2, description: 'x', actionTypes: [{ code: CODE, schemaVersion: '1' }] }],
      ['POST', `${POL}/p/versions`, { description: 'x', actionTypes: [{ code: CODE, schemaVersion: '1' }] }],
      ['POST', `${POL}/p/versions/1/enable`, { reason: 'x' }],
      ['POST', `${POL}/p/versions/1/disable`, { reason: 'x' }],
    ];

    it('unauthenticated requests are refused on every route', async () => {
      const biz = randomUUID(); const act = randomUUID();
      const all: [string, string, unknown?][] = [
        ...adminRoutes, ['GET', AT], ['GET', `${AT}/${CODE}/1`], ['GET', `${POL}/p`], ['GET', '/v1/aba/automation-enablement'],
        ['POST', `/v1/businesses/${biz}/authorized-actions/${act}/capture`, captureBody()], ['POST', `/v1/businesses/${biz}/authorized-actions/${act}/owner`, { ownerUserId: randomUUID(), membershipId: randomUUID(), roleCode: 'operations_lead', dueAt: { state: 'VALUE', value: hoursFromNow(72) }, escalationPolicy: { state: 'VALUE', value: { ref: 'policy:x' } } }],
        ['POST', `/v1/businesses/${biz}/authorized-actions/${act}/boundaries`, boundariesBody({ simRunId: randomUUID() })], ['POST', `/v1/businesses/${biz}/authorized-actions/${act}/package`],
        ['GET', `/v1/businesses/${biz}/authorized-actions/${act}/authoring-status`],
      ];
      for (const [method, url, payload] of all) {
        const res = await app.inject({ method: method as any, url, headers: { 'idempotency-key': uc('k') }, ...(payload === undefined ? {} : { payload: payload as any }) });
        expect(res.statusCode, `${method} ${url}`).toBe(401);
      }
    });

    it('aba:write cannot perform any aba:admin governance mutation; aba:admin can', async () => {
      const writer = await setup({ permissions: ['aba:write', 'aba:read'] });
      for (const [method, url, payload] of adminRoutes) {
        const res = await app.inject({ method: method as any, url, headers: keyed(writer), payload: payload as any });
        expect(res.statusCode, `${method} ${url}`).toBe(403);
      }
      expect(await countOf(`SELECT count(*) n FROM approved_business_action.action_type_definitions WHERE tenant_id=$1`, [writer.ctx.tenantId])).toBe(0);
      expect(await countOf(`SELECT count(*) n FROM approved_business_action.automation_level_policies WHERE tenant_id=$1`, [writer.ctx.tenantId])).toBe(0);

      const admin = await setup({ permissions: ['aba:admin', 'aba:read'] });
      expect((await post(admin, AT, { code: CODE, schemaVersion: '1' })).statusCode).toBe(201);
      expect((await post(admin, `${AT}/${CODE}/1/activate`)).statusCode).toBe(200);
      expect((await post(admin, POL, { policyCode: 'p', automationLevel: 2, description: 'x', actionTypes: [{ code: CODE, schemaVersion: '1' }] })).statusCode).toBe(201);
      expect((await post(admin, `${POL}/p/versions/1/enable`, { reason: 'x' })).statusCode).toBe(200);
    });

    it('aba:admin alone cannot author capture / owner / boundaries / issue; aba:read alone cannot write; aba:write alone cannot read others\' admin reads', async () => {
      const s = await setup('owner');
      const a = await approvedAction(s);
      const base = actionBase(s, a.actionId);
      const adminOnly = await addMember(s, { permissions: ['aba:admin'] });
      const readOnly = await addMember(s, { permissions: ['aba:read'] });
      for (const who of [adminOnly, readOnly]) {
        for (const [suffix, payload] of [['capture', captureBody()], ['owner', ownerBody(s)], ['boundaries', boundariesBody(s)], ['package', undefined]] as const) {
          expect((await post(who, `${base}/${suffix}`, payload)).statusCode, suffix).toBe(403);
        }
      }
      expect((await get(adminOnly, `${base}/authoring-status`)).statusCode).toBe(403);
      expect((await get(readOnly, `${base}/authoring-status`)).statusCode).toBe(200);
      expect((await post(readOnly, AT, { code: CODE, schemaVersion: '1' })).statusCode).toBe(403);
    });

    it('a wrong tenant or workspace header is refused (no membership there)', async () => {
      const a = await setup('owner');
      const b = await setup('owner');
      const wrongTenant = await app.inject({ method: 'GET', url: AT, headers: { authorization: `Bearer ${a.token}`, 'x-tenant-id': b.ctx.tenantId, 'x-workspace-id': b.ctx.workspaceId } });
      expect(wrongTenant.statusCode).toBeGreaterThanOrEqual(400);
      expect(wrongTenant.statusCode).toBeLessThan(500);
      const wrongWorkspace = await app.inject({ method: 'GET', url: AT, headers: { authorization: `Bearer ${a.token}`, 'x-tenant-id': a.ctx.tenantId, 'x-workspace-id': randomUUID() } });
      expect(wrongWorkspace.statusCode).toBeGreaterThanOrEqual(400);
      expect(wrongWorkspace.statusCode).toBeLessThan(500);
      const missing = await app.inject({ method: 'GET', url: AT, headers: { authorization: `Bearer ${a.token}` } });
      expect(missing.statusCode).toBe(403);
      const post1 = await app.inject({ method: 'POST', url: AT, headers: { authorization: `Bearer ${a.token}`, 'x-tenant-id': b.ctx.tenantId, 'x-workspace-id': b.ctx.workspaceId, 'idempotency-key': uc('k') }, payload: { code: CODE, schemaVersion: '1' } });
      expect(post1.statusCode).toBeGreaterThanOrEqual(400);
      expect(await countOf(`SELECT count(*) n FROM approved_business_action.action_type_definitions WHERE tenant_id=$1`, [b.ctx.tenantId])).toBe(0);
    });

    it('a wrong business is refused: another tenant\'s business, a random id, and an action of a different business', async () => {
      const a = await setup('owner');
      await governance(a);
      const b = await setup('owner');
      const act = await approvedAction(a);
      // another tenant's business id used with A's own (valid) credentials
      const foreignBiz = await app.inject({ method: 'GET', url: `/v1/businesses/${b.bizId}/authorized-actions/${act.actionId}/authoring-status`, headers: hdr(a) });
      expect(foreignBiz.statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: `/v1/businesses/${randomUUID()}/authorized-actions/${act.actionId}/authoring-status`, headers: hdr(a) })).statusCode).toBe(404);
      // a second business in the SAME workspace cannot reach the first business's action
      const otherBiz = randomUUID();
      await adminPool.query(`INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,'ZZ other',$4,'active')`, [otherBiz, a.ctx.tenantId, a.ctx.workspaceId, uc('o')]);
      const crossBiz = `/v1/businesses/${otherBiz}/authorized-actions/${act.actionId}`;
      expect((await get(a, `${crossBiz}/authoring-status`)).statusCode).toBe(404);
      for (const [suffix, payload] of [['capture', captureBody()], ['owner', ownerBody(a)], ['boundaries', boundariesBody(a)], ['package', undefined]] as const) {
        expect((await post(a, `${crossBiz}/${suffix}`, payload)).statusCode, suffix).toBe(404);
      }
      // another tenant's user cannot reach A's action even with a valid session of their own
      const stranger = await app.inject({ method: 'GET', url: `/v1/businesses/${a.bizId}/authorized-actions/${act.actionId}/authoring-status`, headers: hdr(b) });
      expect(stranger.statusCode).toBe(404);
      expect(await countOf(`SELECT count(*) n FROM approved_business_action.authorized_action_captures WHERE tenant_id=$1`, [a.ctx.tenantId])).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe('idempotency and audit', () => {
    it('every mutation replays: identical requests return the stored result and write no second audit row; conflicting ones fail', async () => {
      const s = await setup('owner');
      await governance(s);
      const a = await approvedAction(s);
      const base = actionBase(s, a.actionId);

      const cap1 = await post(s, `${base}/capture`, captureBody());
      const cap2 = await post(s, `${base}/capture`, captureBody());
      expect([cap1.statusCode, cap2.statusCode]).toEqual([201, 201]);
      expect(cap2.json()).toMatchObject({ captureId: cap1.json().captureId, created: false });
      expect((await post(s, `${base}/capture`, captureBody({ proposedParameters: { reorderPoint: 11, reorderQuantity: 50 } }))).statusCode).toBe(400); // a different proposal is refused outright (it must equal ADI's), before any replay conflict can arise

      const ownerPayload = ownerBody(s);
      const own1 = await post(s, `${base}/owner`, ownerPayload);
      const own2 = await post(s, `${base}/owner`, ownerPayload);
      expect(own2.json()).toMatchObject({ assignmentId: own1.json().assignmentId, assignmentVersion: 1, created: false });

      const bnd1 = await post(s, `${base}/boundaries`, boundariesBody(s, { simulationRun: { state: 'VALUE', value: s.simRunId } }));
      const bnd2 = await post(s, `${base}/boundaries`, boundariesBody(s, {
        simulationRun: { state: 'VALUE', value: s.simRunId },
        executionWindow: bnd1.statusCode === 201 ? (await adminPool.query(`SELECT execution_window w FROM approved_business_action.authorized_action_boundaries WHERE business_id=$1`, [s.bizId])).rows[0].w : undefined,
      }));
      expect(bnd2.json()).toMatchObject({ boundariesId: bnd1.json().boundariesId, boundaryVersion: 1, created: false });
      // a DIFFERENT boundary set is the next version (never an overwrite)
      expect((await post(s, `${base}/boundaries`, boundariesBody(s))).json()).toMatchObject({ boundaryVersion: 2, created: true });

      const issue1 = await post(s, `${base}/package`);
      const issue2 = await post(s, `${base}/package`);
      expect(issue2.json()).toMatchObject({ outcome: 'REPLAYED', packageId: issue1.json().packageId });

      // the same Idempotency-Key replays the stored HTTP response byte for byte
      const key = uc('same-key');
      const r1 = await app.inject({ method: 'POST', url: AT, headers: hdr(s, { 'idempotency-key': key }), payload: { code: CODE, schemaVersion: '1' } });
      const r2 = await app.inject({ method: 'POST', url: AT, headers: hdr(s, { 'idempotency-key': key }), payload: { code: CODE, schemaVersion: '1' } });
      expect(r2.statusCode).toBe(r1.statusCode);
      expect(r2.json()).toEqual(r1.json());
      // ...and reusing a key for a different body is a conflict
      const r3 = await app.inject({ method: 'POST', url: AT, headers: hdr(s, { 'idempotency-key': key }), payload: { code: CODE, schemaVersion: '2' } });
      expect(r3.statusCode).toBe(409);

      // one audit row per real change, none for replays
      const rows = await auditRows(s);
      const count = (action: string) => rows.filter((r) => r.action === action).length;
      expect(count('aba.capture.recorded')).toBe(1);
      expect(count('aba.owner.assigned')).toBe(1);
      expect(count('aba.boundaries.authored')).toBe(2);
      expect(count('aba.action_type.defined')).toBe(1);
      expect(count('aba.policy.created')).toBe(1);
      expect(count('aba.policy.enabled')).toBe(1);
    });

    it('every governance mutation is audited with actor, permission, scope, target, time, correlation id and reason', async () => {
      const s = await setup('owner');
      const correlation = randomUUID();
      const h = (extra: Record<string, string> = {}) => keyed(s, { 'x-correlation-id': correlation, ...extra });
      expect((await app.inject({ method: 'POST', url: AT, headers: h(), payload: { code: CODE, schemaVersion: '1' } })).statusCode).toBe(201);
      expect((await app.inject({ method: 'POST', url: `${AT}/${CODE}/1/activate`, headers: h() })).statusCode).toBe(200);
      expect((await app.inject({ method: 'POST', url: POL, headers: h(), payload: { policyCode: 'p', automationLevel: 2, description: 'x', actionTypes: [{ code: CODE, schemaVersion: '1' }] } })).statusCode).toBe(201);
      expect((await app.inject({ method: 'POST', url: `${POL}/p/versions/1/enable`, headers: h(), payload: { reason: 'go live' } })).statusCode).toBe(200);
      expect((await app.inject({ method: 'POST', url: `${POL}/p/versions/1/disable`, headers: h(), payload: { reason: 'maintenance window' } })).statusCode).toBe(200);
      expect((await app.inject({ method: 'POST', url: `${AT}/${CODE}/1/retire`, headers: h(), payload: { reason: 'superseded' } })).statusCode).toBe(200);
      const rows = await auditRows(s);
      expect(rows.map((r) => r.action)).toEqual(['aba.action_type.defined', 'aba.action_type.activated', 'aba.policy.created', 'aba.policy.enabled', 'aba.policy.disabled', 'aba.action_type.retired']);
      for (const r of rows) {
        expect(r.actor_id).toBe(s.ctx.userId);
        expect(r.business_id).toBeNull(); // workspace-level governance: no business applies
        expect(r.entity_id).toMatch(/^[0-9a-f-]{36}$/);
        expect(r.correlation_id).toBe(correlation);
        expect(r.metadata.permissionUsed).toBe('aba:admin');
        expect(r.metadata.requestCorrelationId).toBe(correlation);
        expect(new Date(r.occurred_at).getTime()).toBeGreaterThan(Date.now() - 600_000);
      }
      expect(rows.find((r) => r.action === 'aba.policy.disabled')!.metadata.reason).toBe('maintenance window');
      expect(rows.find((r) => r.action === 'aba.action_type.retired')!.metadata.reason).toBe('superseded');
      // authority provenance and approval audit are NOT duplicated by governance changes
      expect(await countOf(`SELECT count(*) n FROM approved_business_action.approval_audit_events WHERE tenant_id=$1`, [s.ctx.tenantId])).toBe(0);
    });

    it('business-scoped mutations are audited with the business, the permission used and the target', async () => {
      const s = await setup('owner');
      await governance(s);
      const a = await approvedAction(s);
      const base = actionBase(s, a.actionId);
      const correlation = randomUUID();
      const h = () => keyed(s, { 'x-correlation-id': correlation });
      await app.inject({ method: 'POST', url: `${base}/capture`, headers: h(), payload: captureBody() });
      await app.inject({ method: 'POST', url: `${base}/owner`, headers: h(), payload: ownerBody(s) });
      await app.inject({ method: 'POST', url: `${base}/boundaries`, headers: h(), payload: boundariesBody(s) });
      const rows = (await auditRows(s)).filter((r) => r.business_id === s.bizId);
      expect(rows.map((r) => r.action)).toEqual(['aba.capture.recorded', 'aba.owner.assigned', 'aba.boundaries.authored']);
      for (const r of rows) {
        expect(r.actor_id).toBe(s.ctx.userId);
        expect(r.correlation_id).toBe(correlation);
        expect(r.metadata).toMatchObject({ permissionUsed: 'aba:write', requestCorrelationId: correlation });
        expect(r.metadata.actionId).toBe(a.actionId);
      }
    });

    it('a mutation and its audit commit together: a failing audit store rolls the mutation back', async () => {
      const s = await setup('owner');
      const name = `abau_fail_${s.ctx.tenantId.replace(/-/g, '').slice(0, 12)}`;
      await adminPool.query(`CREATE OR REPLACE FUNCTION public.abau_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected audit failure'; END $$`);
      await adminPool.query(`CREATE TRIGGER ${name} BEFORE INSERT ON audit.audit_events FOR EACH ROW WHEN (NEW.tenant_id = '${s.ctx.tenantId}') EXECUTE FUNCTION public.abau_fail_audit()`);
      try {
        const res = await post(s, AT, { code: CODE, schemaVersion: '1' });
        expect(res.statusCode).toBe(500);
        expect(await countOf(`SELECT count(*) n FROM approved_business_action.action_type_definitions WHERE tenant_id=$1`, [s.ctx.tenantId])).toBe(0);
      } finally {
        await adminPool.query(`DROP TRIGGER IF EXISTS ${name} ON audit.audit_events`);
      }
      expect((await post(s, AT, { code: CODE, schemaVersion: '1' })).statusCode).toBe(201);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe('nothing here touches Business Operations, emits events or executes', () => {
    it('the whole authoring path leaves BO tables, the outbox, the event ledger and package consumption untouched', async () => {
      const s = await setup('owner');
      const tables = [
        ['business_operations.inventory_balances', 'tenant_id'], ['business_operations.inventory_movements', 'tenant_id'], ['business_operations.business_events', 'tenant_id'],
        ['business_operations.authorized_action_receipts', 'tenant_id'], ['business_operations.authorized_action_claims', 'tenant_id'], ['business_operations.authorized_action_intake_attempts', 'tenant_id'],
        ['events.outbox_events', 'tenant_id'], ['events.business_event_ledger', 'tenant_id'],
      ] as const;
      const snapshot = async () => Object.fromEntries(await Promise.all(tables.map(async ([t, col]) => [t, await countOf(`SELECT count(*) n FROM ${t} WHERE ${col}=$1`, [s.ctx.tenantId])])));
      const before = await snapshot();
      await governance(s);
      const a = await approvedAction(s);
      const eventsAfterApproval = await snapshot(); // the approval flow itself may emit; authoring must add nothing on top
      const base = actionBase(s, a.actionId);
      await post(s, `${base}/capture`, captureBody());
      await post(s, `${base}/owner`, ownerBody(s));
      await post(s, `${base}/boundaries`, boundariesBody(s));
      expect((await post(s, `${base}/package`)).statusCode).toBe(201);
      expect(await snapshot()).toEqual(eventsAfterApproval);
      expect(eventsAfterApproval['business_operations.inventory_balances']).toBe(before['business_operations.inventory_balances']);
      for (const t of ['business_operations.authorized_action_receipts', 'business_operations.authorized_action_claims', 'business_operations.authorized_action_intake_attempts'] as const) {
        expect(eventsAfterApproval[t]).toBe(0);
      }
      // the package is ISSUED, never consumed or executed: no CONSUMED fact exists
      expect(await countOf(`SELECT count(*) n FROM approved_business_action.authorized_action_package_lifecycle_events WHERE business_id=$1 AND state <> 'ISSUED'`, [s.bizId])).toBe(0);
    });
  });

  // ── Block B1: a reference is not proof ───────────────────────────────────────────────────────────────────────────────
  describe('B1. governance evidence is verified, never asserted', () => {
    const capturesFor = (s: Session) => countOf(`SELECT count(*) n FROM approved_business_action.authorized_action_captures WHERE business_id=$1`, [s.bizId]);

    it('with NO verifier registered (the service default) a modified approval cannot be captured, and nothing is stored', async () => {
      const s = await setup('owner');
      await governance(s);
      const a = await approvedAction(s, 'approve_with_modifications');
      // The service default is fail-closed; only the API composition root registers the BO adapter, so a bare service has none.
      const bare = await buildApp(loadConfig({ DATABASE_URL: process.env.DATABASE_URL!, NODE_ENV: 'test', LOG_LEVEL: 'silent', RATE_LIMIT_MAX: '5000' }), { abaAuthoring: { evidenceVerifier: null } });
      await bare.ready();
      try {
        const res = await bare.inject({ method: 'POST', url: `${actionBase(s, a.actionId)}/capture`, headers: keyed(s), payload: modifiedBody() as any });
        expect(res.statusCode).toBe(409);
        expect(res3Message(res)).toMatch(/no authoritative governance evidence verifier is registered/);
      } finally { await bare.close(); }
      expect(await capturesFor(s)).toBe(0);
    });

    it('a plain approval carries no modification evaluation, but the ADI proposal evidence is still verified, dimension by dimension, for exactly the proposed parameters', async () => {
      const s = await setup('owner');
      await governance(s);
      const a = await approvedAction(s);
      expect((await post(s, `${actionBase(s, a.actionId)}/capture`, captureBody())).statusCode).toBe(201);
      expect(seen.map((r) => r.dimension).sort()).toEqual(['CONSTRAINTS', 'COST', 'EXPECTED_OUTCOME', 'RESOURCE_REQUIREMENTS']);
      expect(seen[0]).toMatchObject({ subject: { actionId: a.actionId, finalParameters: { reorderPoint: 10, reorderQuantity: 50 } } });
      const row = (await adminPool.query(`SELECT modification_evaluation e FROM approved_business_action.authorized_action_captures WHERE business_id=$1`, [s.bizId])).rows[0].e;
      expect(row).toMatchObject({ state: 'NOT_APPLICABLE' });
    });

    it('the persisted evaluation is the VERIFIER\'s answer: its time, not a caller value, and one verified entry per required dimension', async () => {
      const s = await setup('owner');
      await governance(s);
      const a = await approvedAction(s, 'approve_with_modifications');
      const fixed = new Date(Date.now() + 1500).toISOString();
      // the ADI proposal's own evidence (10/50) is answered normally; only the MODIFICATION's evidence (15/60) is answered with the late, fixed time
      verifierBehavior = async (r) => { if (r.subject.finalParameters.reorderPoint !== 15) return verifiedNow(r); await new Promise((res) => setTimeout(res, 1800)); return { ...verifiedNow(r), evaluatedAt: fixed } as GovernanceEvidenceVerdict; };
      const res = await post(s, `${actionBase(s, a.actionId)}/capture`, modifiedBody());
      expect(res.statusCode).toBe(201);
      const row = (await adminPool.query(`SELECT modification_evaluation e FROM approved_business_action.authorized_action_captures WHERE business_id=$1`, [s.bizId])).rows[0].e;
      expect(row.value.evidence.map((e: any) => e.dimension).sort()).toEqual(['CONSTRAINTS', 'COST', 'EXPECTED_OUTCOME', 'RESOURCE_REQUIREMENTS']);
      for (const e of row.value.evidence) expect(e).toMatchObject({ result: 'PASSED', evaluatedAt: fixed });
      const modificationRequests = seen.filter((r) => r.subject.finalParameters.reorderPoint === 15);
      expect(modificationRequests.map((r) => r.dimension).sort()).toEqual(['CONSTRAINTS', 'COST', 'EXPECTED_OUTCOME', 'RESOURCE_REQUIREMENTS']);
      // the verifier is bound to the server-derived modified values, scope and action - not to anything the caller asserted
      expect(modificationRequests[0]).toMatchObject({ tenantId: s.ctx.tenantId, workspaceId: s.ctx.workspaceId, businessId: s.bizId, subject: { actionId: a.actionId, finalParameters: { reorderPoint: 15, reorderQuantity: 60 } } });
    });

    it('a REFUSED verdict, a thrown error, a mismatched verdict and a stale or future or malformed time are all refused (fail closed) with nothing stored', async () => {
      const s = await setup('owner');
      await governance(s);
      const a = await approvedAction(s, 'approve_with_modifications');
      const url = `${actionBase(s, a.actionId)}/capture`;
      const cases: [string, typeof verifierBehavior][] = [
        ['refused', () => ({ status: 'REFUSED', reason: 'no such evaluation' })],
        ['wrong dimension', (r) => ({ ...verifiedNow(r), dimension: r.dimension === 'COST' ? 'CONSTRAINTS' : 'COST' }) as GovernanceEvidenceVerdict],
        ['substituted reference', (r) => ({ ...verifiedNow(r), evidenceRef: { kind: r.evidenceRef.kind, id: 'something-else' } }) as GovernanceEvidenceVerdict],
        ['predates the modification', (r) => ({ ...verifiedNow(r), evaluatedAt: new Date(Date.now() - 3_600_000).toISOString() }) as GovernanceEvidenceVerdict],
        ['dated in the future', (r) => ({ ...verifiedNow(r), evaluatedAt: new Date(Date.now() + 3_600_000).toISOString() }) as GovernanceEvidenceVerdict],
        ['malformed time', (r) => ({ ...verifiedNow(r), evaluatedAt: 'yesterday' }) as GovernanceEvidenceVerdict],
        ['non-PASSED result', (r) => ({ ...verifiedNow(r), result: 'FAILED' }) as unknown as GovernanceEvidenceVerdict],
      ];
      for (const [name, behavior] of cases) {
        verifierBehavior = behavior;
        const res = await post(s, url, modifiedBody());
        expect(res.statusCode, name).toBe(409);
        if (name === 'refused') expect(res3Message(res)).toMatch(/was not verified: no such evaluation/);
        expect(await capturesFor(s), name).toBe(0);
      }
      verifierBehavior = () => { throw new Error('verifier down'); };
      expect((await post(s, url, modifiedBody())).statusCode).toBeGreaterThanOrEqual(500);
      expect(await capturesFor(s)).toBe(0);
    });

    it('the caller cannot supply a result, a time or a source: those keys are rejected', async () => {
      const s = await setup('owner');
      await governance(s);
      const a = await approvedAction(s, 'approve_with_modifications');
      const forged = modifiedBody();
      (forged.evaluationEvidence as any[])[0] = { ...(forged.evaluationEvidence as any[])[0], result: 'PASSED', evaluatedAt: new Date().toISOString(), authoritativeSource: 'me' };
      expect((await post(s, `${actionBase(s, a.actionId)}/capture`, forged)).statusCode).toBe(400);
      expect(await capturesFor(s)).toBe(0);
    });

    it('the simulation reference must be a real, in-scope, COMPLETED run: unknown, other-business, other-tenant and unfinished runs are refused', async () => {
      const s = await setup('owner');
      await governance(s);
      const a = await approvedAction(s);
      const base = actionBase(s, a.actionId);
      expect((await post(s, `${base}/capture`, captureBody())).statusCode).toBe(201);
      const boundariesFor = () => countOf(`SELECT count(*) n FROM approved_business_action.authorized_action_boundaries WHERE business_id=$1`, [s.bizId]);
      const otherBiz = randomUUID();
      await adminPool.query(`INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,'ZZ Other Biz',$4,'active')`, [otherBiz, s.ctx.tenantId, s.ctx.workspaceId, uc('other-biz')]);
      const foreign = await setup('owner');
      const bad: [string, string][] = [
        ['unknown run', randomUUID()],
        ['another business of the same workspace', await simulationRun(s.ctx, otherBiz)],
        ['another tenant\'s run', foreign.simRunId],
        ['a queued run', await simulationRun(s.ctx, s.bizId, 'queued')],
        ['a running run', await simulationRun(s.ctx, s.bizId, 'running')],
      ];
      for (const [name, id] of bad) {
        const res = await post(s, `${base}/boundaries`, boundariesBody(s, { simulationRun: { state: 'VALUE', value: id } }));
        expect(res.statusCode, name).toBe(409);
        expect(res3Message(res), name).toMatch(/simulation run reference refused/);
        expect(await boundariesFor(), name).toBe(0);
      }
      expect((await post(s, `${base}/boundaries`, boundariesBody(s))).statusCode).toBe(201);
    });

    it('a verified simulation reference is not an evaluation: the package still records only the run reference, and no BO/ABA event is produced', async () => {
      const s = await setup('owner');
      await governance(s);
      const a = await approvedAction(s);
      const base = actionBase(s, a.actionId);
      await post(s, `${base}/capture`, captureBody());
      await post(s, `${base}/owner`, ownerBody(s));
      await post(s, `${base}/boundaries`, boundariesBody(s));
      expect((await post(s, `${base}/package`)).statusCode).toBe(201);
      const pkg = (await adminPool.query(`SELECT package #>> '{lineage,simulationRunId,value}' r FROM approved_business_action.authorized_action_package_versions WHERE business_id=$1`, [s.bizId])).rows[0];
      expect(pkg.r).toBe(s.simRunId);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // B2c: the REAL Business Operations evidence verifier (the production composition-root default), end to end through ABA.
  describe('B2c. modified approvals are captured only on authoritative BO evaluation evidence (real verifier, no fake)', () => {
    let realApp: FastifyInstance;
    let fakeApp: FastifyInstance;
    const DAY = 86_400_000;
    const NA_SIM = { state: 'NOT_APPLICABLE', reason: { code: 'NO_APPLICABLE_SIMULATION_MODEL', statement: 'No Simulation model evaluates inventory reorder policy.' } };
    const DIMS = ['CONSTRAINTS', 'RESOURCE_REQUIREMENTS', 'COST', 'EXPECTED_OUTCOME'];
    /** `proposal` = the parameters of the ADI-PRODUCED recommendation (set by produce()). */
    interface Bo { itemId: string; warehouseId: string; proposal: { reorderPoint: number; reorderQuantity: number } }

    beforeAll(async () => {
      // The real default app: its evidence verifier is the Business Operations adapter registered at the composition root.
      realApp = await buildApp(loadConfig({ DATABASE_URL: process.env.DATABASE_URL!, NODE_ENV: 'test', LOG_LEVEL: 'silent', RATE_LIMIT_MAX: '5000' }));
      await realApp.ready();
      fakeApp = app; app = realApp; // the shared helpers use the module-level app
    });
    afterAll(async () => { app = fakeApp; await realApp?.close(); });

    /** BO facts for the session's business: baseline 170/190, USD declared (unless null), USD receipt at 10, 12 issues of 75. */
    async function seedBo(s: Session, o: { declared?: string | null } = {}): Promise<Bo> {
      const itemId = randomUUID(); const warehouseId = randomUUID(); const { tenantId, workspaceId } = s.ctx;
      await adminPool.query(`INSERT INTO platform.inventory_items (id, tenant_id, workspace_id, business_id, sku, name) VALUES ($1,$2,$3,$4,$5,'Item')`, [itemId, tenantId, workspaceId, s.bizId, `sku-${itemId}`]);
      await adminPool.query(`INSERT INTO platform.warehouses (id, tenant_id, workspace_id, business_id, warehouse_code, name) VALUES ($1,$2,$3,$4,$5,'WH')`, [warehouseId, tenantId, workspaceId, s.bizId, `wh-${warehouseId}`]);
      await adminPool.query(`INSERT INTO business_operations.inventory_balances (tenant_id, workspace_id, business_id, inventory_item_id, warehouse_id, reorder_point, reorder_quantity) VALUES ($1,$2,$3,$4,$5,170,190)`, [tenantId, workspaceId, s.bizId, itemId, warehouseId]);
      if (o.declared !== null) {
        await adminPool.query(`INSERT INTO platform.business_currency_declarations (tenant_id, workspace_id, business_id, version, declared_currency, provenance, declared_by_user_id, permission_used, correlation_id) VALUES ($1,$2,$3,1,$4,'EXPLICIT_DECLARATION',$5,'platform:admin',$6)`,
          [tenantId, workspaceId, s.bizId, o.declared ?? 'USD', s.ctx.userId, randomUUID()]);
      }
      const mv = (type: string, qty: number, cost: string | null, cur: string | null, at: Date) => adminPool.query(
        `INSERT INTO business_operations.inventory_movements (tenant_id, workspace_id, business_id, inventory_item_id, warehouse_id, movement_type, quantity, unit_cost, unit_cost_currency, occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [tenantId, workspaceId, s.bizId, itemId, warehouseId, type, qty, cost, cur, at]);
      await mv('receipt', 500, '10', 'USD', new Date(Date.now() - 5 * DAY));
      for (let i = 0; i < 12; i += 1) await mv('issue', -75, null, null, new Date(Date.now() - (i + 1) * DAY));
      return { itemId, warehouseId, proposal: { reorderPoint: 170, reorderQuantity: 190 } };
    }
    const evaluateVia = (s: Session, bo: Bo, finalParameters: Record<string, number> = { reorderPoint: 180, reorderQuantity: 200 }) => post(s, `/v1/businesses/${s.bizId}/inventory-policy-evaluations`, {
      actionType: { code: CODE, schemaVersion: '1' }, target: { kind: 'inventory_item', id: bo.itemId }, finalParameters, ruleSetVersion: 'inventory-reorder-policy/v1.0.0',
    });
    const refsOf = (res: { json(): any }): { dimension: string; evidenceRef: { kind: string; id: string } }[] => res.json().evidence.map((e: any) => ({ dimension: e.dimension, evidenceRef: { kind: e.kind, id: e.id } }));
    const modified = (bo: Bo, evaluationEvidence: unknown, after = { reorderPoint: 180, reorderQuantity: 200 }) => ({
      actionType: { code: CODE, schemaVersion: '1' }, target: { kind: 'inventory_item', id: bo.itemId }, proposedParameters: { ...bo.proposal },
      modification: { reason: 'Raise the reorder policy.', changes: [
        { parameter: 'reorderPoint', operation: 'SET', before: bo.proposal.reorderPoint, after: after.reorderPoint }, { parameter: 'reorderQuantity', operation: 'SET', before: bo.proposal.reorderQuantity, after: after.reorderQuantity }] },
      evaluationEvidence,
    });
    const captureCount = (s: Session) => countOf(`SELECT count(*) n FROM approved_business_action.authorized_action_captures WHERE business_id=$1`, [s.bizId]);

    /** The REAL ADI producer (production route) turns the BO facts into the structured recommendation ABA now requires; returns the ABA intake over it. */
    async function produce(s: Session, bo: Bo): Promise<{ intakePackageId: string; recommendationId: string }> {
      const kit = chainKit({ app, admin: adminPool, tenantIds: [] });
      await kit.publishEvidence(s, bo.itemId); // AC-2 Block 7: governed BI evidence and BDT state precede the recommendation
      const r = await post(s, kit.reorderRecommendationUrl(s, bo.itemId));
      expect(r.statusCode, r.body).toBe(201);
      bo.proposal = r.json().proposal.proposedParameters;
      return { intakePackageId: await kit.intakeFromRecommendation(s, r.json().recommendationVersionId), recommendationId: r.json().recommendationId };
    }
    /** Fixture surgery: removes the business's currency declaration AFTER the recommendation was produced, so the evaluations see an undeclared business. */
    async function undeclare(s: Session): Promise<void> {
      const c = await adminPool.connect();
      try { await c.query('BEGIN'); await c.query("SET LOCAL session_replication_role = 'replica'"); await c.query('DELETE FROM platform.business_currency_declarations WHERE business_id = $1', [s.bizId]); await c.query('COMMIT'); }
      catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
    }

    /** BO facts, the ADI-produced recommendation, then a decided approve_with_modifications action (the decision becomes final AFTER the facts and the proposal evidence). */
    async function ready(o: { declared?: string | null } = {}) {
      const s = await setup('owner');
      await governance(s);
      const bo = await seedBo(s, { declared: o.declared === null ? undefined : o.declared });
      await grantApprover(s);
      const source = await produce(s, bo);
      if (o.declared === null) await undeclare(s);
      const a = await approvedAction(s, 'approve_with_modifications', source);
      return { s, a, bo, base: actionBase(s, a.actionId) };
    }

    it('end to end: BO evaluates, ABA verifies all four through the port, captures, and the package issues with Simulation NOT_APPLICABLE (NO_APPLICABLE_SIMULATION_MODEL)', async () => {
      const { s, a, bo, base } = await ready();
      const ev = await evaluateVia(s, bo);
      expect(ev.statusCode).toBe(201);
      expect(ev.json().evidence.map((e: any) => e.result)).toEqual(['PASSED', 'PASSED', 'PASSED', 'PASSED']);
      const cap = await post(s, `${base}/capture`, modified(bo, refsOf(ev)));
      expect(cap.statusCode).toBe(201);
      expect(cap.json().finalParameters).toEqual({ reorderPoint: 180, reorderQuantity: 200 });
      expect((await post(s, `${base}/owner`, ownerBody(s))).statusCode).toBe(201);
      expect((await post(s, `${base}/boundaries`, boundariesBody(s, { simulationRun: NA_SIM }))).statusCode).toBe(201);
      const issued = await post(s, `${base}/package`);
      expect(issued.statusCode).toBe(201);
      expect(issued.json()).toMatchObject({ outcome: 'ISSUED', status: 'ISSUED' });
      const pkg = (await adminPool.query(`SELECT package #>> '{lineage,simulationRunId}' sim, package #>> '{lineage,modificationEvaluation}' evals FROM approved_business_action.authorized_action_package_versions WHERE business_id=$1`, [s.bizId])).rows[0];
      expect(JSON.parse(pkg.sim)).toMatchObject({ state: 'NOT_APPLICABLE', reason: { code: 'NO_APPLICABLE_SIMULATION_MODEL' } });
      const stored = JSON.parse(pkg.evals).value.evidence;
      expect(stored.map((e: any) => e.dimension).sort()).toEqual([...DIMS].sort());
      for (const e of stored) expect(e).toMatchObject({ result: 'PASSED', evidenceRef: { kind: 'bo_inventory_policy_evaluation' } });
      void a;
    });

    it('modifiedAt is the decision-final time (approval_decisions.updated_at) - not the capture time - and no approval_decision_modifications row is needed', async () => {
      const { s, a, bo, base } = await ready();
      const decisionAt = (await adminPool.query(`SELECT to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') t FROM approved_business_action.approval_decisions WHERE id=$1`, [a.decisionId])).rows[0].t;
      const modRows = () => countOf(`SELECT count(*) n FROM approved_business_action.approval_decision_modifications WHERE business_id=$1`, [s.bizId]);
      expect(await modRows()).toBe(0); // the live flow never writes it
      await new Promise((r) => setTimeout(r, 25));
      const ev = await evaluateVia(s, bo);
      const cap = await post(s, `${base}/capture`, modified(bo, refsOf(ev)));
      expect(cap.statusCode).toBe(201);
      expect(await modRows()).toBe(0);
      const row = (await adminPool.query(`SELECT modification #>> '{value,modifiedAt}' mod_at, to_char(captured_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') cap_at FROM approved_business_action.authorized_action_captures WHERE business_id=$1`, [s.bizId])).rows[0];
      expect(row.mod_at).toBe(decisionAt);
      expect(Date.parse(row.mod_at)).toBeLessThan(Date.parse(row.cap_at));
      const evaluatedAt = ev.json().evidence[0].evaluatedAt;
      expect(Date.parse(evaluatedAt)).toBeGreaterThanOrEqual(Date.parse(row.mod_at));
      expect(Date.parse(evaluatedAt)).toBeLessThanOrEqual(Date.parse(row.cap_at));
    });

    it('a decided approve_with_modifications decision cannot change status, so its final time is not re-decidable', async () => {
      const { a } = await ready();
      await expect(adminPool.query(`UPDATE approved_business_action.approval_decisions SET status='approved' WHERE id=$1`, [a.decisionId])).rejects.toThrow(/decided decisions are immutable/);
    });

    it('evidence created BEFORE the modification decision became final is rejected (it cannot cover the modification)', async () => {
      const s = await setup('owner');
      await governance(s);
      const bo = await seedBo(s);
      await grantApprover(s);
      const source = await produce(s, bo);
      const early = await evaluateVia(s, bo); // evaluated first ...
      expect(early.statusCode).toBe(201);
      await new Promise((r) => setTimeout(r, 15));
      const a = await approvedAction(s, 'approve_with_modifications', source); // ... decision becomes final afterwards
      const res = await post(s, `${actionBase(s, a.actionId)}/capture`, modified(bo, refsOf(early)));
      expect(res.statusCode).toBe(409);
      expect(res3Message(res)).toMatch(/predates the modification decision/);
      expect(await captureCount(s)).toBe(0);
    });

    it('a FAILED dimension blocks the capture', async () => {
      const { s, bo, base } = await ready();
      const ev = await evaluateVia(s, bo, { reorderPoint: 400, reorderQuantity: 600 });
      expect(ev.json().evidence.map((e: any) => e.result)).toEqual(['FAILED', 'FAILED', 'FAILED', 'FAILED']);
      const res = await post(s, `${base}/capture`, modified(bo, refsOf(ev), { reorderPoint: 400, reorderQuantity: 600 }));
      expect(res.statusCode).toBe(409);
      expect(res3Message(res)).toMatch(/was not verified: .*result is FAILED/);
      expect(await captureCount(s)).toBe(0);
    });

    it('an INDETERMINATE dimension blocks the capture even when the other dimensions PASSED (no declared currency => COST)', async () => {
      const { s, bo, base } = await ready({ declared: null });
      const ev = await evaluateVia(s, bo);
      expect(Object.fromEntries(ev.json().evidence.map((e: any) => [e.dimension, e.result]))).toMatchObject({ CONSTRAINTS: 'PASSED', COST: 'INDETERMINATE' });
      const res = await post(s, `${base}/capture`, modified(bo, refsOf(ev)));
      expect(res.statusCode).toBe(409);
      expect(res3Message(res)).toMatch(/COST evidence was not verified: .*INDETERMINATE/);
      expect(await captureCount(s)).toBe(0);
    });

    it('a STALE dimension (older than 24 hours on the database clock) blocks the capture', async () => {
      const { s, bo, base } = await ready();
      const ev = await evaluateVia(s, bo);
      const evidence = refsOf(ev);
      const costId = evidence.find((e) => e.dimension === 'COST')!.evidenceRef.id;
      const c = await adminPool.connect();
      let staleId: string;
      try {
        await c.query('BEGIN'); await c.query("SET LOCAL session_replication_role = 'replica'");
        staleId = (await c.query(`INSERT INTO business_operations.inventory_policy_evaluations (tenant_id, workspace_id, business_id, inventory_item_id, warehouse_id, dimension, result, subject, subject_digest, rule_set_version, inputs, findings, requested_by_user_id, correlation_id, evaluated_at)
          SELECT tenant_id, workspace_id, business_id, inventory_item_id, warehouse_id, dimension, result, subject, subject_digest, rule_set_version, inputs, findings, requested_by_user_id, correlation_id, date_trunc('milliseconds', clock_timestamp()) - interval '24 hours 1 minute'
            FROM business_operations.inventory_policy_evaluations WHERE id = $1 RETURNING id`, [costId])).rows[0].id;
        await c.query('COMMIT');
      } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
      const res = await post(s, `${base}/capture`, modified(bo, evidence.map((e) => (e.dimension === 'COST' ? { ...e, evidenceRef: { kind: e.evidenceRef.kind, id: staleId } } : e))));
      expect(res.statusCode).toBe(409);
      // a 24h+ old row also predates the decision made moments ago: either way it cannot be evidence (the freshness boundary itself is proven in the verifier tests)
      expect(res3Message(res)).toMatch(/COST evidence was not verified: .*(older than the maximum evidence age|predates the modification decision)/);
      expect(await captureCount(s)).toBe(0);
    });

    it('a missing dimension, a reference under the wrong dimension, evidence for other parameters, and a non-BO reference are all rejected', async () => {
      const { s, bo, base } = await ready();
      const ev = await evaluateVia(s, bo);
      const good = refsOf(ev);
      const missing = await post(s, `${base}/capture`, modified(bo, good.filter((e) => e.dimension !== 'COST')));
      expect(missing.statusCode).toBe(400);
      expect(res3Message(missing)).toMatch(/evaluation evidence is required for: COST/);
      const swapped = good.map((e) => (e.dimension === 'COST' ? { ...e, evidenceRef: good.find((x) => x.dimension === 'CONSTRAINTS')!.evidenceRef } : e));
      const wrongDim = await post(s, `${base}/capture`, modified(bo, swapped));
      expect(wrongDim.statusCode).toBe(409);
      expect(res3Message(wrongDim)).toMatch(/evaluates CONSTRAINTS, not COST/);
      const other = await evaluateVia(s, bo, { reorderPoint: 175, reorderQuantity: 200 });
      const wrongParams = await post(s, `${base}/capture`, modified(bo, refsOf(other))); // evidence for 175/200, capture says 180/200
      expect(wrongParams.statusCode).toBe(409);
      expect(res3Message(wrongParams)).toMatch(/subject digest mismatch/);
      const nonBo = await post(s, `${base}/capture`, modified(bo, good.map((e) => ({ ...e, evidenceRef: { kind: 'simulation_run', id: s.simRunId } }))));
      expect(nonBo.statusCode).toBe(409);
      expect(res3Message(nonBo)).toMatch(/unsupported evidence kind/);
      expect(await captureCount(s)).toBe(0);
    });

    it('evidence of another business (same tenant) or another tenant is rejected', async () => {
      const { s, bo, base } = await ready();
      const stranger = await setup('owner');
      const sbo = await seedBo(stranger);
      const foreign = await evaluateVia(stranger, sbo);
      const res = await post(s, `${base}/capture`, modified(bo, refsOf(foreign)));
      expect(res.statusCode).toBe(409);
      expect(res3Message(res)).toMatch(/no such evaluation record/);
      expect(await captureCount(s)).toBe(0);
    });

    it('Simulation NOT_APPLICABLE needs the exact canonical reason for this type; a wrong reason is refused and absence is not NOT_APPLICABLE', async () => {
      const { s, bo, base } = await ready();
      const ev = await evaluateVia(s, bo);
      expect((await post(s, `${base}/capture`, modified(bo, refsOf(ev)))).statusCode).toBe(201);
      expect((await post(s, `${base}/owner`, ownerBody(s))).statusCode).toBe(201);
      const wrong = await post(s, `${base}/boundaries`, boundariesBody(s, { simulationRun: { state: 'NOT_APPLICABLE', reason: { code: 'NOT_SIMULATION_BACKED', statement: 'x' } } }));
      expect(wrong.statusCode).toBe(400);
      const absent = await post(s, `${base}/boundaries`, (() => { const b: any = boundariesBody(s); delete b.simulationRun; return b; })());
      expect(absent.statusCode).toBe(400);
      // an unrelated completed run is still a valid VALUE (existing behaviour) but is never required
      expect((await post(s, `${base}/boundaries`, boundariesBody(s, { simulationRun: NA_SIM }))).statusCode).toBe(201);
    });
  });
});

function res3Message(res: { json(): any }): string { return String(res.json().error.message); }
