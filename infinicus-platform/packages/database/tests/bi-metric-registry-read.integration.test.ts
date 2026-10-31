/**
 * BI-2-DEV-03-R2: BiMetricRegistryReadRepository tested DIRECTLY (no route guard in front of it), under the restricted application role with RLS forced.
 * Governed rows are written through the production write repository (BiMetricRegistryRepository) under the same application role; the administrator
 * connection is used only for fixtures that have no application path (tenants, workspaces, datasets, the soft-delete flag) and, in one clearly labelled
 * diagnostic, to prove that the data an isolation assertion relies on really exists. Every isolation assertion itself runs as the application role.
 * Requires DATABASE_URL (application role) and ADMIN_DATABASE_URL.
 *
 * WHICH LAYER ENFORCES WHAT, AND WHAT THE EVIDENCE IS (do not read more into these tests than this):
 *   tenant, workspace   RLS (behavioral: see the RLS diagnostic) AND explicit predicates (textual guard only; no test here separates the two)
 *   business            the repository's explicit predicate ALONE (behavioral: RLS does not separate sibling businesses)
 *   soft-deleted business  the repository's own filter AND the route guard (the direct tests below prove the repository's contribution)
 *   identifier shape    the repository's own validation AND the API schema (the direct tests prove the repository's contribution)
 *   pagination bounds   the repository's own validation AND the API schema (the direct tests prove the repository's contribution)
 *   governed only       the version/dataset join AND an explicit filter (the filter is guarded textually only)
 * Separating an explicit tenant or workspace predicate from RLS would need a connection that bypasses RLS or a way to run the repository's statement
 * elsewhere; neither is done here (no RLS bypass), so that boundary stays UNVERIFIED behaviorally.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { BiMetricRegistryReadRepository, BiMetricRegistryRepository, METRIC_READ_BOUNDS, MetricDefinitionRepository, getPool, withTenantTransaction, closePool, createPool, type TenantContext } from '../src/index.js';
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

  /** What a caller can observe about a refusal: class, name, enumerable fields, and the message with every id the CALLER SUPPLIED masked (their own input may be echoed). */
  async function refusal(fn: () => Promise<unknown>, supplied: string[]) {
    try { await fn(); return null; } catch (e) {
      const err = e as Error; let message = err.message;
      for (const id of supplied) message = message.split(new RegExp(id, 'i')).join('<id>');
      return { ctor: err.constructor.name, name: err.name, fields: Object.keys(err).sort(), message };
    }
  }
  const DB_DETAIL = /business_intelligence|platform\.|tenancy\.|metric_definition|analytical_dataset|SELECT |INSERT |UPDATE |relation |violates|constraint|row-level|policy|permission denied|ECONN|password|pg_|syntax/i;

  it('a foreign TENANT cannot read the business or its metrics (list and detail): NotFoundError', async () => {
    for (const call of [
      () => read.list(ctxOf(f.foreign), f.a.businessId, {}, page),
      () => read.get(ctxOf(f.foreign), f.a.businessId, f.mA, 20),
    ]) await expect(call()).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('every refusal is indistinguishable and leaks nothing: foreign tenant, foreign workspace and a nonexistent business give the same class, name, fields and message shape; nonexistent, sibling, foreign-tenant and Stage 2D metrics give the same one', async () => {
    const randomBiz = randomUUID(); const randomMetric = randomUUID();
    // business-level refusals (list and detail), each with the business id the caller supplied masked
    const businessCases = await Promise.all([
      refusal(() => read.list(ctxOf(f.foreign), f.a.businessId, {}, page), [f.a.businessId]),
      refusal(() => read.get(ctxOf(f.foreign), f.a.businessId, f.mA, 20), [f.a.businessId]),
      refusal(() => read.list(ctxOf(f.ws2), f.a.businessId, {}, page), [f.a.businessId]),
      refusal(() => read.get(ctxOf(f.ws2), f.a.businessId, f.mA, 20), [f.a.businessId]),
      refusal(() => read.list(ctxOf(f.a), randomBiz, {}, page), [randomBiz]),
      refusal(() => read.get(ctxOf(f.a), randomBiz, f.mA, 20), [randomBiz]),
    ]);
    expect(new Set(businessCases.map((c) => JSON.stringify(c))).size).toBe(1);
    // the platform's error classes set `name` as their one own field; a database error would carry code, detail, table, constraint and more
    expect(businessCases[0]).toEqual({ ctor: 'NotFoundError', name: 'NotFoundError', fields: ['name'], message: 'Business not found: <id>' });
    // metric-level refusals inside the caller's own business
    const metricCases = await Promise.all([randomMetric, f.mSib, f.mForeign, f.legacy].map((id) => refusal(() => read.get(ctxOf(f.a), f.a.businessId, id, 20), [id])));
    expect(new Set(metricCases.map((c) => JSON.stringify(c))).size).toBe(1);
    expect(metricCases[0]).toEqual({ ctor: 'NotFoundError', name: 'NotFoundError', fields: ['name'], message: 'MetricDefinition not found: <id>' });
    // a foreign or nonexistent dataset filter is not a refusal at all: both are the same empty list
    expect(await read.list(ctxOf(f.a), f.a.businessId, { datasetId: f.dsForeign }, page)).toEqual(await read.list(ctxOf(f.a), f.a.businessId, { datasetId: randomUUID() }, page));
    // no internal identifier of any party appears, and no database detail
    const everyone = [f.a.tenantId, f.a.workspaceId, f.foreign.tenantId, f.foreign.workspaceId, f.ws2.workspaceId, f.foreign.businessId, f.sib.businessId, f.mA, f.mSib, f.mForeign, f.legacy, f.dsA, f.dsSib, f.dsForeign];
    const raw = async (fn: () => Promise<unknown>) => { try { await fn(); return ''; } catch (e) { return `${(e as Error).message} ${JSON.stringify(e)} ${String(e)}`; } };
    const texts = await Promise.all([
      raw(() => read.list(ctxOf(f.foreign), f.a.businessId, {}, page)), raw(() => read.get(ctxOf(f.ws2), f.a.businessId, f.mA, 20)), raw(() => read.get(ctxOf(f.a), f.a.businessId, f.mForeign, 20)),
      raw(() => read.get(ctxOf(f.a), f.a.businessId, f.legacy, 20)),
    ]);
    const supplied = [f.a.businessId, f.a.businessId, f.mForeign, f.legacy];
    texts.forEach((t, i) => {
      expect(t, `refusal ${i}`).not.toMatch(DB_DETAIL);
      for (const id of everyone.filter((x) => x !== supplied[i])) expect(t.toLowerCase(), `refusal ${i} must not contain ${id}`).not.toContain(id.toLowerCase());
    });
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

  describe('RLS diagnostic (does NOT execute the repository\'s own statements)', () => {
    /**
     * LIMITATION, stated plainly: this diagnostic runs a SEPARATE statement that has the repository's joins but no tenant, workspace or business predicate.
     * It shows what row-level security alone does to such a statement under the application role. It cannot show that the repository's explicit tenant or
     * workspace predicates work (RLS would mask their absence), and it is not the repository's query path; the repository's behavior is asserted by the direct
     * tests elsewhere in this file. The fragments below are checked against the repository source so the diagnostic cannot silently drift from its joins.
     */
    const FROM_DEFINITIONS = 'FROM business_intelligence.metric_definitions d';
    const JOIN_LATEST_VERSION = 'JOIN business_intelligence.metric_definition_versions v ON v.metric_definition_id = d.id AND v.version_number = d.latest_version';
    const GOVERNED_ONLY = 'v.definition_content IS NOT NULL';
    const NO_PREDICATES = `SELECT d.id AS metric_id, d.business_id ${FROM_DEFINITIONS} ${JOIN_LATEST_VERSION} WHERE ${GOVERNED_ONLY}`;
    const flat = (text: string) => text.replace(/\s+/g, ' ').trim();

    it('drift detector: every join and filter fragment of the diagnostic statement appears verbatim in the repository\'s source, and the diagnostic has no predicate the repository lacks', () => {
      const source = flat(readFileSync(resolve(__dirname, '..', 'src', 'repositories', 'bi', 'BiMetricRegistryReadRepository.ts'), 'utf8'));
      // a fragment must be followed by a clause boundary (AND / JOIN / WHERE / ORDER, the end of the statement, or a closing parenthesis), so appended logic cannot hide behind it
      const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      for (const fragment of [FROM_DEFINITIONS, JOIN_LATEST_VERSION, GOVERNED_ONLY]) {
        expect(source, fragment).toMatch(new RegExp(`${escape(fragment)}\\s*(?:AND\\b|JOIN\\b|WHERE\\b|ORDER\\b|\`|\\))`));
      }
      expect(NO_PREDICATES).not.toMatch(/tenant_id|workspace_id|business_id\s*=|deleted_at/);
    });

    it('RLS alone isolates TENANT and WORKSPACE on these tables (the application role sees only its own tenant\'s and workspace\'s rows with no explicit predicate), but does NOT isolate sibling businesses', async () => {
      const asApp = async (ctx: TenantContext) => (await withTenantTransaction(ctx, async (c) => c.query(NO_PREDICATES))).rows.map((r) => r.metric_id as string);
      const own = await asApp(ctxOf(f.a));
      expect(own).toContain(f.mA); expect(own).toContain(f.mSib);             // sibling business of the same workspace: RLS does not separate it
      expect(own).not.toContain(f.mForeign);                                   // other tenant: RLS separates it
      expect(await asApp(ctxOf(f.ws2))).toEqual([]);                            // other workspace of the same tenant: RLS separates it
      // data-presence check only (not an isolation assertion): the foreign rows exist, so the exclusions above are real
      const all = (await admin.query(`SELECT id FROM business_intelligence.metric_definitions WHERE id = ANY($1)`, [[f.mA, f.mSib, f.mForeign]])).rows.map((r) => r.id);
      expect(new Set(all)).toEqual(new Set([f.mA, f.mSib, f.mForeign]));
    });

    it('so business isolation inside a workspace is enforced by the repository\'s own business predicate alone, and the repository\'s real query path proves it', async () => {
      expect((await read.list(ctxOf(f.a), f.a.businessId, {}, page)).map((r) => r.metricId)).toEqual([f.mA]);
      expect((await read.list(ctxOf(f.a), f.sib.businessId, {}, page)).map((r) => r.metricId)).toEqual([f.mSib]);
    });
  });

  describe('pagination bounds are enforced by the repository itself, before any connection', () => {
    const LIMIT_MSG = `limit must be an integer from ${METRIC_READ_BOUNDS.minLimit} to ${METRIC_READ_BOUNDS.maxLimit}`;
    const OFFSET_MSG = `offset must be an integer from ${METRIC_READ_BOUNDS.minOffset} to ${METRIC_READ_BOUNDS.maxOffset}`;
    const VERSION_MSG = `versionLimit must be an integer from ${METRIC_READ_BOUNDS.minVersionLimit} to ${METRIC_READ_BOUNDS.maxVersionLimit}`;
    // values chosen so that none of them appears inside the fixed message, which lets "never echoes the value" be asserted exactly
    const invalid = (min: number, max: number): unknown[] => [min - 1, max + 1, 7.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.MAX_SAFE_INTEGER, -987654, '7', '', null, undefined, true, 7n, {}, []];

    it('limit: zero, negative, over 100, fractional, NaN, infinite, huge, numeric text and non-numbers are refused with a fixed message and never reach the pool', async () => {
      const connect = vi.spyOn(getPool(), 'connect'); const poolQuery = vi.spyOn(getPool(), 'query');
      for (const v of invalid(METRIC_READ_BOUNDS.minLimit, METRIC_READ_BOUNDS.maxLimit)) {
        const err = await read.list(ctxOf(f.a), f.a.businessId, {}, { limit: v as number, offset: 0 }).then(() => null, (e: Error) => e);
        expect(err, `limit ${String(v)}`).toMatchObject({ name: 'ValidationError' });
        expect(err!.message, `limit ${String(v)}`).toBe(`MetricPage invalid: ${LIMIT_MSG}`);
      }
      expect(connect).not.toHaveBeenCalled(); expect(poolQuery).not.toHaveBeenCalled();
    });

    it('offset: negative, over 100000, fractional, NaN, infinite, huge, numeric text and non-numbers are refused with a fixed message and never reach the pool', async () => {
      const connect = vi.spyOn(getPool(), 'connect'); const poolQuery = vi.spyOn(getPool(), 'query');
      for (const v of invalid(METRIC_READ_BOUNDS.minOffset, METRIC_READ_BOUNDS.maxOffset)) {
        const err = await read.list(ctxOf(f.a), f.a.businessId, {}, { limit: 20, offset: v as number }).then(() => null, (e: Error) => e);
        expect(err, `offset ${String(v)}`).toMatchObject({ name: 'ValidationError' });
        expect(err!.message, `offset ${String(v)}`).toBe(`MetricPage invalid: ${OFFSET_MSG}`);
      }
      expect(connect).not.toHaveBeenCalled(); expect(poolQuery).not.toHaveBeenCalled();
    });

    it('versionLimit: zero, negative, over 100, fractional, NaN, infinite, huge, numeric text and non-numbers are refused with a fixed message and never reach the pool', async () => {
      const connect = vi.spyOn(getPool(), 'connect'); const poolQuery = vi.spyOn(getPool(), 'query');
      for (const v of invalid(METRIC_READ_BOUNDS.minVersionLimit, METRIC_READ_BOUNDS.maxVersionLimit)) {
        const err = await read.get(ctxOf(f.a), f.a.businessId, f.mA, v as number).then(() => null, (e: Error) => e);
        expect(err, `versionLimit ${String(v)}`).toMatchObject({ name: 'ValidationError' });
        expect(err!.message, `versionLimit ${String(v)}`).toBe(`MetricDetailQuery invalid: ${VERSION_MSG}`);
      }
      expect(connect).not.toHaveBeenCalled(); expect(poolQuery).not.toHaveBeenCalled();
    });

    it('a missing page object is a ValidationError, not a TypeError, and invalid pagination is refused even for a caller who would be refused anyway (no database is consulted first)', async () => {
      const connect = vi.spyOn(getPool(), 'connect');
      await expect(read.list(ctxOf(f.a), f.a.businessId, {}, undefined as never)).rejects.toMatchObject({ name: 'ValidationError' });
      await expect(read.list(ctxOf(f.foreign), f.a.businessId, {}, { limit: 0, offset: 0 })).rejects.toMatchObject({ name: 'ValidationError' });
      await expect(read.get(ctxOf(f.foreign), f.a.businessId, f.mA, 0)).rejects.toMatchObject({ name: 'ValidationError' });
      expect(connect).not.toHaveBeenCalled();
    });

    it('the bounds themselves are accepted and behave as before (control: these requests do use the pool), and a page past the end is empty, not an error', async () => {
      const connect = vi.spyOn(getPool(), 'connect');
      for (const limit of [METRIC_READ_BOUNDS.minLimit, METRIC_READ_BOUNDS.maxLimit]) expect((await read.list(ctxOf(f.a), f.a.businessId, {}, { limit, offset: 0 })).length).toBe(1);
      expect(await read.list(ctxOf(f.a), f.a.businessId, {}, { limit: 20, offset: METRIC_READ_BOUNDS.maxOffset })).toEqual([]);
      for (const versionLimit of [METRIC_READ_BOUNDS.minVersionLimit, METRIC_READ_BOUNDS.maxVersionLimit]) expect((await read.get(ctxOf(f.a), f.a.businessId, f.mA, versionLimit)).versions.length).toBe(1);
      expect(connect).toHaveBeenCalled();
    });

    it('invalid pagination changes nothing: no row is written and the response of a valid call is identical before and after', async () => {
      const before = await read.list(ctxOf(f.a), f.a.businessId, {}, page);
      await read.list(ctxOf(f.a), f.a.businessId, {}, { limit: 0, offset: -1 }).catch(() => undefined);
      expect(await read.list(ctxOf(f.a), f.a.businessId, {}, page)).toEqual(before);
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
