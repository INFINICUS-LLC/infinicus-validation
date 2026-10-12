/**
 * Block B2d - END-TO-END MODIFIED-APPROVAL AUTHORING PROOF (pre-execution only).
 *
 *   approve_with_modifications -> BO evaluation -> four authoritative evidence records -> ABA verification through the
 *   GovernanceEvidenceVerifier port -> capture -> owner assignment -> governed boundaries -> AuthorizedActionPackage issuance.
 *
 * It ends at the sealed package. Nothing here sends the package to Business Operations intake, claims it, executes anything, changes
 * reorderPoint/reorderQuantity, emits ExecutionEvidence or enables a production capability.
 *
 * REAL components throughout (no fake verifier, no stubbed service): the Fastify application with its production composition root,
 * DecisionWorkflowService, the BO evaluation service/repository/route, BoGovernanceEvidenceVerifier, AbaAuthoringService, the
 * AuthorizedActionPackageIssuer, the canonical contract validator, audit persistence and PostgreSQL with RLS enforced for the app role.
 * Requires DATABASE_URL (app role) and ADMIN_DATABASE_URL (fixtures / inspection / teardown), migrated through 0187.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- HTTP payloads and stored JSON documents are arbitrary JSON */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '@infinicus/configuration';
import { createPool, closePool, UserRepository, MembershipRepository, ApprovedActionRepository, type TenantContext } from '@infinicus/database';
import { DEFAULT_APPROVER_ASSIGNMENT_CODE } from '@infinicus/workflow';
import {
  canonicalActionTypeRegistry, canonicalize, validateAuthorizedActionPackage, simulationNotApplicableProblem,
  SIMULATION_NOT_APPLICABLE_ALLOWED, SIMULATION_NOT_APPLICABLE_REASON_CODE, INVENTORY_REORDER_POLICY_UPDATE_V1,
} from '@infinicus/handoff-contracts';
import { PRODUCTION_SUPPORTED_ACTION_TYPES, PRODUCTION_BO_CAPABILITIES } from '@infinicus/business-operations-runtime';
import { buildApp } from '../src/app.js';
import { createAbaFixture, APPROVABLE_FACTS, uc } from './helpers/abaFixtures.js';
import { deleteMovementsForTenants } from './helpers/movementCleanup.js';

const run = !!process.env.DATABASE_URL && !!process.env.ADMIN_DATABASE_URL;
const STRONG_PASSWORD = 'Correct-Horse-9!';
const CODE = 'inventory_reorder_policy_update';
const RULE_SET = 'inventory-reorder-policy/v1.0.0';
const DAY = 86_400_000;
const hoursFromNow = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString();
const DIMENSIONS = ['CONSTRAINTS', 'RESOURCE_REQUIREMENTS', 'COST', 'EXPECTED_OUTCOME'];
/** The governed Simulation state for this action type (owner ruling, B2c amendment). */
const SIMULATION_NA = { state: 'NOT_APPLICABLE', reason: { code: 'NO_APPLICABLE_SIMULATION_MODEL', statement: 'No Simulation model evaluates inventory reorder policy.' } };
/** BO baseline 170/190 (so 180/200 is inside the 25% change bounds) -> the modification being authorized. */
const BASELINE = { reorderPoint: 170, reorderQuantity: 190 };
const FINAL = { reorderPoint: 180, reorderQuantity: 200 };

let adminPool: Pool;
let app: FastifyInstance;
const tenantIds: string[] = [];

interface Session { ctx: TenantContext; token: string; bizId: string; membershipId: string }
interface Bo { itemId: string; warehouseId: string }
interface Chain { s: Session; actionId: string; decisionId: string; bo: Bo; base: string }

// ── fixtures: identity, tenancy, BO facts ──────────────────────────────────────────────────────────────────────────────

async function registerActiveUser(): Promise<{ userId: string; token: string }> {
  const email = `${uc('b2d')}@b2d.example`;
  const reg = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, password: STRONG_PASSWORD } });
  expect(reg.statusCode).toBe(201);
  const userId = reg.json().id as string;
  await new UserRepository().activate(userId);
  const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: STRONG_PASSWORD } });
  return { userId, token: login.json().rawSessionToken as string };
}
async function grantOwner(ctx: TenantContext, userId: string): Promise<string> {
  const memberships = new MembershipRepository();
  const m = await memberships.create(ctx, userId);
  await memberships.activate(ctx, m.id);
  const roleId = (await adminPool.query(`SELECT id FROM tenancy.roles WHERE tenant_id IS NULL AND code = 'owner'`)).rows[0].id;
  await memberships.assignRole(ctx, m.id, roleId);
  return m.id;
}
/** A fresh tenant + workspace + business and an OWNER user (canonical Identity/Tenancy relationship: an active membership holding the owner role). */
async function setup(): Promise<Session> {
  const { userId, token } = await registerActiveUser();
  const tenantId = randomUUID(); const workspaceId = randomUUID(); const sfx = uc('s');
  tenantIds.push(tenantId);
  await adminPool.query(`INSERT INTO tenancy.tenants (id, name, slug, status, plan_code) VALUES ($1,'B2d Tenant',$2,'active','test')`, [tenantId, `b2d-${sfx}`]);
  await adminPool.query(`INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,'B2d WS',$3,'active')`, [workspaceId, tenantId, `b2d-ws-${sfx}`]);
  const ctx: TenantContext = { tenantId, workspaceId, userId };
  const membershipId = await grantOwner(ctx, userId);
  const bizId = randomUUID();
  await adminPool.query(`INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,'ZZ B2d Biz',$4,'active')`, [bizId, tenantId, workspaceId, uc('b2d-biz')]);
  return { ctx, token, bizId, membershipId };
}
/** Authoritative BO facts: item, balance 170/190, USD declared (once per business), USD receipt at unit cost 10, 12 issues of 75 in the last 12 days. */
async function seedBo(s: Session, o: { declare?: boolean } = {}): Promise<Bo> {
  const itemId = randomUUID(); const warehouseId = randomUUID(); const { tenantId, workspaceId } = s.ctx;
  await adminPool.query(`INSERT INTO platform.inventory_items (id, tenant_id, workspace_id, business_id, sku, name) VALUES ($1,$2,$3,$4,$5,'Item')`, [itemId, tenantId, workspaceId, s.bizId, `sku-${itemId}`]);
  await adminPool.query(`INSERT INTO platform.warehouses (id, tenant_id, workspace_id, business_id, warehouse_code, name) VALUES ($1,$2,$3,$4,$5,'WH')`, [warehouseId, tenantId, workspaceId, s.bizId, `wh-${warehouseId}`]);
  await adminPool.query(`INSERT INTO business_operations.inventory_balances (tenant_id, workspace_id, business_id, inventory_item_id, warehouse_id, reorder_point, reorder_quantity) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [tenantId, workspaceId, s.bizId, itemId, warehouseId, BASELINE.reorderPoint, BASELINE.reorderQuantity]);
  if (o.declare !== false) {
    await adminPool.query(`INSERT INTO platform.business_currency_declarations (tenant_id, workspace_id, business_id, version, declared_currency, provenance, declared_by_user_id, permission_used, correlation_id) VALUES ($1,$2,$3,1,'USD','EXPLICIT_DECLARATION',$4,'platform:admin',$5)`,
      [tenantId, workspaceId, s.bizId, s.ctx.userId, randomUUID()]);
  }
  const mv = (type: string, qty: number, cost: string | null, cur: string | null, at: Date) => adminPool.query(
    `INSERT INTO business_operations.inventory_movements (tenant_id, workspace_id, business_id, inventory_item_id, warehouse_id, movement_type, quantity, unit_cost, unit_cost_currency, occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [tenantId, workspaceId, s.bizId, itemId, warehouseId, type, qty, cost, cur, at]);
  await mv('receipt', 500, '10', 'USD', new Date(Date.now() - 5 * DAY));
  for (let i = 0; i < 12; i += 1) await mv('issue', -75, null, null, new Date(Date.now() - (i + 1) * DAY));
  return { itemId, warehouseId };
}

// ── HTTP helpers ───────────────────────────────────────────────────────────────────────────────────────────────────────

const hdr = (s: { ctx: TenantContext; token: string }, extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${s.token}`, 'x-tenant-id': s.ctx.tenantId, 'x-workspace-id': s.ctx.workspaceId, ...extra,
});
const post = (s: Session, url: string, payload?: unknown) => app.inject({ method: 'POST', url, headers: hdr(s, { 'idempotency-key': uc('key') }), ...(payload === undefined ? {} : { payload: payload as any }) });
const get = (s: Session, url: string) => app.inject({ method: 'GET', url, headers: hdr(s) });
const message = (res: { json(): any }): string => String(res.json().error.message);
const AT = '/v1/aba/action-types'; const POL = '/v1/aba/automation-policies';
const actionBase = (s: Session, actionId: string) => `/v1/businesses/${s.bizId}/authorized-actions/${actionId}`;

/** Registers + activates the canonical type and creates + enables the Level 2 policy covering it (through the real governance routes). */
async function governance(s: Session): Promise<void> {
  expect((await post(s, AT, { code: CODE, schemaVersion: '1' })).statusCode).toBe(201);
  expect((await post(s, `${AT}/${CODE}/1/activate`)).statusCode).toBe(200);
  const code = `l_${uc('p').replace(/[^a-z0-9]/g, '_').toLowerCase()}`;
  expect((await post(s, POL, { policyCode: code, automationLevel: 2, description: 'Level 2 reorder policy', actionTypes: [{ code: CODE, schemaVersion: '1' }] })).statusCode).toBe(201);
  expect((await post(s, `${POL}/${code}/versions/1/enable`, { reason: 'initial Level 2 enablement' })).statusCode).toBe(200);
}
/** The owner holds approver authority and records the decision through the real DecisionWorkflowService route. */
async function decide(s: Session, outcome: 'approve' | 'approve_with_modifications' | 'reject', o: { version?: boolean } = {}): Promise<{ actionId: string; decisionId: string }> {
  const g = await post(s, `/v1/businesses/${s.bizId}/approver-assignments`, { approverUserId: s.ctx.userId, assignmentCode: DEFAULT_APPROVER_ASSIGNMENT_CODE, roleCode: 'business-owner' });
  expect(g.statusCode).toBe(201);
  const { intakePackageId, recommendationId } = await createAbaFixture(s.ctx, s.bizId, APPROVABLE_FACTS);
  const d = await post(s, `/v1/businesses/${s.bizId}/decisions`, { intakePackageId, reviewCode: uc('r'), summary: 'B2d authoring proof', assignmentCode: DEFAULT_APPROVER_ASSIGNMENT_CODE, decisionCode: uc('d'), outcome });
  expect(d.statusCode).toBe(201);
  const decisionId = d.json().id as string;
  const actions = new ApprovedActionRepository();
  const action = await actions.createAction(s.ctx, s.bizId, decisionId, uc('act'), recommendationId);
  if (o.version !== false) await actions.createVersion(s.ctx, action.id, s.bizId, 'B2d fixture');
  return { actionId: action.id, decisionId };
}
/** Step 1-4: governance, the approve_with_modifications decision, and the BO facts. */
async function begin(o: { outcome?: 'approve' | 'approve_with_modifications' | 'reject'; version?: boolean; declare?: boolean } = {}): Promise<Chain> {
  const s = await setup();
  await governance(s);
  const { actionId, decisionId } = await decide(s, o.outcome ?? 'approve_with_modifications', { version: o.version });
  const bo = await seedBo(s, { declare: o.declare });
  return { s, actionId, decisionId, bo, base: actionBase(s, actionId) };
}

const evaluate = (s: Session, bo: Bo, finalParameters: Record<string, number> = FINAL, over: Record<string, unknown> = {}) =>
  post(s, `/v1/businesses/${s.bizId}/inventory-policy-evaluations`, {
    actionType: { code: CODE, schemaVersion: '1' }, target: { kind: 'inventory_item', id: bo.itemId }, finalParameters, ruleSetVersion: RULE_SET, ...over,
  });
const refs = (res: { json(): any }) => res.json().evidence.map((e: any) => ({ dimension: e.dimension, evidenceRef: { kind: e.kind, id: e.id } })) as { dimension: string; evidenceRef: { kind: string; id: string } }[];
const captureBody = (bo: Bo, evaluationEvidence: unknown, o: { after?: Record<string, number>; modified?: boolean } = {}) => {
  const after = o.after ?? FINAL;
  return {
    actionType: { code: CODE, schemaVersion: '1' }, target: { kind: 'inventory_item', id: bo.itemId }, proposedParameters: { ...BASELINE },
    ...(o.modified === false ? {} : {
      modification: { reason: 'Raise the reorder policy.', changes: [
        { parameter: 'reorderPoint', operation: 'SET', before: BASELINE.reorderPoint, after: after.reorderPoint },
        { parameter: 'reorderQuantity', operation: 'SET', before: BASELINE.reorderQuantity, after: after.reorderQuantity }] },
      evaluationEvidence,
    }),
  };
};
const ownerBody = (s: Session, over: Record<string, unknown> = {}) => ({
  ownerUserId: s.ctx.userId, membershipId: s.membershipId, roleCode: 'operations_lead',
  dueAt: { state: 'VALUE', value: hoursFromNow(72).replace(/\.\d+Z$/, 'Z') }, escalationPolicy: { state: 'VALUE', value: { ref: 'policy:default-escalation' } }, ...over,
});
/** Complete governed boundaries. No Simulation run exists anywhere in this scenario: the Simulation state is the governed NOT_APPLICABLE. */
const boundariesBody = (over: Record<string, unknown> = {}) => ({
  executionWindow: { state: 'VALUE', value: { startsAt: hoursFromNow(1), endsAt: hoursFromNow(8) } },
  preconditions: { state: 'VALUE', value: [{ code: 'stock_available', operator: 'gte', operand: 1 }] },
  budget: { state: 'VALUE', value: { amount: '250.00', currency: 'USD' } },
  rollback: { state: 'VALUE', value: { instructions: 'Restore the previous reorder policy.' } },
  monitoring: { state: 'VALUE', value: { metrics: [{ metricCode: 'stockouts', target: 0, unit: 'count' }] } },
  simulationRun: SIMULATION_NA, ...over,
});

// ── inspection ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const count = async (sql: string, params: unknown[]) => Number((await adminPool.query(sql, params)).rows[0].n);
const packages = (s: Session) => count(`SELECT count(*) n FROM approved_business_action.authorized_action_package_versions WHERE business_id=$1`, [s.bizId]);
const captures = (s: Session) => count(`SELECT count(*) n FROM approved_business_action.authorized_action_captures WHERE business_id=$1`, [s.bizId]);
const owners = (s: Session) => count(`SELECT count(*) n FROM approved_business_action.authorized_action_owner_assignments WHERE business_id=$1`, [s.bizId]);
const iso = (col: string) => `to_char(${col} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const decisionFinalAt = async (decisionId: string) => (await adminPool.query(`SELECT ${iso('updated_at')} t FROM approved_business_action.approval_decisions WHERE id=$1`, [decisionId])).rows[0].t as string;
const storedPackage = async (s: Session) => (await adminPool.query(`SELECT package, digest FROM approved_business_action.authorized_action_package_versions WHERE business_id=$1`, [s.bizId])).rows[0] as { package: any; digest: string };
const operationalSnapshot = async (s: Session) => JSON.stringify(await Promise.all([
  'business_operations.inventory_balances', 'platform.inventory_items', 'business_operations.inventory_movements',
].map(async (t) => (await adminPool.query(`SELECT * FROM ${t} WHERE tenant_id = $1 ORDER BY id`, [s.ctx.tenantId])).rows)));
const storedBoundaryBudget = async (s: Session) => (await adminPool.query(`SELECT budget #> '{value}' b FROM approved_business_action.authorized_action_boundaries WHERE business_id=$1 ORDER BY boundary_version DESC LIMIT 1`, [s.bizId])).rows[0].b as { amount: string };
const validatePackage = (pkg: unknown) => validateAuthorizedActionPackage(pkg, { actionTypes: canonicalActionTypeRegistry() });

/** The authoring chain up to (not including) issuance, returning every intermediate fact. */
async function authorThroughBoundaries(c: Chain) {
  const ev = await evaluate(c.s, c.bo);
  expect(ev.statusCode).toBe(201);
  const cap = await post(c.s, `${c.base}/capture`, captureBody(c.bo, refs(ev)));
  expect(cap.statusCode).toBe(201);
  expect((await post(c.s, `${c.base}/owner`, ownerBody(c.s))).statusCode).toBe(201);
  expect((await post(c.s, `${c.base}/boundaries`, boundariesBody())).statusCode).toBe(201);
  return { ev, cap };
}
/** A deviation must stop the chain before a package exists, with nothing sealed. */
const expectNoPackage = async (c: Chain) => { expect(await packages(c.s)).toBe(0); };

/** Rewrites an evaluation row (the evaluator never writes these fields; triggers are suspended inside ONE superuser transaction). */
async function cloneEvaluation(id: string, over: { evaluatedAtSql?: string; ruleSetVersion?: string } = {}): Promise<string> {
  const c = await adminPool.connect();
  try {
    await c.query('BEGIN'); await c.query("SET LOCAL session_replication_role = 'replica'");
    const r = await c.query(
      `INSERT INTO business_operations.inventory_policy_evaluations
         (tenant_id, workspace_id, business_id, inventory_item_id, warehouse_id, dimension, result, subject, subject_digest, rule_set_version, inputs, findings, requested_by_user_id, correlation_id, evaluated_at)
       SELECT tenant_id, workspace_id, business_id, inventory_item_id, warehouse_id, dimension, result, subject, subject_digest, COALESCE($2, rule_set_version), inputs, findings, requested_by_user_id, correlation_id,
              ${over.evaluatedAtSql ?? 'evaluated_at'}
         FROM business_operations.inventory_policy_evaluations WHERE id = $1 RETURNING id`, [id, over.ruleSetVersion ?? null]);
    await c.query('COMMIT');
    return r.rows[0].id as string;
  } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
}

describe.runIf(run)('P0-5 B2d - end-to-end modified-approval authoring proof (real components, real PostgreSQL, pre-execution only)', () => {
  beforeAll(async () => {
    createPool({ connectionString: process.env.DATABASE_URL! });
    adminPool = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
    // The PRODUCTION composition root: the real BoGovernanceEvidenceVerifier is registered by buildApp itself. No override, no fake.
    app = await buildApp(loadConfig({ DATABASE_URL: process.env.DATABASE_URL!, NODE_ENV: 'test', LOG_LEVEL: 'silent', RATE_LIMIT_MAX: '5000' }));
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    if (tenantIds.length > 0) {
      // Teardown only: one superuser transaction suspends the append-only triggers to remove this suite's own evaluation and audit rows.
      const c = await adminPool.connect();
      try {
        await c.query('BEGIN'); await c.query("SET LOCAL session_replication_role = 'replica'");
        await c.query('DELETE FROM audit.audit_events WHERE tenant_id = ANY($1)', [tenantIds]);
        await c.query('DELETE FROM business_operations.inventory_policy_evaluations WHERE tenant_id = ANY($1)', [tenantIds]);
        await c.query('COMMIT');
      } catch { await c.query('ROLLBACK').catch(() => undefined); } finally { c.release(); }
      await deleteMovementsForTenants(adminPool, tenantIds);
    }
    await adminPool?.end(); await closePool();
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  describe('THE PROOF: one chain, every link real, ending at a sealed package', () => {
    it('approve_with_modifications -> BO evaluation -> four PASSED records -> verified capture -> owner -> boundaries -> issued package', async () => {
      const c = await begin();
      const { s } = c;

      // 1. The decision is final and carries the authoritative modification time (approval_decisions.updated_at). No auxiliary modification row exists.
      const decision = (await adminPool.query(`SELECT status FROM approved_business_action.approval_decisions WHERE id=$1`, [c.decisionId])).rows[0];
      expect(decision.status).toBe('approved_with_modifications');
      const modifiedAt = await decisionFinalAt(c.decisionId);
      expect(await count(`SELECT count(*) n FROM approved_business_action.approval_decision_modifications WHERE business_id=$1`, [s.bizId])).toBe(0);
      expect(await captures(s)).toBe(0);
      await new Promise((r) => setTimeout(r, 20));
      const balancesBefore = await operationalSnapshot(s);

      // 2. Business Operations evaluates the modification: four immutable, PASSED records, bound to the exact final-parameter subject.
      const ev = await evaluate(s, c.bo);
      expect(ev.statusCode).toBe(201);
      expect(ev.json().evidence.map((e: any) => e.dimension)).toEqual(DIMENSIONS);
      expect(ev.json().evidence.map((e: any) => e.result)).toEqual(['PASSED', 'PASSED', 'PASSED', 'PASSED']);
      const rows = (await adminPool.query(`SELECT id, dimension, result, rule_set_version, subject_digest, inventory_item_id, business_id, ${iso('evaluated_at')} AS evaluated_at, requested_by_user_id FROM business_operations.inventory_policy_evaluations WHERE tenant_id=$1 ORDER BY dimension`, [s.ctx.tenantId])).rows;
      expect(rows).toHaveLength(4);
      for (const row of rows) expect(row).toMatchObject({ result: 'PASSED', rule_set_version: RULE_SET, subject_digest: ev.json().subjectDigest, inventory_item_id: c.bo.itemId, business_id: s.bizId, requested_by_user_id: s.ctx.userId });

      // 3. ABA captures through the real GovernanceEvidenceVerifier (the BO adapter): all four dimensions must verify.
      const cap = await post(s, `${c.base}/capture`, captureBody(c.bo, refs(ev)));
      expect(cap.statusCode).toBe(201);
      expect(cap.json()).toMatchObject({ decisionStatus: 'approved_with_modifications', finalParameters: FINAL, created: true });
      const capRow = (await adminPool.query(`SELECT id, final_parameters, proposed, modification, modification_evaluation, ${iso('captured_at')} AS captured_at FROM approved_business_action.authorized_action_captures WHERE business_id=$1`, [s.bizId])).rows[0];
      expect(capRow.final_parameters).toEqual(FINAL);                                    // the executable parameter set lives here, nowhere else
      expect(capRow.modification.value.modifiedAt).toBe(modifiedAt);                      // the decision time, not the capture time
      const stored = capRow.modification_evaluation.value.evidence as any[];
      expect(stored.map((e) => e.dimension).sort()).toEqual([...DIMENSIONS].sort());
      for (const e of stored) {
        expect(e).toMatchObject({ result: 'PASSED', evidenceRef: { kind: 'bo_inventory_policy_evaluation' } });
        expect(rows.find((r) => r.id === e.evidenceRef.id)).toBeDefined();               // each stored reference IS one of the four BO records
        expect(e.evaluatedAt).toBe(rows.find((r) => r.id === e.evidenceRef.id)!.evaluated_at); // the verifier's answer, not a caller value
      }

      // 4. Owner (canonical Identity/Tenancy: an active membership), then governed boundaries with the governed Simulation exemption.
      const owner = await post(s, `${c.base}/owner`, ownerBody(s));
      expect(owner.statusCode).toBe(201);
      const bounds = await post(s, `${c.base}/boundaries`, boundariesBody());
      expect(bounds.statusCode).toBe(201);
      expect((await get(s, `${c.base}/authoring-status`)).json().missing).toEqual([]);

      // 5. The issuer takes IDENTIFIERS ONLY and loads everything else from persisted authority.
      const issued = await post(s, `${c.base}/package`);
      expect(issued.statusCode).toBe(201);
      expect(issued.json()).toMatchObject({ outcome: 'ISSUED', status: 'ISSUED', automationLevel: 2, actionType: { code: CODE, schemaVersion: '1' } });
      const { package: pkg, digest } = await storedPackage(s);

      // 6. The sealed package validates under aap/1 (structure, semantics, integrity digest) with the canonical registry.
      expect(validatePackage(pkg)).toEqual({ valid: true, errors: [] });
      expect(pkg.integrity.digest).toBe(digest);
      expect(issued.json().digest).toBe(digest);
      expect(pkg).toMatchObject({
        contractVersion: 'aap/1',
        scope: { tenantId: s.ctx.tenantId, workspaceId: s.ctx.workspaceId, businessId: s.bizId },
        action: { type: { code: CODE, schemaVersion: '1' }, target: { kind: 'inventory_item', id: c.bo.itemId }, parameters: FINAL, automationLevel: { level: 2 } },
        authorization: { decisionStatus: 'approved_with_modifications' },
        consumption: { mode: 'SINGLE_USE' },
      });
      expect(pkg.action.parameters).toEqual(capRow.final_parameters);                   // finalParameters sourced from the capture
      expect(pkg.lineage.proposedParameters.value.parameters).toEqual(BASELINE);
      expect(pkg.lineage.modification.value).toMatchObject({ modifiedAt, modifiedByUserId: s.ctx.userId });
      expect(pkg.lineage.modificationEvaluation.value.evidence).toEqual(capRow.modification_evaluation.value.evidence); // evidence lineage
      expect(pkg.lineage.simulationRunId).toEqual(SIMULATION_NA);                         // governed NOT_APPLICABLE, exact reason
      expect(pkg.accountableOwner).toMatchObject({ identity: { userId: s.ctx.userId, membershipId: s.membershipId }, roleCode: 'operations_lead', assignment: { assignedByUserId: s.ctx.userId } });
      expect(pkg.action.executionWindow.state).toBe('VALUE');
      expect(pkg.action.budget.state).toBe('VALUE'); expect(pkg.action.rollback.state).toBe('VALUE'); expect(pkg.action.monitoring.state).toBe('VALUE'); expect(pkg.action.preconditions.state).toBe('VALUE');
      expect(pkg.validity.expiresAt.state).toBe('VALUE');                                 // validity is bounded (window / owner due date)

      // 7. Chronology: decision final time <= every evaluation <= capture <= issuance.
      const evaluatedAts = rows.map((r) => Date.parse(r.evaluated_at));
      expect(Date.parse(modifiedAt)).toBeLessThanOrEqual(Math.min(...evaluatedAts));
      expect(Math.max(...evaluatedAts)).toBeLessThanOrEqual(Date.parse(capRow.captured_at));
      expect(Date.parse(capRow.captured_at)).toBeLessThanOrEqual(Date.parse(pkg.issuance.issuedAt));
      expect(Date.parse(modifiedAt)).toBeLessThan(Date.parse(pkg.issuance.issuedAt));

      // 8. Replay with identical authoritative state: same package, same digest, no second version.
      const again = await post(s, `${c.base}/package`);
      expect(again.json()).toMatchObject({ outcome: 'REPLAYED', packageId: issued.json().packageId, digest });
      expect(await packages(s)).toBe(1);

      // 9. The boundary: the chain stops at the sealed package. Nothing executed, nothing mutated, nothing handed to BO.
      expect(await operationalSnapshot(s)).toBe(balancesBefore);
      const bal = (await adminPool.query(`SELECT reorder_point::float rp, reorder_quantity::float rq FROM business_operations.inventory_balances WHERE inventory_item_id=$1`, [c.bo.itemId])).rows[0];
      expect(bal).toEqual({ rp: BASELINE.reorderPoint, rq: BASELINE.reorderQuantity });  // the policy is NOT changed
      expect(await count(`SELECT count(*) n FROM business_operations.authorized_action_receipts WHERE tenant_id=$1`, [s.ctx.tenantId])).toBe(0);
      expect(await count(`SELECT count(*) n FROM approved_business_action.authorized_action_package_lifecycle_events WHERE business_id=$1 AND event_type IN ('CONSUMED','EXECUTED')`, [s.bizId]).catch(() => 0)).toBe(0);
      expect(pkg.consumption).toEqual({ mode: 'SINGLE_USE' });
      expect(PRODUCTION_SUPPORTED_ACTION_TYPES).toEqual([]);                              // no executable action type is registered
      expect(PRODUCTION_BO_CAPABILITIES.supports(CODE, '1')).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  describe('package integrity (the digest is tamper evidence, never authorization)', () => {
    it('is deterministic and any tampering is detected', async () => {
      const c = await begin();
      await authorThroughBoundaries(c);
      expect((await post(c.s, `${c.base}/package`)).statusCode).toBe(201);
      const { package: pkg } = await storedPackage(c.s);
      expect(validatePackage(pkg).valid).toBe(true);

      // canonicalization is deterministic: key order is irrelevant
      const shuffle = (v: any): any => (Array.isArray(v) ? v.map(shuffle) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, shuffle(x)])) : v);
      expect(canonicalize(shuffle(pkg))).toBe(canonicalize(pkg));
      expect(validatePackage(shuffle(pkg)).valid).toBe(true);

      const tamper = (mutate: (p: any) => void) => { const copy = JSON.parse(JSON.stringify(pkg)); mutate(copy); return validatePackage(copy); };
      const cases: [string, (p: any) => void][] = [
        ['final parameters', (p) => { p.action.parameters.reorderPoint = 999; }],
        ['target', (p) => { p.action.target.id = randomUUID(); }],
        ['owner', (p) => { p.accountableOwner.identity.userId = randomUUID(); }],
        ['boundaries (budget)', (p) => { p.action.budget.value.amount = '999999.00'; }],
        ['boundaries (window)', (p) => { p.action.executionWindow.value.endsAt = '2099-01-01T00:00:00.000Z'; }],
        ['Simulation reason', (p) => { p.lineage.simulationRunId.reason.code = 'SOMETHING_ELSE'; }],
        ['Simulation state', (p) => { p.lineage.simulationRunId = { state: 'VALUE', value: randomUUID() }; }],
        ['evidence lineage', (p) => { p.lineage.modificationEvaluation.value.evidence[0].evidenceRef.id = randomUUID(); }],
        ['scope', (p) => { p.scope.businessId = randomUUID(); }],
      ];
      const codes = new Map<string, string[]>();
      for (const [name, mutate] of cases) {
        const r = tamper(mutate);
        expect(r.valid, name).toBe(false);
        expect(r.errors.length, name).toBeGreaterThan(0);
        // content that stays semantically valid is caught by the integrity digest; content the contract rejects outright is caught first
        codes.set(name, r.errors.map((e: any) => e.code));
      }
      for (const name of ['target', 'owner', 'boundaries (budget)', 'scope']) expect(codes.get(name), name).toContain('DIGEST_MISMATCH');
      // a forged digest over tampered content cannot be produced by editing alone; a swapped digest on untouched content is also invalid
      const swapped = JSON.parse(JSON.stringify(pkg)); swapped.integrity.digest = `sha256:${'0'.repeat(64)}`;
      expect(validatePackage(swapped).errors.map((e: any) => e.code)).toContain('DIGEST_MISMATCH');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  describe('Simulation: governed NOT_APPLICABLE for exactly this action type', () => {
    it('absence alone is not NOT_APPLICABLE, the reason must be exact, and no Simulation run is required', async () => {
      const c = await begin();
      const ev = await evaluate(c.s, c.bo);
      expect((await post(c.s, `${c.base}/capture`, captureBody(c.bo, refs(ev)))).statusCode).toBe(201);
      expect((await post(c.s, `${c.base}/owner`, ownerBody(c.s))).statusCode).toBe(201);
      const absent: any = boundariesBody(); delete absent.simulationRun;
      expect((await post(c.s, `${c.base}/boundaries`, absent)).statusCode).toBe(400);
      for (const code of ['NOT_SIMULATION_BACKED', 'NO_APPLICABLE_SIMULATION_MODE', 'no_applicable_simulation_model', 'OTHER']) {
        const res = await post(c.s, `${c.base}/boundaries`, boundariesBody({ simulationRun: { state: 'NOT_APPLICABLE', reason: { code, statement: 'x' } } }));
        expect(res.statusCode, code).toBe(400);
        if (code !== 'no_applicable_simulation_model') expect(message(res), code).toContain(SIMULATION_NOT_APPLICABLE_REASON_CODE); // lowercase is refused earlier as a malformed code (never normalized)
      }
      expect(await count(`SELECT count(*) n FROM approved_business_action.authorized_action_boundaries WHERE business_id=$1`, [c.s.bizId])).toBe(0);
      // the issuer cannot proceed without boundaries
      const blocked = await post(c.s, `${c.base}/package`);
      expect(blocked.statusCode).toBe(409); expect(message(blocked)).toContain('BOUNDARIES_MISSING');
      // the exact governed state is accepted; there is no Simulation run anywhere in this scenario
      expect((await post(c.s, `${c.base}/boundaries`, boundariesBody())).statusCode).toBe(201);
      expect((await post(c.s, `${c.base}/package`)).statusCode).toBe(201);
      // no Simulation run is referenced by the boundaries or the package (an upstream ADI fixture run exists but is NOT required or used)
      const stored = (await adminPool.query(`SELECT simulation_run FROM approved_business_action.authorized_action_boundaries WHERE business_id=$1`, [c.s.bizId])).rows[0].simulation_run;
      expect(stored).toEqual(SIMULATION_NA);
      expect((await storedPackage(c.s)).package.lineage.simulationRunId).toEqual(SIMULATION_NA);
    });

    it('no other action type inherits the exemption (the contract is per code@schemaVersion)', () => {
      const ok = { code: SIMULATION_NOT_APPLICABLE_REASON_CODE };
      expect([...SIMULATION_NOT_APPLICABLE_ALLOWED]).toEqual([`${INVENTORY_REORDER_POLICY_UPDATE_V1.code}@${INVENTORY_REORDER_POLICY_UPDATE_V1.schemaVersion}`]);
      expect(simulationNotApplicableProblem(SIMULATION_NOT_APPLICABLE_ALLOWED, CODE, '1', ok)).toBeNull();
      for (const [code, version] of [['inventory_adjustment', '1'], [CODE, '2'], ['purchase_order_release', '1']]) {
        expect(simulationNotApplicableProblem(SIMULATION_NOT_APPLICABLE_ALLOWED, code, version, ok), `${code}@${version}`).toMatch(/requires a simulation run reference/);
      }
      // the platform registry contains exactly one canonical type, so there is nothing else that could be authored
      const registry = canonicalActionTypeRegistry();
      expect(registry.supports(CODE, '1')).toBe(true);
      expect(registry.supports('inventory_adjustment', '1')).toBe(false);
      expect(registry.supports(CODE, '2')).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  describe('negative end to end: every deviation fails closed before a package exists', () => {
    it('the approval is not approved_with_modifications', async () => {
      const plain = await begin({ outcome: 'approve' });
      const ev = await evaluate(plain.s, plain.bo);
      const res = await post(plain.s, `${plain.base}/capture`, captureBody(plain.bo, refs(ev)));
      expect(res.statusCode).toBe(400);
      expect(message(res)).toMatch(/plain approval carries no modification|no modification/);
      expect(await captures(plain.s)).toBe(0); await expectNoPackage(plain);

      const rejected = await begin({ outcome: 'reject' });
      const ev2 = await evaluate(rejected.s, rejected.bo);
      const res2 = await post(rejected.s, `${rejected.base}/capture`, captureBody(rejected.bo, refs(ev2)));
      expect(res2.statusCode).toBe(409);
      expect(await captures(rejected.s)).toBe(0); await expectNoPackage(rejected);
    });

    it('no BO evaluation exists, or one required dimension is missing', async () => {
      const c = await begin();
      const none = await post(c.s, `${c.base}/capture`, captureBody(c.bo, []));
      expect(none.statusCode).toBe(400); expect(message(none)).toMatch(/evaluation evidence is required for/);
      const ev = await evaluate(c.s, c.bo);
      for (const dropped of DIMENSIONS) {
        const res = await post(c.s, `${c.base}/capture`, captureBody(c.bo, refs(ev).filter((e) => e.dimension !== dropped)));
        expect(res.statusCode, dropped).toBe(400);
        expect(message(res), dropped).toContain(dropped);
      }
      expect(await captures(c.s)).toBe(0);
      const issue = await post(c.s, `${c.base}/package`);
      expect(issue.statusCode).toBe(409); expect(message(issue)).toContain('CAPTURE_MISSING');
      await expectNoPackage(c);
    });

    it('one dimension is FAILED, or INDETERMINATE', async () => {
      const failed = await begin();
      const evF = await evaluate(failed.s, failed.bo, { reorderPoint: 400, reorderQuantity: 600 });
      const rF = await post(failed.s, `${failed.base}/capture`, captureBody(failed.bo, refs(evF), { after: { reorderPoint: 400, reorderQuantity: 600 } }));
      expect(rF.statusCode).toBe(409); expect(message(rF)).toMatch(/result is FAILED/);
      expect(await captures(failed.s)).toBe(0); await expectNoPackage(failed);

      const indeterminate = await begin({ declare: false }); // no declared currency -> COST is INDETERMINATE while the others PASS
      const evI = await evaluate(indeterminate.s, indeterminate.bo);
      expect(Object.fromEntries(evI.json().evidence.map((e: any) => [e.dimension, e.result]))).toMatchObject({ CONSTRAINTS: 'PASSED', COST: 'INDETERMINATE' });
      const rI = await post(indeterminate.s, `${indeterminate.base}/capture`, captureBody(indeterminate.bo, refs(evI)));
      expect(rI.statusCode).toBe(409); expect(message(rI)).toMatch(/COST evidence was not verified: .*INDETERMINATE/);
      expect(await captures(indeterminate.s)).toBe(0); await expectNoPackage(indeterminate);
    });

    it('the evidence belongs to another business, another target, or other final parameters', async () => {
      const c = await begin();
      // another business (another tenant)
      const stranger = await setup(); const sbo = await seedBo(stranger);
      const foreign = await evaluate(stranger, sbo);
      const r1 = await post(c.s, `${c.base}/capture`, captureBody(c.bo, refs(foreign)));
      expect(r1.statusCode).toBe(409); expect(message(r1)).toMatch(/no such evaluation record/);
      // another business in the SAME tenant and workspace (not merely another tenant)
      const sibling = randomUUID();
      await adminPool.query(`INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,'ZZ Sibling',$4,'active')`, [sibling, c.s.ctx.tenantId, c.s.ctx.workspaceId, uc('b2d-sib')]);
      const siblingSession: Session = { ...c.s, bizId: sibling };
      const siblingBo = await seedBo(siblingSession);
      const evSibling = await evaluate(siblingSession, siblingBo);
      expect(evSibling.statusCode).toBe(201);
      const rSibling = await post(c.s, `${c.base}/capture`, captureBody(c.bo, refs(evSibling)));
      expect(rSibling.statusCode).toBe(409); expect(message(rSibling)).toMatch(/no such evaluation record/);
      // another target in the SAME business
      const other = await seedBo(c.s, { declare: false });
      const evOther = await evaluate(c.s, other);
      expect(evOther.statusCode).toBe(201);
      const r2 = await post(c.s, `${c.base}/capture`, captureBody(c.bo, refs(evOther)));
      expect(r2.statusCode).toBe(409); expect(message(r2)).toMatch(/different inventory item|digest mismatch/);
      // other final parameters
      const evParams = await evaluate(c.s, c.bo, { reorderPoint: 175, reorderQuantity: 200 });
      const r3 = await post(c.s, `${c.base}/capture`, captureBody(c.bo, refs(evParams)));
      expect(r3.statusCode).toBe(409); expect(message(r3)).toMatch(/subject digest mismatch/);
      expect(await captures(c.s)).toBe(0); await expectNoPackage(c);
    });

    it('the evidence predates the modified decision', async () => {
      const s = await setup(); await governance(s);
      const bo = await seedBo(s);
      const early = await evaluate(s, bo);                 // evaluated BEFORE the decision becomes final
      expect(early.statusCode).toBe(201);
      await new Promise((r) => setTimeout(r, 20));
      const { actionId } = await decide(s, 'approve_with_modifications');
      const res = await post(s, `${actionBase(s, actionId)}/capture`, captureBody(bo, refs(early)));
      expect(res.statusCode).toBe(409); expect(message(res)).toMatch(/predates the modification decision/);
      expect(await captures(s)).toBe(0); expect(await packages(s)).toBe(0);
    });

    it('the evidence is stale (older than 24 hours) even though it postdates the decision, or references an unsupported rule-set version', async () => {
      const c = await begin();
      // Fixture: the decision became final three days ago, so a 25-hour-old evaluation is AFTER the decision and ONLY the freshness rule can refuse it.
      const fx = await adminPool.connect();
      try {
        await fx.query('BEGIN'); await fx.query("SET LOCAL session_replication_role = 'replica'");
        await fx.query(`UPDATE approved_business_action.approval_decisions SET updated_at = now() - interval '3 days' WHERE id = $1`, [c.decisionId]);
        await fx.query('COMMIT');
      } catch (e) { await fx.query('ROLLBACK').catch(() => undefined); throw e; } finally { fx.release(); }
      const ev = await evaluate(c.s, c.bo);
      const good = refs(ev);
      const costId = good.find((e) => e.dimension === 'COST')!.evidenceRef.id;
      const swap = (id: string) => good.map((e) => (e.dimension === 'COST' ? { ...e, evidenceRef: { kind: e.evidenceRef.kind, id } } : e));
      const stale = await cloneEvaluation(costId, { evaluatedAtSql: "date_trunc('milliseconds', clock_timestamp()) - interval '25 hours'" });
      const r1 = await post(c.s, `${c.base}/capture`, captureBody(c.bo, swap(stale)));
      expect(r1.statusCode).toBe(409); expect(message(r1)).toMatch(/COST evidence was not verified: .*older than the maximum evidence age/);
      const bad = await cloneEvaluation(costId, { ruleSetVersion: 'inventory-reorder-policy/v9.9.9' });
      const r2 = await post(c.s, `${c.base}/capture`, captureBody(c.bo, swap(bad)));
      expect(r2.statusCode).toBe(409); expect(message(r2)).toMatch(/not approved and effective/);
      expect(await captures(c.s)).toBe(0); await expectNoPackage(c);
    });

    it('the owner is missing, or the owner scope is invalid', async () => {
      const c = await begin();
      const ev = await evaluate(c.s, c.bo);
      expect((await post(c.s, `${c.base}/capture`, captureBody(c.bo, refs(ev)))).statusCode).toBe(201);
      expect((await post(c.s, `${c.base}/boundaries`, boundariesBody())).statusCode).toBe(201);
      const missing = await post(c.s, `${c.base}/package`);
      expect(missing.statusCode).toBe(409); expect(message(missing)).toContain('OWNER_MISSING');
      // a user/membership of ANOTHER tenant is not an owner here
      const outsider = await setup();
      for (const body of [ownerBody(c.s, { ownerUserId: outsider.ctx.userId, membershipId: outsider.membershipId }), ownerBody(c.s, { membershipId: outsider.membershipId }), ownerBody(c.s, { ownerUserId: randomUUID() })]) {
        const res = await post(c.s, `${c.base}/owner`, body);
        expect(res.statusCode).toBeGreaterThanOrEqual(400);
      }
      expect(await owners(c.s)).toBe(0); await expectNoPackage(c);
    });

    it('a required boundary is missing, or the exemption is attempted on another field', async () => {
      const c = await begin();
      const ev = await evaluate(c.s, c.bo);
      expect((await post(c.s, `${c.base}/capture`, captureBody(c.bo, refs(ev)))).statusCode).toBe(201);
      expect((await post(c.s, `${c.base}/owner`, ownerBody(c.s))).statusCode).toBe(201);
      for (const field of ['executionWindow', 'preconditions', 'budget', 'rollback', 'monitoring']) {
        const missing: any = boundariesBody(); delete missing[field];
        expect((await post(c.s, `${c.base}/boundaries`, missing)).statusCode, `missing ${field}`).toBe(400);
        const na = await post(c.s, `${c.base}/boundaries`, boundariesBody({ [field]: { state: 'NOT_APPLICABLE', reason: { code: 'NOT_NEEDED', statement: 'n/a' } } }));
        expect(na.statusCode, `NA ${field}`).toBe(400);
        expect(message(na), `NA ${field}`).toContain('NOT_APPLICABLE is not permitted'); // the authoring gate, ahead of the database backstop
      }
      const blocked = await post(c.s, `${c.base}/package`);
      expect(blocked.statusCode).toBe(409); expect(message(blocked)).toContain('BOUNDARIES_MISSING');
      await expectNoPackage(c);
    });

    it('only the decision\'s own, still-active approver can author the chain: another authorized member cannot capture or author boundaries', async () => {
      const c = await begin();
      const ev = await evaluate(c.s, c.bo);
      const { userId, token } = await registerActiveUser();
      const colleague: Session = { ctx: { ...c.s.ctx, userId }, token, bizId: c.s.bizId, membershipId: await grantOwner({ ...c.s.ctx, userId }, userId) };
      const res = await post(colleague, `${c.base}/capture`, captureBody(c.bo, refs(ev)));
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(await captures(c.s)).toBe(0);
      await authorThroughBoundaries(c);
      const bounds = await post(colleague, `${c.base}/boundaries`, boundariesBody({ budget: { state: 'VALUE', value: { amount: '1.00', currency: 'USD' } } }));
      expect(bounds.statusCode).toBeGreaterThanOrEqual(400);
      expect((await storedBoundaryBudget(c.s)).amount).toBe('250.00'); // the approver's boundaries stand
      await expectNoPackage(c);
    });

    it('the issuer accepts identifiers only: a caller-supplied body is refused and the package is built from persisted authority', async () => {
      const c = await begin();
      await authorThroughBoundaries(c);
      for (const body of [{ finalParameters: { reorderPoint: 999, reorderQuantity: 999 } }, { package: {} }, { owner: { userId: randomUUID() } }, { simulationRun: SIMULATION_NA }]) {
        expect((await post(c.s, `${c.base}/package`, body)).statusCode).toBe(400);
      }
      expect(await packages(c.s)).toBe(0);
      expect((await post(c.s, `${c.base}/package`)).statusCode).toBe(201);
      expect((await storedPackage(c.s)).package.action.parameters).toEqual(FINAL);
    });

    it('issuance would need to fabricate a missing fact (the action has no version)', async () => {
      const c = await begin({ version: false });
      const ev = await evaluate(c.s, c.bo);
      const cap = await post(c.s, `${c.base}/capture`, captureBody(c.bo, refs(ev)));
      expect(cap.statusCode).toBe(201);
      expect((await post(c.s, `${c.base}/owner`, ownerBody(c.s))).statusCode).toBe(201);
      expect((await post(c.s, `${c.base}/boundaries`, boundariesBody())).statusCode).toBe(201);
      const res = await post(c.s, `${c.base}/package`);
      expect(res.statusCode).toBe(409); expect(message(res)).toContain('ACTION_VERSION_MISSING');
      await expectNoPackage(c);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  describe('authority is revalidated AT ISSUANCE (execution-time checks belong to P0-6)', () => {
    it('authority valid at decision time is not enough: revoked before issuance blocks the package, the historic approval stays intact', async () => {
      const c = await begin();
      await authorThroughBoundaries(c);
      const decisionBefore = (await adminPool.query(`SELECT status, ${iso('updated_at')} u FROM approved_business_action.approval_decisions WHERE id=$1`, [c.decisionId])).rows[0];
      const capBefore = await captures(c.s);
      const revoke = await post(c.s, `/v1/businesses/${c.s.bizId}/approver-assignments/${DEFAULT_APPROVER_ASSIGNMENT_CODE}/revoke`, { reason: 'authority withdrawn before issuance' });
      expect(revoke.statusCode).toBe(200);
      const res = await post(c.s, `${c.base}/package`);
      expect(res.statusCode).toBe(409);
      expect(message(res)).toMatch(/AUTHORITY_REVOKED|AUTHORITY_NOT_ESTABLISHED/);
      await expectNoPackage(c);
      // the historic approval, its decision time and the capture are untouched
      const decisionAfter = (await adminPool.query(`SELECT status, ${iso('updated_at')} u FROM approved_business_action.approval_decisions WHERE id=$1`, [c.decisionId])).rows[0];
      expect(decisionAfter).toEqual(decisionBefore);
      expect(await captures(c.s)).toBe(capBefore);
      // the refusal is itself audited with the approval audit trail
      expect(await count(`SELECT count(*) n FROM approved_business_action.approval_audit_events WHERE decision_id=$1 AND event_type='package.issuance_refused'`, [c.decisionId])).toBeGreaterThanOrEqual(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  describe('audit: each governance mutation of the chain leaves its record (existing conventions, no second store)', () => {
    it('evaluation, capture, owner, boundaries and issuance are all audited with actor, permission, scope and correlation', async () => {
      const c = await begin();
      await authorThroughBoundaries(c);
      const issued = await post(c.s, `${c.base}/package`);
      expect(issued.statusCode).toBe(201);
      const rows = (await adminPool.query(`SELECT action, entity_type, actor_id, business_id, workspace_id, metadata, correlation_id FROM audit.audit_events WHERE tenant_id=$1 AND (action LIKE 'aba.%' OR action LIKE 'bo.%') ORDER BY occurred_at, id`, [c.s.ctx.tenantId])).rows;
      const byAction = (a: string) => rows.filter((r) => r.action === a);
      for (const action of ['bo.inventory_policy_evaluation.requested', 'aba.capture.recorded', 'aba.owner.assigned', 'aba.boundaries.authored']) {
        const found = byAction(action);
        expect(found, action).toHaveLength(1);
        expect(found[0], action).toMatchObject({ actor_id: c.s.ctx.userId, business_id: c.s.bizId, workspace_id: c.s.ctx.workspaceId });
        expect(typeof found[0].metadata.permissionUsed, action).toBe('string');
        expect(found[0].correlation_id, action).toMatch(/^[0-9a-f-]{36}$/);
      }
      expect(byAction('bo.inventory_policy_evaluation.requested')[0].metadata.permissionUsed).toBe('bo:write');
      expect(byAction('aba.capture.recorded')[0].metadata.permissionUsed).toBe('aba:write');
      // issuance is audited in the approval audit trail, atomically with the package (existing convention)
      expect(await count(`SELECT count(*) n FROM approved_business_action.approval_audit_events WHERE decision_id=$1 AND event_type='package.issued'`, [c.decisionId])).toBe(1);
      // audit is append-only: the rows cannot be rewritten
      await expect(adminPool.query(`UPDATE audit.audit_events SET action='x' WHERE tenant_id=$1`, [c.s.ctx.tenantId])).rejects.toThrow(/append-only|forbid|not permitted|immutable/i);
    });
  });
});
