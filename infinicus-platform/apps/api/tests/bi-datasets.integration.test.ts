/**
 * BI-1-DEV-03 - the BI intake and dataset read API (real PostgreSQL, production buildApp, application role).
 * GET /v1/businesses/:businessId/bi/intake-packages[/:id] and /bi/datasets[/:id]: read-only, bi:read, tenant / workspace / business isolation from the
 * authenticated context, uniform 404 for anything outside the caller's business (no enumeration), scores null until assessed, no mutation, no internal fields.
 * Intakes and datasets are produced by the REAL BI services from BO-shaped publications.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { loadConfig } from '@infinicus/configuration';
import { closePool, createPool, MembershipRepository, UserRepository, type TenantContext } from '@infinicus/database';
import { buildApp } from '../src/app.js';
import { STRONG_PASSWORD, dalKit, unique, type World } from './helpers/dalIngestion.js';
import { ingestAndMaterialize, ingestRejected } from './helpers/biPublication.js';

const run = !!process.env.DATABASE_URL && !!process.env.ADMIN_DATABASE_URL;
let app: FastifyInstance; let admin: Pool; const tenantIds: string[] = []; let kit: ReturnType<typeof dalKit>;
const get = (w: { ctx: TenantContext; token: string }, url: string) => app.inject({ method: 'GET', url, headers: kit.headers(w) });
const base = (w: World) => `/v1/businesses/${w.businessId}/bi`;

describe.runIf(run)('BI-1-DEV-03: BI intake and dataset read API', () => {
  let a: World; let b: World;
  let octA: Awaited<ReturnType<typeof ingestAndMaterialize>>; let novA: Awaited<ReturnType<typeof ingestAndMaterialize>>; let finA: Awaited<ReturnType<typeof ingestAndMaterialize>>;
  let rejectedA: Awaited<ReturnType<typeof ingestRejected>>; let pendingA: Awaited<ReturnType<typeof ingestAndMaterialize>>; let octB: Awaited<ReturnType<typeof ingestAndMaterialize>>;

  beforeAll(async () => {
    createPool({ connectionString: process.env.DATABASE_URL! });
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
    app = await buildApp(loadConfig({ DATABASE_URL: process.env.DATABASE_URL!, NODE_ENV: 'test', LOG_LEVEL: 'silent', RATE_LIMIT_MAX: '5000' }));
    await app.ready();
    kit = dalKit({ app, admin, tenantIds });
    a = await kit.world(); b = await kit.world();
    octA = await ingestAndMaterialize(admin, a);
    novA = await ingestAndMaterialize(admin, a, { periodStart: '2026-11-01T00:00:00.000Z', periodEnd: '2026-12-01T00:00:00.000Z', recordCount: 7, payloadReference: { table: 'inventory_movements', rows: 7 } });
    finA = await ingestAndMaterialize(admin, a, { targetBlock: 'BI-11' });
    rejectedA = await ingestRejected(admin, a);
    pendingA = await ingestAndMaterialize(admin, a, { materialize: false });
    octB = await ingestAndMaterialize(admin, b);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    if (tenantIds.length > 0) {
      const c = await admin.connect();
      try { await c.query('BEGIN'); await c.query("SET LOCAL session_replication_role = 'replica'"); await c.query('DELETE FROM audit.audit_events WHERE tenant_id = ANY($1)', [tenantIds]); await c.query('COMMIT'); }
      catch { await c.query('ROLLBACK').catch(() => undefined); } finally { c.release(); }
    }
    await admin?.end(); await closePool();
  });

  /** A user who is an active member of tenant A's workspace holding exactly the given permissions through a tenant-owned role (none = no role at all). */
  async function memberWith(permissions: string[]) {
    const email = `${unique('perm')}@bi.example`;
    const reg = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, password: STRONG_PASSWORD } });
    const userId = reg.json().id as string; await new UserRepository().activate(userId);
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: STRONG_PASSWORD } });
    const ctx: TenantContext = { tenantId: a.ctx.tenantId, workspaceId: a.ctx.workspaceId, userId };
    const memberships = new MembershipRepository(); const m = await memberships.create(ctx, userId); await memberships.activate(ctx, m.id);
    if (permissions.length > 0) {
      const role = await admin.query(`INSERT INTO tenancy.roles (tenant_id, code, name, scope) VALUES ($1,$2,'BI read test role','workspace') RETURNING id`, [a.ctx.tenantId, unique('bi-role')]);
      await admin.query(`INSERT INTO tenancy.role_permissions (role_id, permission_id) SELECT $1, id FROM tenancy.permissions WHERE code = ANY($2)`, [role.rows[0].id, permissions]);
      await memberships.assignRole(ctx, m.id, role.rows[0].id);
    }
    return { ctx, token: login.json().rawSessionToken as string };
  }

  describe('intake status', () => {
    it('lists what BI took in for the business, newest first, with the BO publication reference; another business\'s intakes never appear', async () => {
      const res = await get(a, `${base(a)}/intake-packages`);
      expect(res.statusCode, res.body).toBe(200);
      const list = res.json().intakePackages as Array<Record<string, unknown>>;
      expect(list.map((r) => r.id)).toEqual([pendingA.intakeId, rejectedA.intakeId, finA.intakeId, novA.intakeId, octA.intakeId]);
      expect(list.find((r) => r.id === octA.intakeId)).toMatchObject({ businessId: a.businessId, boPublicationPackageId: octA.packageId, domain: 'inventory_supply', status: 'processed', rejectionReason: null, schemaVersion: '1.0' });
      expect(res.body).not.toContain(octB.intakeId);
    });
    it('filters by status and domain and pages with limit and offset', async () => {
      const status = (await get(a, `${base(a)}/intake-packages?status=rejected`)).json().intakePackages;
      expect(status.map((r: { id: string }) => r.id)).toEqual([rejectedA.intakeId]);
      expect((await get(a, `${base(a)}/intake-packages?status=validated`)).json().intakePackages.map((r: { id: string }) => r.id)).toEqual([pendingA.intakeId]);
      expect((await get(a, `${base(a)}/intake-packages?domain=financial`)).json().intakePackages.map((r: { id: string }) => r.id)).toEqual([finA.intakeId]);
      const p1 = (await get(a, `${base(a)}/intake-packages?limit=2&offset=0`)).json();
      const p2 = (await get(a, `${base(a)}/intake-packages?limit=2&offset=2`)).json();
      expect([...p1.intakePackages, ...p2.intakePackages].map((r: { id: string }) => r.id)).toEqual([pendingA.intakeId, rejectedA.intakeId, finA.intakeId, novA.intakeId]);
      expect(p1).toMatchObject({ limit: 2, offset: 0 });
    });
    it('a processed intake shows its status history, its BO provenance and the dataset version built from it', async () => {
      const res = await get(a, `${base(a)}/intake-packages/${octA.intakeId}`);
      expect(res.statusCode, res.body).toBe(200);
      const d = res.json();
      expect(d).toMatchObject({ id: octA.intakeId, status: 'processed', domain: 'inventory_supply', boPublicationPackageId: octA.packageId, correlationId: octA.correlationId });
      expect(d.statusHistory.map((h: { fromStatus: string | null; toStatus: string }) => `${h.fromStatus}>${h.toStatus}`)).toEqual(['null>received', 'received>validating', 'validating>validated', 'validated>processed']);
      expect(d.versions).toEqual([expect.objectContaining({ versionNumber: 1, recordCount: 42, payloadReference: { table: 'inventory_movements', rows: 42, complete: true }, qualityScore: null, completenessScore: null })]);
      expect(d.sourceReferences).toEqual([{ id: expect.any(String), sourceSystem: 'business_operations', boHandoffRecordId: octA.handoffId, packageCode: expect.stringMatching(/^pkg-/), handoffId: octA.handoffId, contractVersion: '1.0.0', recordedAt: expect.any(String) }]);
      expect(d.domainInputs).toEqual([{ domain: 'inventory_supply', status: 'mapped' }]);
      expect(d.datasetVersions).toEqual([{ datasetId: octA.dataset!.datasetId, datasetCode: 'bo-bi-16', datasetVersionId: octA.dataset!.datasetVersionId, versionNumber: 1 }]);
    });
    it('a rejected intake shows its reason and no dataset; a validated one has none yet', async () => {
      const rej = (await get(a, `${base(a)}/intake-packages/${rejectedA.intakeId}`)).json();
      expect(rej).toMatchObject({ status: 'rejected', rejectionReason: 'claimed_record_count_differs_from_bo', versions: [], sourceReferences: [], datasetVersions: [] });
      const pend = (await get(a, `${base(a)}/intake-packages/${pendingA.intakeId}`)).json();
      expect(pend).toMatchObject({ status: 'validated', datasetVersions: [], domainInputs: [{ domain: 'inventory_supply', status: 'pending' }] });
    });
  });

  describe('datasets', () => {
    it('lists the business datasets (one per BI block) with their latest version', async () => {
      const res = await get(a, `${base(a)}/datasets`);
      expect(res.statusCode, res.body).toBe(200);
      const list = res.json().datasets as Array<Record<string, unknown>>;
      expect(list.map((d) => [d.datasetCode, d.domain, d.latestVersion])).toEqual([['bo-bi-11', 'financial', 1], ['bo-bi-16', 'inventory_supply', 2]]);
      expect((await get(a, `${base(a)}/datasets?domain=financial`)).json().datasets).toHaveLength(1);
      expect(res.body).not.toContain(octB.dataset!.datasetId);
    });
    it('a dataset shows its versions newest first with period, schema reference, BO publication data reference, lineage and NULL scores', async () => {
      const res = await get(a, `${base(a)}/datasets/${octA.dataset!.datasetId}`);
      expect(res.statusCode, res.body).toBe(200);
      const d = res.json();
      expect(d).toMatchObject({ id: octA.dataset!.datasetId, datasetCode: 'bo-bi-16', domain: 'inventory_supply', status: 'active', latestVersion: 2 });
      expect(d.versions.map((v: { versionNumber: number }) => v.versionNumber)).toEqual([2, 1]);
      const v1 = d.versions[1];
      expect(v1).toMatchObject({ id: octA.dataset!.datasetVersionId, publicationStatus: 'published', effectiveStart: '2026-10-01T00:00:00.000Z', effectiveEnd: '2026-11-01T00:00:00.000Z', intakePackageId: octA.intakeId, qualityScore: null, completenessScore: null, correlationId: octA.correlationId });
      expect(v1.schemaReference).toEqual({ contract: 'bo-publication-reference/1', fields: [{ name: 'complete', type: 'boolean' }, { name: 'rows', type: 'number' }, { name: 'table', type: 'string' }] });
      expect(v1.dataReferences).toEqual([{ referenceType: 'bo_publication_package', recordCount: 42, reference: expect.objectContaining({ boPublicationPackageId: octA.packageId, targetBlock: 'BI-16', payloadReference: { table: 'inventory_movements', rows: 42, complete: true } }) }]);
      expect(v1.lineage).toEqual([{ lineageType: 'derived_from', sourceReferenceId: expect.any(String), parentDatasetVersionId: null }]);
      expect(d.versions[0]).toMatchObject({ effectiveStart: '2026-11-01T00:00:00.000Z', intakePackageId: novA.intakeId, dataReferences: [{ recordCount: 7 }] });
    });
    it('unassessed scores are null, never zero; once assessed they are returned exactly as stored', async () => {
      const w = await kit.world(); const x = await ingestAndMaterialize(admin, w);
      const before = (await get(w, `${base(w)}/datasets/${x.dataset!.datasetId}`)).json().versions[0];
      expect(before.qualityScore).toBeNull(); expect(before.completenessScore).toBeNull();
      const c = await admin.connect();   // a later assessment is not built yet: the stored value is set privately, as the append-only cleanup helpers do
      try { await c.query('BEGIN'); await c.query("SET LOCAL session_replication_role = 'replica'");
        await c.query('UPDATE business_intelligence.analytical_dataset_versions SET quality_score = 0.9125, completeness_score = 0 WHERE id = $1', [x.dataset!.datasetVersionId]); await c.query('COMMIT'); }
      finally { c.release(); }
      const after = (await get(w, `${base(w)}/datasets/${x.dataset!.datasetId}`)).json().versions[0];
      expect(after.qualityScore).toBe(0.9125);
      expect(after.completenessScore).toBe(0);      // a stored zero is a real zero, and is not confused with null
    });
    it('versionLimit bounds the versions returned (newest first)', async () => {
      const one = (await get(a, `${base(a)}/datasets/${octA.dataset!.datasetId}?versionLimit=1`)).json();
      expect(one.versions.map((v: { versionNumber: number }) => v.versionNumber)).toEqual([2]);
    });
  });

  describe('authorization', () => {
    const urls = (w: World) => [`${base(w)}/intake-packages`, `${base(w)}/intake-packages/${octA.intakeId}`, `${base(w)}/datasets`, `${base(w)}/datasets/${octA.dataset!.datasetId}`];
    it('401 without a session', async () => {
      for (const url of urls(a)) expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(401);
    });
    it('403 for a member without bi:read, including one who holds only bo:read and da:read; 200 with bi:read alone', async () => {
      const none = await memberWith([]); const other = await memberWith(['bo:read', 'da:read']); const only = await memberWith(['bi:read']);
      for (const url of urls(a)) {
        expect((await get(none, url)).statusCode, `none ${url}`).toBe(403);
        expect((await get(other, url)).statusCode, `other ${url}`).toBe(403);
        expect((await get(only, url)).statusCode, `bi:read ${url}`).toBe(200);
      }
      expect((await get(none, urls(a)[1])).body).not.toContain(octA.packageId);
    });
    it('there is no mutation surface: POST, PUT, PATCH and DELETE on every path are refused and change nothing', async () => {
      const counts = async () => JSON.stringify((await admin.query(
        `SELECT (SELECT count(*) FROM business_intelligence.intelligence_intake_packages WHERE business_id = $1)::int i, (SELECT count(*) FROM business_intelligence.analytical_dataset_versions WHERE business_id = $1)::int v,
                (SELECT count(*) FROM business_operations.bo_publication_packages WHERE business_id = $1)::int p`, [a.businessId])).rows[0]);
      const before = await counts();
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
        for (const url of urls(a)) {
          const res = await app.inject({ method, url, headers: kit.headers(a, { 'idempotency-key': unique('k') }), payload: {} });
          expect([404, 405], `${method} ${url} -> ${res.statusCode}`).toContain(res.statusCode);
        }
      }
      expect(await counts()).toBe(before);
    });
  });

  describe('isolation and enumeration', () => {
    it('another tenant cannot read this business at all (404), and learns nothing about its identifiers', async () => {
      for (const url of [`${base(a)}/intake-packages`, `${base(a)}/intake-packages/${octA.intakeId}`, `${base(a)}/datasets`, `${base(a)}/datasets/${octA.dataset!.datasetId}`]) {
        const res = await get(b, url);
        expect(res.statusCode, url).toBe(404);
        expect(res.body).not.toContain(octA.intakeId); expect(res.body).not.toContain(octA.packageId); expect(res.body).not.toContain('bo-bi-16');
      }
    });
    it('an identifier of another business or tenant is exactly as 404 as one that does not exist: same status and the same message', async () => {
      const norm = (body: string) => JSON.stringify({ ...JSON.parse(body).error, correlationId: 'x', message: JSON.parse(body).error.message.replace(/[0-9a-f-]{36}/g, '<id>') });
      const sibling = (await admin.query(`INSERT INTO platform.businesses (tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,'Sibling',$3,'active') RETURNING id`, [a.ctx.tenantId, a.ctx.workspaceId, unique('sib')])).rows[0].id as string;
      const probes: Array<[string, string]> = [
        ['intake', `intake-packages`], ['dataset', `datasets`],
      ];
      for (const [kind, path] of probes) {
        const ids = kind === 'intake' ? [octB.intakeId, octA.intakeId, randomUUID()] : [octB.dataset!.datasetId, octA.dataset!.datasetId, randomUUID()];
        // on THIS business: another tenant's id, and a random id
        const foreign = await get(a, `${base(a)}/${path}/${ids[0]}`); const random = await get(a, `${base(a)}/${path}/${ids[2]}`);
        expect([foreign.statusCode, random.statusCode], kind).toEqual([404, 404]);
        expect(norm(foreign.body), kind).toBe(norm(random.body));
        // on a SIBLING business of the same workspace: this business's id (it exists, in the workspace) is still a 404
        const viaSibling = await get(a, `/v1/businesses/${sibling}/bi/${path}/${ids[1]}`);
        expect(viaSibling.statusCode, kind).toBe(404);
        expect(norm(viaSibling.body), kind).toBe(norm(random.body));
      }
      // the sibling lists nothing of this business
      expect((await get(a, `/v1/businesses/${sibling}/bi/intake-packages`)).json().intakePackages).toEqual([]);
      expect((await get(a, `/v1/businesses/${sibling}/bi/datasets`)).json().datasets).toEqual([]);
    });
    it('tenant B sees only its own intake and dataset', async () => {
      const list = (await get(b, `${base(b)}/intake-packages`)).json().intakePackages;
      expect(list.map((r: { id: string }) => r.id)).toEqual([octB.intakeId]);
      expect((await get(b, `${base(b)}/datasets`)).json().datasets.map((d: { id: string }) => d.id)).toEqual([octB.dataset!.datasetId]);
    });
  });

  describe('malformed requests and no leakage', () => {
    it('400 for malformed identifiers, unknown query parameters, an unknown status or domain, and out-of-range paging; never a 500', async () => {
      const bad = [
        `${base(a)}/intake-packages/not-a-uuid`, `${base(a)}/datasets/123`, `/v1/businesses/not-a-uuid/bi/datasets`,
        `${base(a)}/intake-packages?status=bogus`, `${base(a)}/intake-packages?domain=bogus`, `${base(a)}/datasets?domain=bogus`,
        `${base(a)}/intake-packages?limit=0`, `${base(a)}/intake-packages?limit=101`, `${base(a)}/datasets?offset=-1`, `${base(a)}/datasets?limit=abc`,
        `${base(a)}/datasets?unknown=1`, `${base(a)}/intake-packages?tenantId=${b.ctx.tenantId}`, `${base(a)}/datasets/${octA.dataset!.datasetId}?versionLimit=0`, `${base(a)}/datasets/${octA.dataset!.datasetId}?versionLimit=101`,
      ];
      for (const url of bad) { const res = await get(a, url); expect(res.statusCode, url).toBe(400); }
    });
    it('responses carry no internal or scope fields: no tenant, workspace, idempotency key, causation, creator or raw source reference', async () => {
      const bodies = [
        (await get(a, `${base(a)}/intake-packages`)).body, (await get(a, `${base(a)}/intake-packages/${octA.intakeId}`)).body,
        (await get(a, `${base(a)}/datasets`)).body, (await get(a, `${base(a)}/datasets/${octA.dataset!.datasetId}`)).body,
      ];
      for (const body of bodies) {
        for (const forbidden of ['tenantId', 'workspaceId', 'tenant_id', 'workspace_id', 'idempotencyKey', 'idempotency_key', 'causationId', 'createdBy', 'created_by', 'source_reference', 'bo-to-bi:']) {
          expect(body, forbidden).not.toContain(forbidden);
        }
        expect(body).not.toContain(a.ctx.tenantId); expect(body).not.toContain(a.ctx.workspaceId);
      }
    });
    it('reading changes nothing: no BI or BO row is written by any GET', async () => {
      const fp = async () => JSON.stringify((await admin.query(
        `SELECT (SELECT count(*) FROM business_intelligence.intelligence_intake_packages WHERE tenant_id = $1)::int a, (SELECT count(*) FROM business_intelligence.intelligence_processing_status_history WHERE tenant_id = $1)::int b,
                (SELECT count(*) FROM business_intelligence.analytical_dataset_versions WHERE tenant_id = $1)::int c, (SELECT count(*) FROM business_operations.bo_handoff_records WHERE tenant_id = $1)::int d,
                (SELECT max(updated_at) FROM business_intelligence.intelligence_intake_packages WHERE tenant_id = $1) e`, [a.ctx.tenantId])).rows[0]);
      const before = await fp();
      for (const url of [`${base(a)}/intake-packages`, `${base(a)}/intake-packages/${octA.intakeId}`, `${base(a)}/datasets`, `${base(a)}/datasets/${octA.dataset!.datasetId}`]) await get(a, url);
      expect(await fp()).toBe(before);
    });
  });
});
