/**
 * Test kit (P0-6f): builds an AuthorizedActionPackage through ABA's REAL authoring and issuance path over HTTP - governance, approver
 * authority, the approve_with_modifications decision, BO evaluation evidence verified by the real GovernanceEvidenceVerifier, capture, owner,
 * governed boundaries, issuance. Nothing is injected into Business Operations: no BO row except the inventory facts the evaluator reads
 * (item, balance, movements, declared currency) is written by this kit. Same pattern as the B2d proof; kept here so that proof stays untouched.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- HTTP payloads are arbitrary JSON */
import { expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { UserRepository, MembershipRepository, ApprovedActionRepository, type TenantContext } from '@infinicus/database';
import { DEFAULT_APPROVER_ASSIGNMENT_CODE } from '@infinicus/workflow';
import { createAbaFixture, APPROVABLE_FACTS, uc } from './abaFixtures.js';

export const CODE = 'inventory_reorder_policy_update';
export const ACTION = { code: CODE, schemaVersion: '1' };
const RULE_SET = 'inventory-reorder-policy/v1.0.0';
const DAY = 86_400_000;
export const BASELINE = { reorderPoint: 170, reorderQuantity: 190 };
export const FINAL = { reorderPoint: 180, reorderQuantity: 200 };
const STRONG_PASSWORD = 'Correct-Horse-9!';
const hoursFromNow = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString();
const SIMULATION_NA = { state: 'NOT_APPLICABLE', reason: { code: 'NO_APPLICABLE_SIMULATION_MODEL', statement: 'No Simulation model evaluates inventory reorder policy.' } };

export interface Session { ctx: TenantContext; token: string; bizId: string; membershipId: string }
export interface Chain { s: Session; actionId: string; decisionId: string; itemId: string; warehouseId: string; balanceId: string; base: string }

export function chainKit(env: { app: FastifyInstance; admin: Pool; tenantIds: string[] }) {
  const { app, admin, tenantIds } = env;

  const hdr = (s: { ctx: TenantContext; token: string }, extra: Record<string, string> = {}) => ({
    authorization: `Bearer ${s.token}`, 'x-tenant-id': s.ctx.tenantId, 'x-workspace-id': s.ctx.workspaceId, ...extra,
  });
  const post = (s: Session, url: string, payload?: unknown, key: string = uc('key')) => app.inject({ method: 'POST', url, headers: hdr(s, { 'idempotency-key': key }), ...(payload === undefined ? {} : { payload: payload as any }) });
  const put = (s: Session, url: string, payload: unknown, key: string = uc('key')) => app.inject({ method: 'PUT', url, headers: hdr(s, { 'idempotency-key': key }), payload: payload as any });
  const get = (s: Session, url: string) => app.inject({ method: 'GET', url, headers: hdr(s) });

  async function registerActiveUser(): Promise<{ userId: string; token: string }> {
    const email = `${uc('p6f')}@p6f.example`;
    const reg = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, password: STRONG_PASSWORD } });
    expect(reg.statusCode).toBe(201);
    const userId = reg.json().id as string;
    await new UserRepository().activate(userId);
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: STRONG_PASSWORD } });
    return { userId, token: login.json().rawSessionToken as string };
  }

  /** A fresh tenant + workspace + business and an OWNER user (an active membership holding the owner role, which holds bo:admin). */
  async function setup(): Promise<Session> {
    const { userId, token } = await registerActiveUser();
    const tenantId = randomUUID(); const workspaceId = randomUUID(); const sfx = uc('s');
    tenantIds.push(tenantId);
    await admin.query(`INSERT INTO tenancy.tenants (id, name, slug, status, plan_code) VALUES ($1,'P6f Tenant',$2,'active','test')`, [tenantId, `p6f-${sfx}`]);
    await admin.query(`INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,'P6f WS',$3,'active')`, [workspaceId, tenantId, `p6f-ws-${sfx}`]);
    const ctx: TenantContext = { tenantId, workspaceId, userId };
    const memberships = new MembershipRepository();
    const m = await memberships.create(ctx, userId);
    await memberships.activate(ctx, m.id);
    const roleId = (await admin.query(`SELECT id FROM tenancy.roles WHERE tenant_id IS NULL AND code = 'owner'`)).rows[0].id;
    await memberships.assignRole(ctx, m.id, roleId);
    const bizId = randomUUID();
    await admin.query(`INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,'ZZ P6f Biz',$4,'active')`, [bizId, tenantId, workspaceId, uc('p6f-biz')]);
    return { ctx, token, bizId, membershipId: m.id };
  }

  /** Authoritative BO facts the evaluator reads: item, balance 170/190 (stock available), USD declared, a USD receipt and 12 issues. */
  async function seedBo(s: Session): Promise<{ itemId: string; warehouseId: string; balanceId: string }> {
    const itemId = randomUUID(); const warehouseId = randomUUID(); const { tenantId, workspaceId } = s.ctx;
    await admin.query(`INSERT INTO platform.inventory_items (id, tenant_id, workspace_id, business_id, sku, name) VALUES ($1,$2,$3,$4,$5,'Item')`, [itemId, tenantId, workspaceId, s.bizId, `sku-${itemId}`]);
    await admin.query(`INSERT INTO platform.warehouses (id, tenant_id, workspace_id, business_id, warehouse_code, name) VALUES ($1,$2,$3,$4,$5,'WH')`, [warehouseId, tenantId, workspaceId, s.bizId, `wh-${warehouseId}`]);
    const balanceId = (await admin.query(
      `INSERT INTO business_operations.inventory_balances (tenant_id, workspace_id, business_id, inventory_item_id, warehouse_id, quantity_on_hand, reorder_point, reorder_quantity) VALUES ($1,$2,$3,$4,$5,100,$6,$7) RETURNING id`,
      [tenantId, workspaceId, s.bizId, itemId, warehouseId, BASELINE.reorderPoint, BASELINE.reorderQuantity])).rows[0].id as string;
    await admin.query(`INSERT INTO platform.business_currency_declarations (tenant_id, workspace_id, business_id, version, declared_currency, provenance, declared_by_user_id, permission_used, correlation_id) VALUES ($1,$2,$3,1,'USD','EXPLICIT_DECLARATION',$4,'platform:admin',$5)`,
      [tenantId, workspaceId, s.bizId, s.ctx.userId, randomUUID()]);
    const mv = (type: string, qty: number, cost: string | null, cur: string | null, at: Date) => admin.query(
      `INSERT INTO business_operations.inventory_movements (tenant_id, workspace_id, business_id, inventory_item_id, warehouse_id, movement_type, quantity, unit_cost, unit_cost_currency, occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [tenantId, workspaceId, s.bizId, itemId, warehouseId, type, qty, cost, cur, at]);
    await mv('receipt', 500, '10', 'USD', new Date(Date.now() - 5 * DAY));
    for (let i = 0; i < 12; i += 1) await mv('issue', -75, null, null, new Date(Date.now() - (i + 1) * DAY));
    return { itemId, warehouseId, balanceId };
  }

  const AT = '/v1/aba/action-types'; const POL = '/v1/aba/automation-policies';
  async function governance(s: Session): Promise<void> {
    expect((await post(s, AT, { code: CODE, schemaVersion: '1' })).statusCode).toBe(201);
    expect((await post(s, `${AT}/${CODE}/1/activate`)).statusCode).toBe(200);
    const code = `l_${uc('p').replace(/[^a-z0-9]/g, '_').toLowerCase()}`;
    expect((await post(s, POL, { policyCode: code, automationLevel: 2, description: 'Level 2 reorder policy', actionTypes: [{ code: CODE, schemaVersion: '1' }] })).statusCode).toBe(201);
    expect((await post(s, `${POL}/${code}/versions/1/enable`, { reason: 'initial Level 2 enablement' })).statusCode).toBe(200);
  }

  async function decide(s: Session): Promise<{ actionId: string; decisionId: string }> {
    const g = await post(s, `/v1/businesses/${s.bizId}/approver-assignments`, { approverUserId: s.ctx.userId, assignmentCode: DEFAULT_APPROVER_ASSIGNMENT_CODE, roleCode: 'business-owner' });
    expect(g.statusCode).toBe(201);
    const { intakePackageId, recommendationId } = await createAbaFixture(s.ctx, s.bizId, APPROVABLE_FACTS);
    const d = await post(s, `/v1/businesses/${s.bizId}/decisions`, { intakePackageId, reviewCode: uc('r'), summary: 'P0-6f execution path', assignmentCode: DEFAULT_APPROVER_ASSIGNMENT_CODE, decisionCode: uc('d'), outcome: 'approve_with_modifications' });
    expect(d.statusCode).toBe(201);
    const decisionId = d.json().id as string;
    const actions = new ApprovedActionRepository();
    const action = await actions.createAction(s.ctx, s.bizId, decisionId, uc('act'), recommendationId);
    await actions.createVersion(s.ctx, action.id, s.bizId, 'P0-6f');
    return { actionId: action.id, decisionId };
  }

  const refs = (res: { json(): any }) => res.json().evidence.map((e: any) => ({ dimension: e.dimension, evidenceRef: { kind: e.kind, id: e.id } }));
  const boundaries = (over: Record<string, unknown> = {}) => ({
    // the window is OPEN now, so BO intake can claim immediately (a future window is a separate, already-tested refusal)
    executionWindow: { state: 'VALUE', value: { startsAt: hoursFromNow(-1), endsAt: hoursFromNow(8) } },
    preconditions: { state: 'VALUE', value: [{ code: 'stock_available', operator: 'gte', operand: 1 }] },
    budget: { state: 'VALUE', value: { amount: '250.00', currency: 'USD' } },
    rollback: { state: 'VALUE', value: { instructions: 'Restore the previous reorder policy.' } },
    monitoring: { state: 'VALUE', value: { metrics: [{ metricCode: 'stockouts', target: 0, unit: 'count' }] } },
    simulationRun: SIMULATION_NA, ...over,
  });

  /** Governance, approver, decision, BO facts, then the whole authoring chain up to (not including) issuance. */
  async function author(): Promise<Chain> {
    const s = await setup();
    await governance(s);
    const { actionId, decisionId } = await decide(s);
    const bo = await seedBo(s);
    const base = `/v1/businesses/${s.bizId}/authorized-actions/${actionId}`;
    const ev = await post(s, `/v1/businesses/${s.bizId}/inventory-policy-evaluations`, { actionType: ACTION, target: { kind: 'inventory_item', id: bo.itemId }, finalParameters: FINAL, ruleSetVersion: RULE_SET });
    expect(ev.statusCode).toBe(201);
    const cap = await post(s, `${base}/capture`, {
      actionType: ACTION, target: { kind: 'inventory_item', id: bo.itemId }, proposedParameters: { ...BASELINE },
      modification: { reason: 'Raise the reorder policy.', changes: [
        { parameter: 'reorderPoint', operation: 'SET', before: BASELINE.reorderPoint, after: FINAL.reorderPoint },
        { parameter: 'reorderQuantity', operation: 'SET', before: BASELINE.reorderQuantity, after: FINAL.reorderQuantity }] },
      evaluationEvidence: refs(ev),
    });
    expect(cap.statusCode).toBe(201);
    expect((await post(s, `${base}/owner`, {
      ownerUserId: s.ctx.userId, membershipId: s.membershipId, roleCode: 'operations_lead',
      dueAt: { state: 'VALUE', value: hoursFromNow(72).replace(/\.\d+Z$/, 'Z') }, escalationPolicy: { state: 'VALUE', value: { ref: 'policy:default-escalation' } },
    })).statusCode).toBe(201);
    expect((await post(s, `${base}/boundaries`, boundaries())).statusCode).toBe(201);
    expect((await get(s, `${base}/authoring-status`)).json().missing).toEqual([]);
    return { s, actionId, decisionId, ...bo, base };
  }

  /** Enables the action type for the business through the audited administration route (as the owner, who holds bo:admin). */
  const activate = (c: Chain, state: 'ENABLED' | 'DISABLED' = 'ENABLED') => put(c.s, `/v1/businesses/${c.s.bizId}/execution-activations`, { actionType: ACTION, state, reason: 'p0-6f e2e' });
  /** ABA's issuer: seals the package and (gate open) announces it in the same transaction. Replays announce again, idempotently. */
  const issue = (c: Chain) => post(c.s, `${c.base}/package`);

  return { hdr, post, put, get, setup, seedBo, authorChain: author, activate, issue };
}
