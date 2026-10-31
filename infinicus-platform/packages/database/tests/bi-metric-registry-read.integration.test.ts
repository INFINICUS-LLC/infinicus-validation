/**
 * BI-2-DEV-03-R2: BiMetricRegistryReadRepository tested DIRECTLY (no route guard in front of it), under the restricted application role with RLS forced.
 * Governed rows are written through the production write repository (BiMetricRegistryRepository) under the same application role; the administrator
 * connection is used only for fixtures that have no application path (tenants, workspaces, datasets, the soft-delete flag) and, in one clearly labelled
 * diagnostic, to prove that the data an isolation assertion relies on really exists. Every isolation assertion itself runs as the application role.
 * Requires DATABASE_URL (application role) and ADMIN_DATABASE_URL.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { BiMetricRegistryReadRepository, BiMetricRegistryRepository, MetricDefinitionRepository, getPool, withTenantTransaction, closePool, createPool, type TenantContext } from '../src/index.js';
import { addBusiness, createWorld, type World } from './helpers/financialFixtures.js';

const run = !!process.env.DATABASE_URL && !!process.env.ADMIN_DATABASE_URL;
const ctxOf = (w: { tenantId: string; workspaceId: string }): TenantContext => ({ tenantId: w.tenantId, workspaceId: w.workspaceId, userId: randomUUID() });
const upperCase = (id: string) => id.toUpperCase();

describe.runIf(run)('BiMetricRegistryReadRepository (direct, application role, RLS)', () => {
  let admin: Pool;
  const read = new BiMetricRegistryReadRepository();
  const write = new BiMetricRegistryRepository();
  let seq = 0;

  beforeAll(() => { createPool({ connectionString: process.env.DATABASE_URL! }); admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL }); });
  afterAll(async () => { await admin?.end(); await closePool(); });
  afterEach(() => { vi.restoreAllMocks(); });

  async function dataset(w: { tenantId: string; workspaceId: string; businessId: string }, domain = 'financial'): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO business_intelligence.analytical_datasets (id, tenant_id, workspace_id, business_id, dataset_code, domain, name, status) VALUES ($1,$2,$3,$4,$5,$6,'ds','active')`,
      [id, w.tenantId, w.workspaceId, w.businessId, `ds-${++seq}-${Date.now()}`, domain]);
    return id;
  }
  /** A governed metric written through the production write repository as the application role. */
  async function governed(w: { tenantId: string; workspaceId: string; businessId: string }, ds: string, code: string, extra: Record<string, unknown> = {}): Promise<string> {
    const metricId = randomUUID();
    const content = { name: code, code, description: '', metricType: 'base', warehouseDatasetId: ds, sourceField: null, aggregation: 'sum', dependencies: [], formula: null, filters: [], dimensions: [],
      timeGrain: 'month', unit: 'usd', currency: null, target: null, thresholds: {}, owner: '', governanceStatus: 'approved', status: 'active', version: 1, ...extra };
    await write.transaction(ctxOf(w), w.businessId, (tx) => tx.insertFirstVersion(
      { metricCode: code, domain: 'financial', metricType: 'base', name: code, description: '', unit: 'usd', currencyCode: null, status: 'active' },
      { metricId, versionNumber: 1, warehouseDatasetId: ds, content, contentHash: createHash('sha256').update(JSON.stringify(content)).digest('hex'), aggregationMethod: 'sum', timeGrain: 'month',
        dimensionalFilters: [], calculationSpecification: {}, correlationId: randomUUID() }));
    return metricId;
  }
  const page = { limit: 100, offset: 0 };
  const codesOf = (rows: Array<{ content: Record<string, unknown> }>) => rows.map((r) => r.content.code);

  interface Fixture { a: World; sib: World; foreign: World; ws2: { tenantId: string; workspaceId: string }; dsA: string; dsSib: string; dsForeign: string; mA: string; mSib: string; mForeign: string; legacy: string }
  async function fixture(): Promise<Fixture> {
    const a = await createWorld(admin, 'RegRead'); const sib = await addBusiness(admin, a); const foreign = await createWorld(admin, 'RegReadX');
    const ws2Id = randomUUID();
    await admin.query(`INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,'WS2',$3,'active')`, [ws2Id, a.tenantId, `ws2-${ws2Id}`]);
    const dsA = await dataset(a); const dsSib = await dataset(sib); const dsForeign = await dataset(foreign);
    const mA = await governed(a, dsA, 'alpha'); const mSib = await governed(sib, dsSib, 'alpha'); const mForeign = await governed(foreign, dsForeign, 'alpha');
    const legacy = (await new MetricDefinitionRepository().create(ctxOf(a), { businessId: a.businessId, metricCode: 'legacy_kpi', domain: 'financial', metricType: 'base', name: 'L', unit: 'usd', aggregationMethod: 'sum', timeGrain: 'month' })).definition.id;
    return { a, sib, foreign, ws2: { tenantId: a.tenantId, workspaceId: ws2Id }, dsA, dsSib, dsForeign, mA, mSib, mForeign, legacy };
  }

  let f: Fixture; let fSoft: Fixture;
  beforeAll(async () => { f = await fixture(); fSoft = await fixture(); }, 120_000);

  it('reads the caller\'s own business: list and detail in scope, with the domain of the metric\'s dataset', async () => {
    const rows = await read.list(ctxOf(f.a), f.a.businessId, {}, page);
    expect(rows.map((r) => r.metricId)).toEqual([f.mA]);
    expect(rows[0]).toMatchObject({ warehouseDatasetId: f.dsA, domain: 'financial', status: 'active', timeGrain: 'month', latestVersion: 1 });
    const detail = await read.get(ctxOf(f.a), f.a.businessId, f.mA, 20);
    expect(detail).toMatchObject({ metricId: f.mA, versions: [{ versionNumber: 1 }] });
  });

  it('a foreign TENANT cannot read the business or its metrics (list and detail): NotFoundError, identical to a business that does not exist', async () => {
    for (const call of [
      () => read.list(ctxOf(f.foreign), f.a.businessId, {}, page),
      () => read.get(ctxOf(f.foreign), f.a.businessId, f.mA, 20),
    ]) await expect(call()).rejects.toMatchObject({ name: 'NotFoundError' });
    const messageShape = async (fn: () => Promise<unknown>) => ((await fn().catch((e: unknown) => e)) as object).constructor.name;
    expect(await messageShape(() => read.list(ctxOf(f.foreign), f.a.businessId, {}, page))).toBe(await messageShape(() => read.list(ctxOf(f.foreign), randomUUID(), {}, page)));
  });

  it('a foreign WORKSPACE of the same tenant cannot read the business or its metrics', async () => {
    await expect(read.list(ctxOf(f.ws2), f.a.businessId, {}, page)).rejects.toMatchObject({ name: 'NotFoundError' });
    await expect(read.get(ctxOf(f.ws2), f.a.businessId, f.mA, 20)).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('a SIBLING business in the same workspace is isolated in both directions; the same metric code in two businesses never crosses', async () => {
    expect((await read.list(ctxOf(f.a), f.a.businessId, {}, page)).map((r) => r.metricId)).toEqual([f.mA]);
    expect((await read.list(ctxOf(f.a), f.sib.businessId, {}, page)).map((r) => r.metricId)).toEqual([f.mSib]);
    await expect(read.get(ctxOf(f.a), f.sib.businessId, f.mA, 20)).rejects.toMatchObject({ name: 'NotFoundError' });
    await expect(read.get(ctxOf(f.a), f.a.businessId, f.mSib, 20)).rejects.toMatchObject({ name: 'NotFoundError' });
    await expect(read.get(ctxOf(f.a), f.a.businessId, f.mForeign, 20)).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('a nonexistent metric id and an out-of-scope one fail identically (same error class and message shape, no existence signal)', async () => {
    const fail = async (id: string) => { try { await read.get(ctxOf(f.a), f.a.businessId, id, 20); return null; } catch (e) { return { name: (e as Error).name, shape: (e as Error).message.replace(id, '<id>') }; } };
    const kinds = await Promise.all([fail(randomUUID()), fail(f.mSib), fail(f.mForeign), fail(f.legacy)]);
    expect(kinds.every((k) => k !== null)).toBe(true);
    expect(new Set(kinds.map((k) => JSON.stringify(k))).size).toBe(1);
  });

  it('a dataset id of another business, workspace or tenant, or one that does not exist, filters to an empty list and reveals nothing', async () => {
    for (const ds of [f.dsSib, f.dsForeign, randomUUID()]) expect(await read.list(ctxOf(f.a), f.a.businessId, { datasetId: ds }, page)).toEqual([]);
    expect(codesOf(await read.list(ctxOf(f.a), f.a.businessId, { datasetId: f.dsA }, page))).toEqual(['alpha']);
  });

  it('a Stage 2D (ungoverned) definition is excluded from the list and is a plain NotFoundError in detail', async () => {
    expect(codesOf(await read.list(ctxOf(f.a), f.a.businessId, {}, page))).toEqual(['alpha']);
    await expect(read.get(ctxOf(f.a), f.a.businessId, f.legacy, 20)).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('a SOFT-DELETED business is excluded: list and detail refuse it exactly as a business that does not exist, and restoring it restores access', async () => {
    const f = fSoft;
    expect((await read.list(ctxOf(f.a), f.a.businessId, {}, page)).length).toBe(1);
    await admin.query(`UPDATE platform.businesses SET deleted_at = now() WHERE id = $1`, [f.a.businessId]);   // fixture: the platform's soft-delete marker
    await expect(read.list(ctxOf(f.a), f.a.businessId, {}, page)).rejects.toMatchObject({ name: 'NotFoundError' });
    await expect(read.get(ctxOf(f.a), f.a.businessId, f.mA, 20)).rejects.toMatchObject({ name: 'NotFoundError' });
    await admin.query(`UPDATE platform.businesses SET deleted_at = NULL WHERE id = $1`, [f.a.businessId]);
    expect((await read.list(ctxOf(f.a), f.a.businessId, {}, page)).length).toBe(1);
  });

  describe('identifier handling: either letter case resolves, malformed never reaches the database', () => {
    it('an upper-case business id, metric id and dataset filter resolve to the same rows as their lower-case forms, and the result carries only canonical lower-case ids', async () => {
      const lower = await read.list(ctxOf(f.a), f.a.businessId, { datasetId: f.dsA }, page);
      const upper = await read.list(ctxOf(f.a), upperCase(f.a.businessId), { datasetId: upperCase(f.dsA) }, page);
      expect(upper).toEqual(lower);
      expect(upper[0]!.metricId).toBe(f.mA); expect(upper[0]!.warehouseDatasetId).toBe(f.dsA);
      expect(await read.get(ctxOf(f.a), upperCase(f.a.businessId), upperCase(f.mA), 20)).toEqual(await read.get(ctxOf(f.a), f.a.businessId, f.mA, 20));
    });

    it('upper-case does not broaden anything: another scope\'s id in upper case is refused exactly like in lower case', async () => {
      await expect(read.get(ctxOf(f.a), f.a.businessId, upperCase(f.mSib), 20)).rejects.toMatchObject({ name: 'NotFoundError' });
      await expect(read.get(ctxOf(f.a), upperCase(f.sib.businessId), upperCase(f.mA), 20)).rejects.toMatchObject({ name: 'NotFoundError' });
      await expect(read.list(ctxOf(f.foreign), upperCase(f.a.businessId), {}, page)).rejects.toMatchObject({ name: 'NotFoundError' });
      expect(await read.list(ctxOf(f.a), f.a.businessId, { datasetId: upperCase(f.dsSib) }, page)).toEqual([]);
    });

    it('malformed identifiers are refused before any database access (no connection is even taken from the pool)', async () => {
      const connect = vi.spyOn(getPool(), 'connect'); const poolQuery = vi.spyOn(getPool(), 'query');
      const bad = ['', 'not-a-uuid', f.mA + '\n', ' ' + f.mA, `{${f.mA}}`, f.mA.replace(/-/g, ''), `urn:uuid:${f.mA}`, f.mA.slice(0, 35), f.mA + '0', "x' OR '1'='1", `${f.mA};`];
      for (const id of bad) {
        await expect(read.get(ctxOf(f.a), f.a.businessId, id, 20), `metric ${JSON.stringify(id)}`).rejects.toMatchObject({ name: 'NotFoundError' });
        await expect(read.get(ctxOf(f.a), id, f.mA, 20), `business ${JSON.stringify(id)}`).rejects.toMatchObject({ name: 'NotFoundError' });
        await expect(read.list(ctxOf(f.a), id, {}, page), `list business ${JSON.stringify(id)}`).rejects.toMatchObject({ name: 'NotFoundError' });
        await expect(read.list(ctxOf(f.a), f.a.businessId, { datasetId: id }, page), `dataset ${JSON.stringify(id)}`).rejects.toMatchObject({ name: 'ValidationError' });
      }
      expect(connect).not.toHaveBeenCalled(); expect(poolQuery).not.toHaveBeenCalled();
    });

    it('a well-formed id does reach the database (the spy would see it), so the zero above is a real signal', async () => {
      const connect = vi.spyOn(getPool(), 'connect');
      await read.list(ctxOf(f.a), f.a.businessId, {}, page);
      expect(connect).toHaveBeenCalled();
    });
  });

  describe('layer attribution (diagnostic): which layer isolates what', () => {
    /** The registry statement WITHOUT any explicit tenant, workspace or business predicate (everything else identical). */
    const NO_PREDICATES = `SELECT d.id AS metric_id, d.business_id
        FROM business_intelligence.metric_definitions d
        JOIN business_intelligence.metric_definition_versions v ON v.metric_definition_id = d.id AND v.version_number = d.latest_version
       WHERE v.definition_content IS NOT NULL`;

    it('RLS alone isolates TENANT and WORKSPACE (the application role sees only its own tenant\'s and workspace\'s rows with no explicit predicate), but does NOT isolate sibling businesses', async () => {
      const asApp = async (ctx: TenantContext) => (await withTenantTransaction(ctx, async (c) => c.query(NO_PREDICATES))).rows.map((r) => r.metric_id as string);
      const own = await asApp(ctxOf(f.a));
      expect(own).toContain(f.mA); expect(own).toContain(f.mSib);             // sibling business of the same workspace: RLS does not separate it
      expect(own).not.toContain(f.mForeign);                                   // other tenant: RLS separates it
      expect(await asApp(ctxOf(f.ws2))).toEqual([]);                            // other workspace of the same tenant: RLS separates it
      // data-presence check only (not an isolation assertion): the foreign rows exist, so the exclusions above are real
      const all = (await admin.query(`SELECT id FROM business_intelligence.metric_definitions WHERE id = ANY($1)`, [[f.mA, f.mSib, f.mForeign]])).rows.map((r) => r.id);
      expect(new Set(all)).toEqual(new Set([f.mA, f.mSib, f.mForeign]));
    });

    it('therefore business isolation inside a workspace is enforced by the repository\'s own business predicate, and the repository result proves it', async () => {
      expect((await read.list(ctxOf(f.a), f.a.businessId, {}, page)).map((r) => r.metricId)).toEqual([f.mA]);
      expect((await read.list(ctxOf(f.a), f.sib.businessId, {}, page)).map((r) => r.metricId)).toEqual([f.mSib]);
    });
  });

  it('the read repository changes nothing: definitions and versions are byte-identical after every call above', async () => {
    const snap = async () => JSON.stringify((await admin.query(
      `SELECT d.id, d.metric_code, d.status, d.latest_version, d.updated_at, v.version_number, v.content_hash, v.definition_content, v.created_at
         FROM business_intelligence.metric_definitions d LEFT JOIN business_intelligence.metric_definition_versions v ON v.metric_definition_id = d.id
        WHERE d.tenant_id = $1 ORDER BY d.id, v.version_number`, [f.a.tenantId])).rows);
    const before = await snap();
    await read.list(ctxOf(f.a), f.a.businessId, {}, page); await read.get(ctxOf(f.a), f.a.businessId, f.mA, 20); await read.get(ctxOf(f.a), upperCase(f.a.businessId), upperCase(f.mA), 20);
    await read.get(ctxOf(f.a), f.a.businessId, f.legacy, 20).catch(() => undefined); await read.list(ctxOf(f.foreign), f.a.businessId, {}, page).catch(() => undefined);
    expect(await snap()).toBe(before);
  });
});
