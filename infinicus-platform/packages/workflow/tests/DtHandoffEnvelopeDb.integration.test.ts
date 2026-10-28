/**
 * NEW-BDT-SIM-01.SEC-01 (D2) migration 0221 against live PostgreSQL: the database itself enforces persist-before-publication, scope integrity, append-only
 * evidence and tenant isolation. Each rule is proven twice where it matters: as the application role (RLS applies) and as the RLS-bypassing fixture admin (the
 * triggers alone must hold). Requires DATABASE_URL (application role) and ADMIN_DATABASE_URL (fixtures).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { createPool, closePool, DTHandoffEnvelopeRepository, DTPublicationPackageRepository, TwinConfidenceScoreRepository, type TenantContext } from '@infinicus/database';
import { BusinessPerformanceTwinService } from '../src/performance/BusinessPerformanceTwinService.js';
import { addBusiness, createWorld, type World } from '../../database/tests/helpers/financialFixtures.js';
import { truncateRefusal } from '../../database/tests/helpers/truncateRefusal.js';
import { PERIOD, readersFor } from './helpers/performanceFixtures.js';

const run = !!process.env.DATABASE_URL && !!process.env.ADMIN_DATABASE_URL;
const ctxOf = (w: World): TenantContext => ({ tenantId: w.tenantId, workspaceId: w.workspaceId, userId: '00000000-0000-4000-8000-000000000001' });
const DIGEST = 'a'.repeat(64);

describe.runIf(run)('migration 0221: dt_handoff_envelopes (live PostgreSQL)', () => {
  let admin: Pool;
  const packages = new DTPublicationPackageRepository(); const scores = new TwinConfidenceScoreRepository(); const envelopes = new DTHandoffEnvelopeRepository();
  beforeAll(() => { createPool({ connectionString: process.env.DATABASE_URL! }); admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL }); });
  afterAll(async () => { await admin?.end(); await closePool(); });

  /** A world with a published twin state, a DRAFT performance package, a confidence score and a valid envelope body - everything but the envelope row. */
  async function fixture(key = 'bdt-performance-sim') {
    const w = await createWorld(admin, 'Env');
    const twin = new BusinessPerformanceTwinService({ ...readersFor(w.businessId), now: () => new Date('2026-11-02T10:00:00.000Z') });
    const out = await twin.publish(ctxOf(w), { businessId: w.businessId, ...PERIOD });
    if (out.outcome !== 'PUBLISHED') throw new Error(JSON.stringify(out));
    const ctx = ctxOf(w);
    const insight = await packages.createInsightPackage(ctx, w.businessId, `env-${randomUUID().slice(0, 8)}`);
    const version = await packages.createVersion(ctx, insight.id, w.businessId, 'fixture', { snapshotVersionId: out.snapshotVersionId });
    const idem = `${key}:${out.snapshotVersionId}`;
    const { package: pkg } = await packages.createPackage(ctx, w.businessId, version.id, 'simulation', 'SIM-01', idem);
    const score = await scores.record(ctx, { businessId: w.businessId, instanceId: out.instanceId, snapshotVersionId: out.snapshotVersionId, confidence: 0.8125, basis: '{"kind":"twin-confidence"}' });
    const body = (over: Record<string, unknown> = {}, payload: Record<string, unknown> = {}) => ({
      handoffId: pkg.id, sourceLayer: 'DT', targetLayer: 'SIM', status: 'ready',
      payload: { tenantId: w.tenantId, workspaceId: w.workspaceId, businessId: w.businessId, idempotencyKey: idem, contractVersion: '1.0.0', ...payload }, ...over,
    });
    const input = (over: Record<string, unknown> = {}) => ({
      businessId: w.businessId, dtPublicationPackageId: pkg.id, snapshotVersionId: out.snapshotVersionId, confidenceScoreId: score.id, contractVersion: '1.0.0', schemaVersion: 'dt-to-sim-performance-handoff/1',
      correlationId: randomUUID(), causationId: out.snapshotVersionId, envelope: body(), envelopeDigest: DIGEST, sourceEvidenceDigest: DIGEST, sourceRevalidatedAt: new Date(), ...over,
    });
    return { w, ctx, out, pkg, score, body, input, idem };
  }

  it('records an envelope for a draft package; a performance package may then become ready and dispatched', async () => {
    const f = await fixture();
    const rec = await envelopes.record(f.ctx, f.input());
    expect(rec).toMatchObject({ dtPublicationPackageId: f.pkg.id, envelopeDigest: DIGEST, contractVersion: '1.0.0' });
    expect((await packages.markReady(f.ctx, f.pkg.id)).publicationStatus).toBe('ready');
    expect((await packages.dispatch(f.ctx, f.pkg.id)).publicationStatus).toBe('dispatched');
    expect(await envelopes.getByPackage(f.ctx, f.w.businessId, f.pkg.id)).toMatchObject({ id: rec.id });
  });

  it('PERSIST BEFORE PUBLICATION: a performance hand-off package cannot become ready or dispatched without its envelope - as the application role and as the admin', async () => {
    const f = await fixture();
    await expect(packages.markReady(f.ctx, f.pkg.id)).rejects.toThrow(/before its envelope is persisted/);
    await expect(admin.query(`UPDATE business_digital_twin.dt_publication_packages SET publication_status = 'ready' WHERE id = $1`, [f.pkg.id])).rejects.toThrow(/before its envelope is persisted/);
    await expect(admin.query(`UPDATE business_digital_twin.dt_publication_packages SET publication_status = 'dispatched' WHERE id = $1`, [f.pkg.id])).rejects.toThrow();
    expect((await admin.query('SELECT publication_status FROM business_digital_twin.dt_publication_packages WHERE id = $1', [f.pkg.id])).rows[0].publication_status).toBe('draft');
  });

  it('other DT -> SIM packages (a different idempotency key) are unaffected: they still become ready without an envelope', async () => {
    const f = await fixture('some-other-producer');
    expect((await packages.markReady(f.ctx, f.pkg.id)).publicationStatus).toBe('ready');
  });

  it('an envelope can only be recorded while the package is still a draft', async () => {
    const f = await fixture('some-other-producer');          // ready without an envelope is allowed for this producer ...
    await packages.markReady(f.ctx, f.pkg.id);
    await expect(envelopes.record(f.ctx, f.input())).rejects.toThrow(/still a draft/);        // ... but its envelope can no longer be added after the fact
  });

  it('one envelope per package', async () => {
    const f = await fixture(); await envelopes.record(f.ctx, f.input());
    await expect(envelopes.record(f.ctx, f.input())).rejects.toMatchObject({ code: '23505' });
  });

  it('cross-tenant, cross-workspace and cross-business references are refused (as the app role the foreign rows are invisible; as the admin the trigger itself refuses)', async () => {
    const a = await fixture(); const b = await fixture();
    await expect(envelopes.record(b.ctx, { ...b.input(), dtPublicationPackageId: a.pkg.id })).rejects.toThrow();               // RLS: A's package does not exist for tenant B
    const adminInsert = (over: Record<string, unknown>, scope: { tenantId: string; workspaceId: string; businessId: string }) => admin.query(
      `INSERT INTO business_digital_twin.dt_handoff_envelopes (tenant_id, workspace_id, business_id, dt_publication_package_id, snapshot_version_id, confidence_score_id, contract_version, schema_version, correlation_id, causation_id, envelope, envelope_digest, source_evidence_digest, source_revalidated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'1.0.0','s',$7,$8,$9::jsonb,$10,$10,now())`,
      [scope.tenantId, scope.workspaceId, scope.businessId, over.pkg ?? b.pkg.id, over.sv ?? b.out.snapshotVersionId, over.score ?? b.score.id, randomUUID(), randomUUID(), JSON.stringify(over.envelope ?? b.body()), DIGEST]);
    const own = { tenantId: b.w.tenantId, workspaceId: b.w.workspaceId, businessId: b.w.businessId };
    await expect(adminInsert({ pkg: a.pkg.id }, own)).rejects.toThrow(/package of its own tenant, workspace and business/);       // A's package under B's scope
    await expect(adminInsert({ sv: a.out.snapshotVersionId }, own)).rejects.toThrow(/snapshot version of its own/);
    await expect(adminInsert({ score: a.score.id }, own)).rejects.toThrow(/confidence score of its own scope/);
    await expect(adminInsert({}, { ...own, tenantId: a.w.tenantId })).rejects.toThrow();                                           // B's package claiming A's tenant
    const sib = await addBusiness(admin, b.w);
    await expect(adminInsert({}, { ...own, businessId: sib.businessId })).rejects.toThrow(/package of its own tenant, workspace and business/);   // a sibling business
  });

  it('the confidence score must be of the same snapshot version', async () => {
    const f = await fixture();
    const other = await scores.record(f.ctx, { businessId: f.w.businessId, instanceId: f.out.instanceId, snapshotVersionId: f.out.snapshotVersionId, confidence: 0.9, basis: '{}' });
    expect(other.id).not.toBe(f.score.id);
    const g = await fixture();
    await expect(envelopes.record(g.ctx, { ...g.input(), confidenceScoreId: f.score.id })).rejects.toThrow();                     // another tenant's score is invisible
    const scoreOfOtherVersion = await admin.query(`INSERT INTO business_digital_twin.twin_confidence_scores (tenant_id, workspace_id, business_id, instance_id, snapshot_version_id, confidence, basis) VALUES ($1,$2,$3,$4,NULL,0.8,'x') RETURNING id`, [f.w.tenantId, f.w.workspaceId, f.w.businessId, f.out.instanceId]);
    await expect(envelopes.record(f.ctx, { ...f.input(), confidenceScoreId: scoreOfOtherVersion.rows[0].id })).rejects.toThrow(/confidence score of its own scope and snapshot version/);
  });

  it('the envelope content must agree with the row: scope, hand-off id, idempotency key, contract version and layers', async () => {
    const f = await fixture();
    const attempts: Record<string, unknown>[] = [
      f.body({}, { tenantId: randomUUID() }), f.body({}, { workspaceId: randomUUID() }), f.body({}, { businessId: randomUUID() }), f.body({ handoffId: randomUUID() }),
      f.body({}, { idempotencyKey: 'bdt-performance-sim:other' }), f.body({}, { contractVersion: '2.0.0' }), f.body({ sourceLayer: 'BI' }), f.body({ targetLayer: 'ADI' }),
    ];
    for (const envelope of attempts) await expect(envelopes.record(f.ctx, f.input({ envelope })), JSON.stringify(envelope)).rejects.toThrow(/disagrees with its recorded scope/);
    expect(await envelopes.getByPackage(f.ctx, f.w.businessId, f.pkg.id)).toBeNull();
  });

  it('is append-only: update, delete and truncate are refused, even for the admin', async () => {
    const f = await fixture(); await envelopes.record(f.ctx, f.input());
    await expect(admin.query(`UPDATE business_digital_twin.dt_handoff_envelopes SET envelope_digest = $1 WHERE business_id = $2`, ['b'.repeat(64), f.w.businessId])).rejects.toThrow(/append-only/);
    await expect(admin.query('DELETE FROM business_digital_twin.dt_handoff_envelopes WHERE business_id = $1', [f.w.businessId])).rejects.toThrow(/append-only/);
    await expect(truncateRefusal(admin, 'TRUNCATE business_digital_twin.dt_handoff_envelopes')).rejects.toThrow(/append-only/);        // via the shared helper: a bare TRUNCATE could convoy other test files
    expect(await envelopes.getByPackage(f.ctx, f.w.businessId, f.pkg.id)).not.toBeNull();
  });

  it('is tenant-isolated and fails closed: another tenant sees nothing, and a session with no tenant context sees nothing', async () => {
    const f = await fixture(); const other = await createWorld(admin, 'Other'); await envelopes.record(f.ctx, f.input());
    expect(await envelopes.getByPackage(ctxOf(other), f.w.businessId, f.pkg.id)).toBeNull();
    expect(await envelopes.getByPackage({ tenantId: randomUUID(), workspaceId: randomUUID(), userId: f.ctx.userId }, f.w.businessId, f.pkg.id)).toBeNull();
    const flags = await admin.query(`SELECT c.relrowsecurity, c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'business_digital_twin' AND c.relname = 'dt_handoff_envelopes'`);
    expect(flags.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it('the migration is registered and forward-only; the triggers exist', async () => {
    expect((await admin.query(`SELECT 1 FROM _migrations WHERE filename = '0221_create_dt_handoff_envelopes.sql'`)).rowCount).toBe(1);
    const t = await admin.query(`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN ('business_digital_twin.dt_handoff_envelopes'::regclass, 'business_digital_twin.dt_publication_packages'::regclass) ORDER BY tgname`);
    expect(t.rows.map((r) => r.tgname)).toEqual(expect.arrayContaining(['check_handoff_envelope_scope_trg', 'forbid_mutation_dt_handoff_envelopes', 'forbid_truncate_dt_handoff_envelopes', 'require_handoff_envelope_before_ready', 'enforce_publication_transition']));
  });
});
