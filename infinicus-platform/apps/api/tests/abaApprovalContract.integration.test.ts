/**
 * P0-4 Block 3 - ABA contract / end-to-end validation and authorization-boundary tests, over HTTP against the real
 * application and a live PostgreSQL database (RLS enforced for the app role).
 *
 * Covers: approver authority (missing / revoked / self-issued), the action-risk policy matrix, the persisted-fact gate
 * (expired, stale, unverifiable Twin, unknown / missing time facts) with reject always allowed, forged-fact injection,
 * audit propagation and atomicity (including real database fault injection), the aba:read / aba:write / aba:admin
 * boundary, and the F1/F2/F3 permissions added by this block.
 *
 * Requires: DATABASE_URL (app role), ADMIN_DATABASE_URL (fixture setup + fault injection).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '@infinicus/configuration';
import {
  createPool, closePool,
  UserRepository, MembershipRepository,
  DigitalTwinDefinitionRepository, DigitalTwinInstanceRepository, DigitalTwinSnapshotRepository,
  type TenantContext,
} from '@infinicus/database';
import { DEFAULT_APPROVER_ASSIGNMENT_CODE } from '@infinicus/workflow';
import { buildApp } from '../src/app.js';
import { createAbaFixture, APPROVABLE_FACTS, uc, type AbaFacts } from './helpers/abaFixtures.js';

const run = !!process.env.DATABASE_URL;
const STRONG_PASSWORD = 'Correct-Horse-9!';
const hours = (n: number) => new Date(Date.now() + n * 3600 * 1000);

let adminPool: Pool;
let app: FastifyInstance;

async function registerActiveUser(): Promise<{ userId: string; token: string }> {
  const email = `${uc('aba-contract')}@aba-contract.example`;
  const reg = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, password: STRONG_PASSWORD } });
  expect(reg.statusCode).toBe(201);
  const userId = reg.json().id as string;
  await new UserRepository().activate(userId);
  const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: STRONG_PASSWORD } });
  expect(login.statusCode).toBe(200);
  return { userId, token: login.json().rawSessionToken as string };
}

/** A fresh tenant + workspace + business with an active membership holding a system role (default owner) or a custom permission set. */
async function setup(role: string | { permissions: string[] } = 'owner'): Promise<{ ctx: TenantContext; token: string; bizId: string }> {
  const { userId, token } = await registerActiveUser();
  const tenantId = randomUUID();
  const workspaceId = randomUUID();
  const sfx = uc('s');
  await adminPool.query(`INSERT INTO tenancy.tenants (id, name, slug, status, plan_code) VALUES ($1,'ABA Contract Tenant',$2,'active','test')`, [tenantId, `abac-${sfx}`]);
  await adminPool.query(`INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,'ABA Contract WS',$3,'active')`, [workspaceId, tenantId, `abac-ws-${sfx}`]);
  const ctx: TenantContext = { tenantId, workspaceId, userId };
  const memberships = new MembershipRepository();
  const membership = await memberships.create(ctx, userId);
  await memberships.activate(ctx, membership.id);

  let roleId: string;
  if (typeof role === 'string') {
    roleId = (await adminPool.query(`SELECT id FROM tenancy.roles WHERE tenant_id IS NULL AND code = $1`, [role])).rows[0].id;
  } else {
    roleId = randomUUID();
    await adminPool.query(`INSERT INTO tenancy.roles (id, tenant_id, code, name, description, scope, is_system) VALUES ($1,$2,$3,'Custom','p0-4 test role','tenant',false)`, [roleId, tenantId, `custom-${sfx}`]);
    await adminPool.query(
      `INSERT INTO tenancy.role_permissions (role_id, permission_id) SELECT $1, id FROM tenancy.permissions WHERE code = ANY($2::text[])`,
      [roleId, role.permissions]
    );
  }
  await memberships.assignRole(ctx, membership.id, roleId);

  const bizId = randomUUID();
  await adminPool.query(
    `INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,'ZZ ABA Contract Biz',$4,'active')`,
    [bizId, tenantId, workspaceId, uc('abac-biz')]
  );
  return { ctx, token, bizId };
}

const headers = (ctx: TenantContext, token: string, extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${token}`, 'x-tenant-id': ctx.tenantId, 'x-workspace-id': ctx.workspaceId, ...extra,
});
const withKey = (ctx: TenantContext, token: string, extra: Record<string, string> = {}) => headers(ctx, token, { 'idempotency-key': uc('key'), ...extra });

const grant = (ctx: TenantContext, token: string, bizId: string, approverUserId: string, assignmentCode: string, roleCode?: string) =>
  app.inject({ method: 'POST', url: `/v1/businesses/${bizId}/approver-assignments`, headers: withKey(ctx, token), payload: { approverUserId, assignmentCode, ...(roleCode ? { roleCode } : {}) } });
const revoke = (ctx: TenantContext, token: string, bizId: string, assignmentCode: string) =>
  app.inject({ method: 'POST', url: `/v1/businesses/${bizId}/approver-assignments/${assignmentCode}/revoke`, headers: withKey(ctx, token), payload: { reason: 'p0-4 contract test' } });

type Outcome = 'approve' | 'approve_with_modifications' | 'reject';
async function decide(
  s: { ctx: TenantContext; token: string; bizId: string }, assignmentCode: string, facts: AbaFacts, outcome: Outcome = 'approve',
  extraBody: Record<string, unknown> = {}, extraHeaders: Record<string, string> = {},
) {
  const { intakePackageId } = await createAbaFixture(s.ctx, s.bizId, facts);
  return app.inject({
    method: 'POST', url: `/v1/businesses/${s.bizId}/decisions`, headers: withKey(s.ctx, s.token, extraHeaders),
    payload: { intakePackageId, reviewCode: uc('r'), summary: 'p0-4 contract', assignmentCode, decisionCode: uc('d'), outcome, ...extraBody },
  });
}

const auditRows = async (bizId: string) => (await adminPool.query(
  `SELECT id, decision_id, event_type, detail FROM approved_business_action.approval_audit_events WHERE business_id = $1 ORDER BY occurred_at, created_at`, [bizId])).rows;
const countAssignments = async (bizId: string) => Number((await adminPool.query(`SELECT count(*)::int n FROM approved_business_action.approver_assignments WHERE business_id = $1`, [bizId])).rows[0].n);
const decidedCount = async (bizId: string) => Number((await adminPool.query(
  `SELECT count(*)::int n FROM approved_business_action.approval_decisions WHERE business_id = $1 AND status IN ('approved','approved_with_modifications','rejected')`, [bizId])).rows[0].n);

/** Publishes a Digital Twin snapshot for the business (published unless told otherwise). */
async function twinSnapshot(ctx: TenantContext, bizId: string, effectiveAt: Date, publish = true): Promise<string> {
  const defRepo = new DigitalTwinDefinitionRepository();
  const definition = await defRepo.createDefinition(ctx, bizId, uc('def'), 'Contract Definition');
  const defVersion = await defRepo.createVersion(ctx, definition.id, bizId, {});
  await defRepo.validateVersion(ctx, defVersion.id);
  await defRepo.activateVersion(ctx, defVersion.id);
  const instRepo = new DigitalTwinInstanceRepository();
  const instance = await instRepo.createInstance(ctx, bizId, definition.id, uc('inst'));
  await instRepo.transitionStatus(ctx, instance.id, 'active');
  const snapRepo = new DigitalTwinSnapshotRepository();
  const { snapshot, version } = await snapRepo.createSnapshot(ctx, bizId, instance.id, uc('snap'), effectiveAt, 'contract snapshot');
  if (publish) {
    await snapRepo.validateSnapshot(ctx, snapshot.id, version.id);
    await snapRepo.publishSnapshot(ctx, snapshot.id, version.id);
  }
  return snapshot.id;
}

/** Makes every audit-event INSERT for one business fail, to prove behaviour when the audit store is genuinely down. */
async function withAuditFailure<T>(bizId: string, fn: () => Promise<T>): Promise<T> {
  const name = `p04_fail_${bizId.replace(/-/g, '').slice(0, 12)}`;
  await adminPool.query(`CREATE OR REPLACE FUNCTION public.p04_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'p04 injected audit failure'; END $$`);
  await adminPool.query(`CREATE TRIGGER ${name} BEFORE INSERT ON approved_business_action.approval_audit_events FOR EACH ROW WHEN (NEW.business_id = '${bizId}') EXECUTE FUNCTION public.p04_fail_audit()`);
  try {
    return await fn();
  } finally {
    await adminPool.query(`DROP TRIGGER IF EXISTS ${name} ON approved_business_action.approval_audit_events`);
  }
}

describe.runIf(run)('P0-4 Block 3 - ABA contract / e2e and authorization boundary (HTTP, live PostgreSQL)', () => {
  beforeAll(async () => {
    const appUrl = process.env.DATABASE_URL!;
    createPool({ connectionString: appUrl });
    adminPool = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? appUrl });
    app = await buildApp(loadConfig({ DATABASE_URL: appUrl, NODE_ENV: 'test', LOG_LEVEL: 'silent', RATE_LIMIT_MAX: '5000' }));
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    await adminPool?.end();
    await closePool();
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe('C. authorization boundary', () => {
    it('aba:read alone cannot approve, grant, read or revoke approver authority', async () => {
      const s = await setup({ permissions: ['aba:read', 'bo:read'] });
      const post = await app.inject({ method: 'POST', url: `/v1/businesses/${s.bizId}/decisions`, headers: withKey(s.ctx, s.token), payload: { intakePackageId: randomUUID(), reviewCode: 'r', summary: 's', assignmentCode: 'a', decisionCode: 'd', outcome: 'approve' } });
      expect(post.statusCode).toBe(403);
      expect(post.json().error.code).toBe('PermissionDeniedError');
      expect((await grant(s.ctx, s.token, s.bizId, s.ctx.userId, uc('a'))).statusCode).toBe(403);
      expect((await app.inject({ method: 'GET', url: `/v1/businesses/${s.bizId}/approver-assignments/x`, headers: headers(s.ctx, s.token) })).statusCode).toBe(403);
      expect((await revoke(s.ctx, s.token, s.bizId, 'x')).statusCode).toBe(403);
      expect(await countAssignments(s.bizId)).toBe(0);
    });

    it('aba:write without aba:admin cannot grant, read or revoke authority (and still needs an assignment to decide)', async () => {
      const s = await setup({ permissions: ['aba:write'] });
      expect((await grant(s.ctx, s.token, s.bizId, s.ctx.userId, uc('a'))).statusCode).toBe(403);
      expect((await app.inject({ method: 'GET', url: `/v1/businesses/${s.bizId}/approver-assignments/x`, headers: headers(s.ctx, s.token) })).statusCode).toBe(403);
      expect((await revoke(s.ctx, s.token, s.bizId, 'x')).statusCode).toBe(403);
      expect(await countAssignments(s.bizId)).toBe(0);
      const res = await decide(s, uc('nope'), APPROVABLE_FACTS);
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('ApproverAuthorityNotEstablishedError');
    });

    it('aba:admin without aba:write can grant and revoke explicitly but cannot render a decision', async () => {
      const s = await setup({ permissions: ['aba:admin'] });
      const code = uc('adm');
      expect((await grant(s.ctx, s.token, s.bizId, s.ctx.userId, code, 'business-owner')).statusCode).toBe(201);
      const denied = await decide(s, code, APPROVABLE_FACTS);
      expect(denied.statusCode).toBe(403);
      expect(denied.json().error.code).toBe('PermissionDeniedError');
      expect(await decidedCount(s.bizId)).toBe(0);
      expect((await revoke(s.ctx, s.token, s.bizId, code)).statusCode).toBe(200);
    });

    it('no decision route self-issues authority: deciding with no assignment creates none and is denied', async () => {
      const s = await setup('owner');
      const res = await decide(s, uc('self'), APPROVABLE_FACTS);
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('ApproverAuthorityNotEstablishedError');
      expect(await countAssignments(s.bizId)).toBe(0);
      const rows = await auditRows(s.bizId);
      expect(rows.map((r) => r.event_type)).toEqual(['approval.denied']);
      expect(rows[0].detail.reasonCodes).toEqual(['AUTHORITY_NOT_ESTABLISHED']);
    });

    it('a revoked assignment can no longer decide (explicit aba:admin revoke), and the denial is audited', async () => {
      const s = await setup('owner');
      const code = uc('rev');
      expect((await grant(s.ctx, s.token, s.bizId, s.ctx.userId, code, 'business-owner')).statusCode).toBe(201);
      expect((await decide(s, code, APPROVABLE_FACTS)).statusCode).toBe(201);
      expect((await revoke(s.ctx, s.token, s.bizId, code)).statusCode).toBe(200);
      const after = await decide(s, code, APPROVABLE_FACTS);
      expect(after.statusCode).toBe(403);
      expect(after.json().error.code).toBe('ApproverAuthorityNotEstablishedError');
      expect((await auditRows(s.bizId)).map((r) => r.event_type)).toEqual(['approval.approved', 'approval.denied']);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe('B. action-risk policy (P0-2) over HTTP', () => {
    it('enforces the role-tier x risk-class matrix; unclassified fails closed as high; reject is always allowed', async () => {
      const s = await setup('owner');
      const required: Record<string, number> = { low: 1, medium: 2, high: 3, critical: 3 };
      const tier: Record<string, number> = { cashier: 1, manager: 2, 'business-owner': 3 };
      const codes: Record<string, string> = {};
      for (const role of Object.keys(tier)) {
        codes[role] = uc(role);
        expect((await grant(s.ctx, s.token, s.bizId, s.ctx.userId, codes[role], role)).statusCode).toBe(201);
      }
      for (const risk of ['low', 'medium', 'high', 'critical'] as const) {
        for (const role of Object.keys(tier)) {
          const res = await decide(s, codes[role], { riskClass: risk, isTimeSensitive: false }, 'approve');
          expect(res.statusCode, `${role} approving ${risk}`).toBe(tier[role] >= required[risk] ? 201 : 403);
          if (res.statusCode === 403) expect(res.json().error.code).toBe('ApprovalPolicyDeniedError');
        }
      }
      // Unclassified (no persisted risk_class) is treated as high: only the owner tier may approve.
      expect((await decide(s, codes.cashier, { isTimeSensitive: false })).statusCode).toBe(403);
      expect((await decide(s, codes.manager, { isTimeSensitive: false })).statusCode).toBe(403);
      expect((await decide(s, codes['business-owner'], { isTimeSensitive: false })).statusCode).toBe(201);
      // Reject is allowed at every tier regardless of risk.
      for (const role of Object.keys(tier)) {
        expect((await decide(s, codes[role], { riskClass: 'critical', isTimeSensitive: false }, 'reject')).statusCode, `${role} rejecting critical`).toBe(201);
      }
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe('B. persisted-fact gate (P0-3) and expiry audit (P0-4 Block 2) over HTTP', () => {
    it('expired review: approval refused (409) with approval.expired + approval.blocked; reject allowed on the same facts', async () => {
      const s = await setup('owner');
      const code = uc('o');
      expect((await grant(s.ctx, s.token, s.bizId, s.ctx.userId, code, 'business-owner')).statusCode).toBe(201);
      const fixture = await createAbaFixture(s.ctx, s.bizId, { riskClass: 'low', isTimeSensitive: true, validUntil: hours(-1) });
      const attempt = (outcome: Outcome) => app.inject({
        method: 'POST', url: `/v1/businesses/${s.bizId}/decisions`, headers: withKey(s.ctx, s.token),
        payload: { intakePackageId: fixture.intakePackageId, reviewCode: uc('r'), summary: 's', assignmentCode: code, decisionCode: uc('d'), outcome },
      });
      // Idempotent recording per review version is proven at the service level (repeated and concurrent detection of the SAME version).
      const first = await attempt('approve');
      expect(first.statusCode).toBe(409);
      expect(first.json().error.message).toMatch(/EXPIRED/);
      const rows = await auditRows(s.bizId);
      expect(rows.map((r) => r.event_type).sort()).toEqual(['approval.blocked', 'approval.expired']);
      expect(rows.find((r) => r.event_type === 'approval.expired')!.detail).toMatchObject({ reasonCode: 'valid_until_elapsed', sourceLayer: 'ABA', detectionPath: 'approval_attempt' });
      expect(rows.find((r) => r.event_type === 'approval.blocked')!.detail.reasonCodes).toEqual(['EXPIRED']);
      expect(await decidedCount(s.bizId)).toBe(0);

      // Reject is still allowed on the same expired facts.
      expect((await decide(s, code, { riskClass: 'low', isTimeSensitive: true, validUntil: hours(-1) }, 'reject')).statusCode).toBe(201);
    });

    it('stale Twin, unverifiable Twin and unknown time-sensitivity block approval (409, RECALCULATE_DECISION) while reject stays allowed', async () => {
      const s = await setup('owner');
      const code = uc('o');
      expect((await grant(s.ctx, s.token, s.bizId, s.ctx.userId, code, 'business-owner')).statusCode).toBe(201);
      const used = await twinSnapshot(s.ctx, s.bizId, hours(300));
      await twinSnapshot(s.ctx, s.bizId, hours(302)); // newer PUBLISHED snapshot => `used` is stale
      const unpublished = await twinSnapshot(s.ctx, s.bizId, hours(304), false);

      const cases: Array<{ name: string; facts: AbaFacts; code: string }> = [
        { name: 'stale Twin', facts: { riskClass: 'low', isTimeSensitive: false, twinSnapshotId: used }, code: 'STALE' },
        { name: 'unverifiable Twin (unpublished)', facts: { riskClass: 'low', isTimeSensitive: false, twinSnapshotId: unpublished }, code: 'TWIN_SNAPSHOT_UNVERIFIABLE' },
        { name: 'unverifiable Twin (unknown id)', facts: { riskClass: 'low', isTimeSensitive: false, twinSnapshotId: randomUUID() }, code: 'TWIN_SNAPSHOT_UNVERIFIABLE' },
        { name: 'unknown is_time_sensitive', facts: { riskClass: 'low' }, code: 'TIME_SENSITIVITY_UNKNOWN' },
      ];
      for (const c of cases) {
        const blockedRes = await decide(s, code, c.facts, 'approve');
        expect(blockedRes.statusCode, `${c.name} approve`).toBe(409);
        expect(blockedRes.json().error.message, c.name).toMatch(new RegExp(c.code));
        expect(blockedRes.json().error.message, c.name).toMatch(/RECALCULATE.DECISION/);
        const mod = await decide(s, code, c.facts, 'approve_with_modifications');
        expect(mod.statusCode, `${c.name} approve_with_modifications`).toBe(409);
        const rej = await decide(s, code, c.facts, 'reject');
        expect(rej.statusCode, `${c.name} reject`).toBe(201);
      }
      expect((await auditRows(s.bizId)).filter((r) => r.event_type === 'approval.expired')).toHaveLength(0);
    });

    // is_time_sensitive=true with no valid_until cannot be reached through POST /decisions: ADI refuses to AUTHOR such a
    // recommendation (ValidationError), so ABA never snapshots it. The ABA-side block (TIME_SENSITIVE_WITHOUT_VALIDITY) is
    // proven at the service level in DecisionWorkflowService.integration.test.ts with an explicitly constructed review version.
    it('ADI refuses to author a time-sensitive recommendation without valid_until, so the HTTP path cannot produce one', async () => {
      const s = await setup('owner');
      await expect(createAbaFixture(s.ctx, s.bizId, { riskClass: 'low', isTimeSensitive: true })).rejects.toThrow(/time-sensitive recommendation must carry valid_until/);
    });

    it('callers cannot inject risk_class, is_time_sensitive, valid_until or twin_snapshot_id: persisted facts alone decide', async () => {
      const s = await setup('owner');
      const code = uc('o');
      expect((await grant(s.ctx, s.token, s.bizId, s.ctx.userId, code, 'business-owner')).statusCode).toBe(201);
      const forged = { riskClass: 'low', risk_class: 'low', isTimeSensitive: false, is_time_sensitive: false, validUntil: '2999-01-01T00:00:00Z', valid_until: '2999-01-01T00:00:00Z', twinSnapshotId: randomUUID(), twin_snapshot_id: randomUUID() };
      // Persisted facts unknown => still blocked, whatever the body claims.
      const unknown = await decide(s, code, { riskClass: 'low' }, 'approve', forged);
      expect(unknown.statusCode).toBe(409);
      expect(unknown.json().error.message).toMatch(/TIME_SENSITIVITY_UNKNOWN/);
      // Persisted facts expired => still blocked.
      const expired = await decide(s, code, { riskClass: 'low', isTimeSensitive: true, validUntil: hours(-1) }, 'approve', forged);
      expect(expired.statusCode).toBe(409);
      // Persisted facts fine, body claims a hostile twin => unaffected, approved.
      const fine = await decide(s, code, APPROVABLE_FACTS, 'approve', forged);
      expect(fine.statusCode).toBe(201);
      // Persisted risk is high; a body claiming "low" cannot lower the bar for a manager.
      const mgr = uc('m');
      expect((await grant(s.ctx, s.token, s.bizId, s.ctx.userId, mgr, 'manager')).statusCode).toBe(201);
      expect((await decide(s, mgr, { riskClass: 'high', isTimeSensitive: false }, 'approve', forged)).statusCode).toBe(403);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe('B. audit completeness, propagation and atomicity over HTTP', () => {
    it('approve, approve_with_modifications and reject each write one audit event with permissionUsed and correlationId', async () => {
      const s = await setup('owner');
      const code = uc('o');
      expect((await grant(s.ctx, s.token, s.bizId, s.ctx.userId, code, 'business-owner')).statusCode).toBe(201);
      for (const [i, outcome] of (['approve', 'approve_with_modifications', 'reject'] as Outcome[]).entries()) {
        expect((await decide(s, code, APPROVABLE_FACTS, outcome, {}, { 'x-correlation-id': `corr-${i}` })).statusCode).toBe(201);
      }
      const rows = await auditRows(s.bizId);
      expect(rows.map((r) => r.event_type)).toEqual(['approval.approved', 'approval.approved_with_modifications', 'approval.rejected']);
      rows.forEach((r, i) => {
        expect(r.detail).toMatchObject({ permissionUsed: 'aba:write', correlationId: `corr-${i}`, schema: 'approval-audit/1' });
        expect(r.decision_id).toEqual(expect.any(String));
      });
    });

    it('the choice route records permissionUsed=aba:write and the correlation id in its approval audit (N3)', async () => {
      const s = await setup('owner');
      expect((await grant(s.ctx, s.token, s.bizId, s.ctx.userId, DEFAULT_APPROVER_ASSIGNMENT_CODE, 'business-owner')).statusCode).toBe(201);
      const { recommendationId } = await createAbaFixture(s.ctx, s.bizId, APPROVABLE_FACTS);
      const res = await app.inject({
        method: 'POST', url: `/v1/businesses/${s.bizId}/decision-recommendations/${recommendationId}/choice`,
        headers: withKey(s.ctx, s.token, { 'x-correlation-id': 'corr-choice-1' }), payload: { chosen: true },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().approved).toBe(true);
      const rows = (await auditRows(s.bizId)).filter((r) => r.event_type === 'approval.approved');
      expect(rows).toHaveLength(1);
      expect(rows[0].detail).toMatchObject({ permissionUsed: 'aba:write', correlationId: 'corr-choice-1' });
    });

    it('a failing audit write rolls back the successful decision mutation (real database fault injection)', async () => {
      const s = await setup('owner');
      const code = uc('o');
      expect((await grant(s.ctx, s.token, s.bizId, s.ctx.userId, code, 'business-owner')).statusCode).toBe(201);
      const res = await withAuditFailure(s.bizId, () => decide(s, code, APPROVABLE_FACTS, 'approve'));
      expect(res.statusCode).toBe(500);
      expect(await decidedCount(s.bizId)).toBe(0);
      expect(await auditRows(s.bizId)).toHaveLength(0);
      // Once the store recovers, the same approver can decide normally.
      expect((await decide(s, code, APPROVABLE_FACTS, 'approve')).statusCode).toBe(201);
    });

    it('a failing audit write never turns a refusal into success: expired approval stays 409 and nothing is decided', async () => {
      const s = await setup('owner');
      const code = uc('o');
      expect((await grant(s.ctx, s.token, s.bizId, s.ctx.userId, code, 'business-owner')).statusCode).toBe(201);
      const res = await withAuditFailure(s.bizId, () => decide(s, code, { riskClass: 'low', isTimeSensitive: true, validUntil: hours(-1) }, 'approve'));
      expect(res.statusCode).toBe(409);
      expect(res.json().error.message).toMatch(/EXPIRED/);
      expect(await decidedCount(s.bizId)).toBe(0);
      expect(await auditRows(s.bizId)).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe('F1/F2/F3 - read-route permissions added by this block', () => {
    it('F1: GET /v1/businesses requires bo:read', async () => {
      const allowed = await setup({ permissions: ['bo:read'] });
      expect((await app.inject({ method: 'GET', url: '/v1/businesses', headers: headers(allowed.ctx, allowed.token) })).statusCode).toBe(200);
      const denied = await setup({ permissions: ['aba:read', 'om:read', 'dt:read', 'sim:read', 'adi:read', 'bi:read'] });
      const res = await app.inject({ method: 'GET', url: '/v1/businesses', headers: headers(denied.ctx, denied.token) });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('PermissionDeniedError');
    });

    it('F2: the workflow view needs ALL seven layer read permissions - any single missing one is refused', async () => {
      const all = ['bo:read', 'bi:read', 'dt:read', 'sim:read', 'adi:read', 'aba:read', 'om:read'];
      const full = await setup({ permissions: all });
      const ok = await app.inject({ method: 'GET', url: `/v1/businesses/${full.bizId}/workflow`, headers: headers(full.ctx, full.token) });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().business.id).toBe(full.bizId);
      for (const missing of all) {
        const s = await setup({ permissions: all.filter((p) => p !== missing) });
        const res = await app.inject({ method: 'GET', url: `/v1/businesses/${s.bizId}/workflow`, headers: headers(s.ctx, s.token) });
        expect(res.statusCode, `without ${missing}`).toBe(403);
      }
      // A single unrelated permission - even a write/admin one - is not a substitute.
      const lone = await setup({ permissions: ['bo:read', 'bo:write', 'bo:admin'] });
      expect((await app.inject({ method: 'GET', url: `/v1/businesses/${lone.bizId}/workflow`, headers: headers(lone.ctx, lone.token) })).statusCode).toBe(403);
      // System roles that hold every read permission keep access (owner, admin, member, viewer).
      for (const role of ['owner', 'admin', 'member', 'viewer']) {
        const s = await setup(role);
        const res = await app.inject({ method: 'GET', url: `/v1/businesses/${s.bizId}/workflow`, headers: headers(s.ctx, s.token) });
        expect(res.statusCode, role).toBe(200);
      }
    });

    it('F3: the billing subscription read requires platform:admin (owner only among system roles)', async () => {
      const owner = await setup('owner');
      expect((await app.inject({ method: 'GET', url: '/v1/billing/subscription', headers: headers(owner.ctx, owner.token) })).statusCode).toBe(200);
      for (const role of ['admin', 'member', 'viewer']) {
        const s = await setup(role);
        const res = await app.inject({ method: 'GET', url: '/v1/billing/subscription', headers: headers(s.ctx, s.token) });
        expect(res.statusCode, role).toBe(403);
      }
    });
  });
});
