/**
 * J-ROBUST-1 - foreign-key failures must not become HTTP 500: live PostgreSQL + real Fastify application (RLS enforced for the app role).
 *
 * Approved semantics: an unknown or inaccessible referenced resource is 404 and a resource of another tenant is indistinguishable from a missing one
 * (same status, same body apart from the caller's own correlation id and the id the caller supplied); a row that is still referenced is a controlled
 * 409; nothing from PostgreSQL (constraint, table, column, key, value) reaches the client; nothing is written on a refusal.
 * Requires DATABASE_URL (app role) and ADMIN_DATABASE_URL.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- HTTP payloads are arbitrary JSON */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '@infinicus/configuration';
import { createPool, closePool, UserRepository, MembershipRepository, type TenantContext } from '@infinicus/database';
import { DEFAULT_APPROVER_ASSIGNMENT_CODE } from '@infinicus/workflow';
import { buildApp } from '../src/app.js';
import { makeExecWorld } from '../../../packages/business-operations-runtime/tests/helpers/executionWorld.js';
import { deleteMovementsForTenants } from '../../../packages/business-operations-runtime/tests/helpers/movementCleanup.js';
import { createAbaFixture, APPROVABLE_FACTS, uc } from './helpers/abaFixtures.js';

const run = !!process.env.DATABASE_URL && !!process.env.ADMIN_DATABASE_URL;
const PASSWORD = 'Correct-Horse-9!';
const ABA = 'approved_business_action';

let admin: Pool;
let app: FastifyInstance;
const tenantIds: string[] = [];
interface World { ctx: TenantContext; token: string; bizId: string }

async function newWorld(): Promise<World> {
  const ew = await makeExecWorld(admin, tenantIds, {});
  await admin.query(`UPDATE tenancy.tenants SET status='active', plan_code='test' WHERE id=$1`, [ew.w.tenantId]);
  const email = `${uc('jr')}@jr-fk.example`;
  const reg = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, password: PASSWORD } });
  const userId = reg.json().id as string;
  await new UserRepository().activate(userId);
  const token = (await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: PASSWORD } })).json().rawSessionToken as string;
  const ctx: TenantContext = { tenantId: ew.w.tenantId, workspaceId: ew.w.workspaceId, userId };
  const m = new MembershipRepository(); const mem = await m.create(ctx, userId); await m.activate(ctx, mem.id);
  await m.assignRole(ctx, mem.id, (await admin.query(`SELECT id FROM tenancy.roles WHERE tenant_id IS NULL AND code='admin'`)).rows[0].id);
  return { ctx, token, bizId: ew.ctx.businessId };
}
const headers = (w: World, extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${w.token}`, 'x-tenant-id': w.ctx.tenantId, 'x-workspace-id': w.ctx.workspaceId, 'idempotency-key': uc('k'), ...extra,
});
const post = (w: World, url: string, payload: unknown, extra: Record<string, string> = {}) => app.inject({ method: 'POST', url, headers: headers(w, extra), payload: payload as any });
async function grantAuthority(w: World): Promise<void> {
  const r = await post(w, `/v1/businesses/${w.bizId}/approver-assignments`, { approverUserId: w.ctx.userId, assignmentCode: DEFAULT_APPROVER_ASSIGNMENT_CODE, roleCode: 'business-owner' });
  expect(r.statusCode).toBe(201);
}
const decisionBody = (intakePackageId: string) => ({ intakePackageId, reviewCode: uc('r'), summary: 's', decisionCode: uc('d'), outcome: 'approve' });
const count = async (sql: string, args: unknown[]) => Number((await admin.query(sql, args)).rows[0].n);
const reviews = (w: World) => count(`SELECT count(*) n FROM ${ABA}.action_review_packages WHERE tenant_id=$1`, [w.ctx.tenantId]);
const publications = (w: World) => count(`SELECT count(*) n FROM ${ABA}.aba_publication_packages WHERE tenant_id=$1`, [w.ctx.tenantId]);
const serverErrors = (correlationId: string) => count(`SELECT count(*) n FROM observability.error_events WHERE correlation_id=$1`, [correlationId]);

/** A response reduced to what a caller can compare: status and error code and a message with the caller-supplied id masked; the correlation id is the caller's own. */
const shape = (res: { statusCode: number; json: () => any }, suppliedId: string) => {
  const e = res.json().error;
  return { status: res.statusCode, code: e.code, message: String(e.message).split(suppliedId).join('<id>'), keys: Object.keys(e).sort() };
};
const LEAKS = /constraint|violates|foreign key|Key \(|DETAIL|_fkey|schema|pg_|action_review|aba_|approved_actions|tenant_id|23503/i;

describe.runIf(run)('J-ROBUST-1 foreign-key classification - live PostgreSQL + Fastify', () => {
  beforeAll(async () => {
    createPool({ connectionString: process.env.DATABASE_URL! });
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
    app = await buildApp(loadConfig({ DATABASE_URL: process.env.DATABASE_URL!, NODE_ENV: 'test', LOG_LEVEL: 'silent', RATE_LIMIT_MAX: '5000' }));
    // Boundary probes: routes that throw REAL PostgreSQL errors (not hand-built objects) through the production error handler. Added before ready().
    app.get('/__test/fk-missing', async () => { await admin.query(`INSERT INTO ${ABA}.action_review_packages (tenant_id, workspace_id, business_id, intake_package_id, review_code) VALUES ($1,$1,$1,$1,'x')`, [randomUUID()]); });
    app.get('/__test/fk-referenced/:businessId', async (req) => { await admin.query('DELETE FROM platform.businesses WHERE id = $1', [(req.params as any).businessId]); });
    app.get('/__test/other-error', async () => { throw new Error('boom internal detail'); });
    await app.ready();
  });
  afterAll(async () => { await deleteMovementsForTenants(admin, tenantIds).catch(() => undefined); await app?.close(); await admin?.end(); await closePool(); });

  describe('POST /decisions - referenced intake package', () => {
    it('an unknown intake package is a 404 NotFound, nothing is written and no server error is recorded', async () => {
      const a = await newWorld(); await grantAuthority(a);
      const missing = randomUUID();
      const res = await post(a, `/v1/businesses/${a.bizId}/decisions`, decisionBody(missing));
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('NotFoundError');
      expect(res.body).not.toMatch(LEAKS);
      expect(await reviews(a)).toBe(0);
      expect(await serverErrors(res.json().error.correlationId)).toBe(0);
    });

    it('another tenant\'s intake package is indistinguishable from an unknown one (same status, code, message shape and keys), and is not linked', async () => {
      const a = await newWorld(); const b = await newWorld(); await grantAuthority(a);
      const foreign = (await createAbaFixture(b.ctx, b.bizId, APPROVABLE_FACTS)).intakePackageId;
      const unknown = randomUUID();
      const rForeign = await post(a, `/v1/businesses/${a.bizId}/decisions`, decisionBody(foreign));
      const rUnknown = await post(a, `/v1/businesses/${a.bizId}/decisions`, decisionBody(unknown));
      expect(rForeign.statusCode).toBe(404);
      expect(shape(rForeign, foreign)).toEqual(shape(rUnknown, unknown));
      expect(rForeign.body).not.toContain(b.ctx.tenantId);
      expect(rForeign.body).not.toContain(b.bizId);
      expect(await reviews(a)).toBe(0);
      expect(await reviews(b)).toBe(0);
    });

    it('an intake package of ANOTHER BUSINESS in the same tenant and workspace is a 404 too and is never linked to this business', async () => {
      const a = await newWorld(); await grantAuthority(a);
      const biz2 = randomUUID();
      await admin.query(`INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,'ZZ JR Other Biz',$4,'active')`, [biz2, a.ctx.tenantId, a.ctx.workspaceId, uc('jr-biz2')]);
      const other = (await createAbaFixture(a.ctx, biz2, APPROVABLE_FACTS)).intakePackageId;
      const res = await post(a, `/v1/businesses/${a.bizId}/decisions`, decisionBody(other));
      expect(res.statusCode).toBe(404);
      expect(await reviews(a)).toBe(0);
    });

    it('a valid reference still works (201) and an idempotent retry with the same key replays the stored response without a second review', async () => {
      const a = await newWorld(); await grantAuthority(a);
      const { intakePackageId } = await createAbaFixture(a.ctx, a.bizId, APPROVABLE_FACTS);
      const key = uc('idem'); const body = decisionBody(intakePackageId);
      const first = await post(a, `/v1/businesses/${a.bizId}/decisions`, body, { 'idempotency-key': key });
      expect(first.statusCode).toBe(201);
      const again = await post(a, `/v1/businesses/${a.bizId}/decisions`, body, { 'idempotency-key': key });
      expect(again.statusCode).toBe(201);
      expect(again.json()).toEqual(first.json());
      expect(await reviews(a)).toBe(1);
    });

    it('a malformed identifier stays a 400 (syntax is not a reference)', async () => {
      const a = await newWorld(); await grantAuthority(a);
      const res = await post(a, `/v1/businesses/${a.bizId}/decisions`, { ...decisionBody(randomUUID()), intakePackageId: 'not-a-uuid' });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('POST /decision-recommendations/outcome - referenced approved action', () => {
    it('an unknown approved action is a 404 NotFound; no publication or monitoring row is written', async () => {
      const a = await newWorld();
      const res = await post(a, `/v1/businesses/${a.bizId}/decision-recommendations/outcome`, { approvedActionId: randomUUID(), outcomeNotes: 'n' });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('NotFoundError');
      expect(res.body).not.toMatch(LEAKS);
      expect(await publications(a)).toBe(0);
      expect(await serverErrors(res.json().error.correlationId)).toBe(0);
    });

    it('another tenant\'s approved action is indistinguishable from an unknown one; a valid chosen decision still records its outcome (201)', async () => {
      const a = await newWorld(); const b = await newWorld(); await grantAuthority(a); await grantAuthority(b);
      const chooseFor = async (w: World) => {
        const { recommendationId } = await createAbaFixture(w.ctx, w.bizId, APPROVABLE_FACTS);
        const r = await post(w, `/v1/businesses/${w.bizId}/decision-recommendations/${recommendationId}/choice`, { chosen: true });
        expect(r.statusCode).toBe(201);
        expect(r.json().approvedActionId).toEqual(expect.any(String));
        return r.json().approvedActionId as string;
      };
      const foreign = await chooseFor(b);
      const own = await chooseFor(a);
      const unknown = randomUUID();
      const pubsBefore = await publications(a);
      const rForeign = await post(a, `/v1/businesses/${a.bizId}/decision-recommendations/outcome`, { approvedActionId: foreign, outcomeNotes: 'n' });
      const rUnknown = await post(a, `/v1/businesses/${a.bizId}/decision-recommendations/outcome`, { approvedActionId: unknown, outcomeNotes: 'n' });
      expect(rForeign.statusCode).toBe(404);
      expect(shape(rForeign, foreign)).toEqual(shape(rUnknown, unknown));
      expect(rForeign.body).not.toContain(b.ctx.tenantId);
      expect(await publications(a)).toBe(pubsBefore);
      const ok = await post(a, `/v1/businesses/${a.bizId}/decision-recommendations/outcome`, { approvedActionId: own, outcomeNotes: 'delivered' });
      expect(ok.statusCode).toBe(201);
      expect(ok.json().observationId).toEqual(expect.any(String));
    });
  });

  describe('routes that already classified references are unchanged', () => {
    it('/outcomes with an unknown monitored action and /choice with an unknown recommendation stay 404', async () => {
      const a = await newWorld();
      const o = await post(a, `/v1/businesses/${a.bizId}/outcomes`, { monitoredActionId: randomUUID(), observationCode: uc('o'), summary: 's', effectiveAt: new Date().toISOString() });
      expect(o.statusCode).toBe(404);
      const c = await post(a, `/v1/businesses/${a.bizId}/decision-recommendations/${randomUUID()}/choice`, { chosen: true });
      expect(c.statusCode).toBe(404);
    });
  });

  describe('the API error boundary - a foreign-key violation no repository classified', () => {
    it('a REAL "reference not present" violation is a generic 404 with no database detail and no recorded server error', async () => {
      const res = await app.inject({ method: 'GET', url: '/__test/fk-missing' });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toEqual({ code: 'NotFoundError', message: 'A referenced resource was not found.', correlationId: expect.any(String) });
      expect(res.body).not.toMatch(LEAKS);
      expect(await serverErrors(res.json().error.correlationId)).toBe(0);
    });

    it('a REAL "still referenced" violation is a controlled 409 with no database detail', async () => {
      const a = await newWorld();
      const res = await app.inject({ method: 'GET', url: `/__test/fk-referenced/${a.bizId}` });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toEqual({ code: 'ConflictError', message: 'The request conflicts with existing related data.', correlationId: expect.any(String) });
      expect(res.body).not.toMatch(LEAKS);
      expect(res.body).not.toContain(a.bizId);
    });

    it('any other unexpected error is still the redacted 500 and is still recorded', async () => {
      const res = await app.inject({ method: 'GET', url: '/__test/other-error' });
      expect(res.statusCode).toBe(500);
      expect(res.json().error.code).toBe('internal_error');
      expect(res.body).not.toContain('boom internal detail');
    });
  });
});
