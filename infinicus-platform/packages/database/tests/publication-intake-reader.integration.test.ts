/**
 * V-07 residual: Data Acquisition owns the READ of its published package, submissions and provenance for a receiving layer. This suite pins the
 * DAL-owned PublicationIntakeReader that Business Operations now calls instead of running its own SQL on data_acquisition tables: it returns exactly
 * what the receiving layer needs, locks the package, is tenant-scoped by RLS, and writes nothing.
 * Requires DATABASE_URL (app role, RLS enforced) and ADMIN_DATABASE_URL (fixtures).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { PublicationIntakeReader } from '../src/repositories/da/PublicationIntakeReader.js';
import { withTenantTransaction } from '../src/client.js';
import { setupIntegration, teardownIntegration, ctx1, ctx2, T1, WS1 } from './helpers/integration.js';

const RUN = !!process.env.DATABASE_URL;
const DA = 'data_acquisition';

describe.runIf(RUN)('PublicationIntakeReader: Data Acquisition owns the read path of a delivery (V-07 residual)', () => {
  const reader = new PublicationIntakeReader();
  let admin: Pool;
  const owned: Array<[string, string]> = [];
  let source: string; let run: string; let otherRun: string; let pkg: string; let emptyPkg: string;
  let sub1: string; let sub2: string; let prov1: string;

  const ins = async (table: string, cols: string, vals: unknown[]): Promise<string> => {
    const ph = vals.map((_, i) => `$${i + 1}`).join(',');
    const r = await admin.query(`INSERT INTO ${DA}.${table} (${cols}) VALUES (${ph}) RETURNING id`, vals);
    owned.unshift([table, r.rows[0].id]);
    return r.rows[0].id as string;
  };
  const counts = async () => Object.fromEntries(await Promise.all(['publication_packages', 'manual_submissions', 'provenance_records', 'publication_deliveries'].map(
    async (t) => [t, Number((await admin.query(`SELECT count(*)::int n FROM ${DA}.${t}`)).rows[0].n)] as const)));

  beforeAll(async () => {
    await setupIntegration();
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });
    source = await ins('data_sources', 'tenant_id,workspace_id,name,source_code,source_type', [T1, WS1, 'reader src', `rd-${randomUUID().slice(0, 8)}`, 'manual']);
    run = await ins('collection_runs', 'tenant_id,workspace_id,data_source_id,collection_type', [T1, WS1, source, 'manual']);
    otherRun = await ins('collection_runs', 'tenant_id,workspace_id,data_source_id,collection_type', [T1, WS1, source, 'manual']);
    pkg = await ins('publication_packages', 'tenant_id,workspace_id,package_type,target_layer,target_block,status,published_at,record_count,data_reference',
      [T1, WS1, 'operations_data', 'business_operations', 'BO-1', 'published', new Date(), 2, JSON.stringify({ collectionRunId: run })]);
    emptyPkg = await ins('publication_packages', 'tenant_id,workspace_id,package_type,target_layer,target_block,status,published_at,record_count',
      [T1, WS1, 'operations_data', 'business_operations', 'BO-1', 'published', new Date(), 0]);
    sub1 = await ins('manual_submissions', 'tenant_id,workspace_id,data_source_id,collection_run_id,submission_type,payload,created_at',
      [T1, WS1, source, run, 'records', JSON.stringify({ records: [{ a: 1 }] }), new Date(Date.now() - 2000)]);
    sub2 = await ins('manual_submissions', 'tenant_id,workspace_id,data_source_id,collection_run_id,submission_type,payload,created_at',
      [T1, WS1, source, run, 'records', JSON.stringify({ records: [{ b: 2 }] }), new Date(Date.now() - 1000)]);
    await ins('manual_submissions', 'tenant_id,workspace_id,data_source_id,collection_run_id,submission_type,payload',
      [T1, WS1, source, otherRun, 'records', JSON.stringify({ records: [] })]);
    prov1 = await ins('provenance_records', 'tenant_id,workspace_id,data_source_id,collection_run_id,record_reference,source_reference', [T1, WS1, source, run, `${sub1}#0`, 'src']);
    await ins('provenance_records', 'tenant_id,workspace_id,data_source_id,collection_run_id,record_reference,source_reference', [T1, WS1, source, otherRun, 'other#0', 'src']);
  });
  afterAll(async () => {
    for (const [table, rowId] of owned) await admin.query(`DELETE FROM ${DA}.${table} WHERE id = $1`, [rowId]).catch(() => undefined);
    await admin.end();
    await teardownIntegration();
  });

  it('returns the facts a receiving layer re-checks, and the data reference as stored', async () => {
    const found = await withTenantTransaction(ctx1, (c) => reader.lockPackageOn(c, pkg));
    expect(found).toEqual({
      tenantId: T1, workspaceId: WS1, businessId: null, status: 'published', targetLayer: 'business_operations', recordCount: 2, dataReference: { collectionRunId: run },
    });
  });

  it('returns null for an unknown package and for a package of another tenant (RLS), never the row', async () => {
    expect(await withTenantTransaction(ctx1, (c) => reader.lockPackageOn(c, randomUUID()))).toBeNull();
    expect(await withTenantTransaction(ctx2, (c) => reader.lockPackageOn(c, pkg))).toBeNull();
  });

  it('LOCKS the package for the caller transaction: a second transaction cannot take it until the first ends', async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((ok) => { release = ok; });
    const first = withTenantTransaction(ctx1, async (c) => { await reader.lockPackageOn(c, emptyPkg); order.push('first-locked'); await gate; order.push('first-done'); });
    await new Promise((r) => setTimeout(r, 300));
    const second = withTenantTransaction(ctx1, async (c) => { await reader.lockPackageOn(c, emptyPkg); order.push('second-locked'); });
    await new Promise((r) => setTimeout(r, 400));
    expect(order).toEqual(['first-locked']);          // the second is still waiting on the row lock
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['first-locked', 'first-done', 'second-locked']);
  });

  it('a package with no data reference returns an empty object reference, not an error', async () => {
    const found = await withTenantTransaction(ctx1, (c) => reader.lockPackageOn(c, emptyPkg));
    expect(found?.recordCount).toBe(0);
    expect(found?.dataReference).toEqual({});
  });

  it('lists the submissions of one collection run oldest first, with their payloads, and none of another run', async () => {
    const subs = await withTenantTransaction(ctx1, (c) => reader.submissionsForCollectionRunOn(c, run));
    expect(subs.map((s) => s.id)).toEqual([sub1, sub2]);
    expect(subs[0].payload).toEqual({ records: [{ a: 1 }] });
    expect(await withTenantTransaction(ctx1, (c) => reader.submissionsForCollectionRunOn(c, randomUUID()))).toEqual([]);
  });

  it('lists the provenance of one collection run by record reference, and none of another run', async () => {
    const prov = await withTenantTransaction(ctx1, (c) => reader.provenanceForCollectionRunOn(c, run));
    expect(prov).toEqual([{ id: prov1, recordReference: `${sub1}#0` }]);
  });

  it('another tenant sees none of the submissions or provenance (RLS)', async () => {
    expect(await withTenantTransaction(ctx2, (c) => reader.submissionsForCollectionRunOn(c, run))).toEqual([]);
    expect(await withTenantTransaction(ctx2, (c) => reader.provenanceForCollectionRunOn(c, run))).toEqual([]);
  });

  it('reads only: no row is added, changed or removed in any Data Acquisition table it touches', async () => {
    const before = await counts();
    const snap = (await admin.query(`SELECT status, record_count, updated_at FROM ${DA}.publication_packages WHERE id = $1`, [pkg])).rows[0];
    await withTenantTransaction(ctx1, async (c) => {
      await reader.lockPackageOn(c, pkg);
      await reader.submissionsForCollectionRunOn(c, run);
      await reader.provenanceForCollectionRunOn(c, run);
    });
    expect(await counts()).toEqual(before);
    expect((await admin.query(`SELECT status, record_count, updated_at FROM ${DA}.publication_packages WHERE id = $1`, [pkg])).rows[0]).toEqual(snap);
  });
});
