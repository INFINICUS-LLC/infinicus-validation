/**
 * NEW-BDT-SIM-01: PerformanceSimulationHandoffService against live PostgreSQL under the application role (RLS enforced). The BI readers are stubs returning real
 * BI report objects; the twin state is published through the real BusinessPerformanceTwinService. Proves: the baseline / insight version / dispatched publication
 * package lifecycle, every input stored, the frozen DT -> SIM contract satisfied, idempotent replay (also under a concurrent race), fail-closed refusals that persist
 * nothing, atomic rollback, tenant and business isolation, and that Simulation, BO and BI tables are never written. Requires DATABASE_URL and ADMIN_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createPool, closePool, DTPublicationPackageRepository, ScenarioBaselineRepository, type TenantContext } from '@infinicus/database';
import { validateDTToSIMHandoff } from '@infinicus/handoff-contracts';
import { BusinessPerformanceTwinService } from '../src/performance/BusinessPerformanceTwinService.js';
import { PerformanceSimulationHandoffService } from '../src/performance/PerformanceSimulationHandoffService.js';
import { addBusiness, createWorld, type World } from '../../database/tests/helpers/financialFixtures.js';
import { financialFor, PERIOD, readersFor, salesFor } from './helpers/performanceFixtures.js';

const run = !!process.env.DATABASE_URL && !!process.env.ADMIN_DATABASE_URL;
const ctxOf = (w: World): TenantContext => ({ tenantId: w.tenantId, workspaceId: w.workspaceId, userId: '00000000-0000-4000-8000-000000000001' });
const NOW = new Date('2026-11-02T10:00:00.000Z');

describe.runIf(run)('PerformanceSimulationHandoffService (live PostgreSQL, application role)', () => {
  let admin: Pool;
  beforeAll(() => { createPool({ connectionString: process.env.DATABASE_URL! }); admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL }); });
  afterAll(async () => { await admin?.end(); await closePool(); });

  const world = async () => createWorld(admin, 'BdtSim');
  const twinFor = (w: World, o: Parameters<typeof readersFor>[1] = {}) => new BusinessPerformanceTwinService({ ...readersFor(w.businessId, o), now: () => NOW });
  const publishTwin = async (w: World, o: Parameters<typeof readersFor>[1] = {}) => {
    const twin = twinFor(w, o); const out = await twin.publish(ctxOf(w), { businessId: w.businessId, ...PERIOD });
    if (out.outcome !== 'PUBLISHED') throw new Error(JSON.stringify(out));
    return { twin, out };
  };
  const svcFor = (twin: BusinessPerformanceTwinService, extra: Partial<ConstructorParameters<typeof PerformanceSimulationHandoffService>[0]> = {}) =>
    new PerformanceSimulationHandoffService({ twin, now: () => new Date(NOW.getTime() + 90_000), ...extra });
  const n = async (sql: string, p: unknown[]) => Number((await admin.query(sql, p)).rows[0].n);
  const dtRows = async (w: World) => ({
    baselines: await n('SELECT count(*) n FROM business_digital_twin.scenario_baselines WHERE business_id = $1', [w.businessId]),
    packages: await n('SELECT count(*) n FROM business_digital_twin.dt_publication_packages WHERE business_id = $1', [w.businessId]),
    insight: await n('SELECT count(*) n FROM business_digital_twin.dt_insight_packages WHERE business_id = $1', [w.businessId]),
  });
  const NONE = { baselines: 0, packages: 0, insight: 0 };

  it('hands off the published state: a published baseline holding every variable, a DISPATCHED simulation package, and a hand-off that satisfies the frozen contract', async () => {
    const w = await world(); const { twin, out } = await publishTwin(w);
    const res = await svcFor(twin).handOff(ctxOf(w), { businessId: w.businessId, ...PERIOD });
    if (res.outcome !== 'HANDED_OFF' || res.replay) throw new Error(JSON.stringify(res));
    expect(res.snapshotId).toBe(out.snapshotId);
    expect(validateDTToSIMHandoff(res.handoff)).toEqual({ valid: true, reasons: [] });
    expect(res.handoff).toMatchObject({ sourceLayer: 'DT', targetLayer: 'SIM', status: 'ready', handoffId: res.publicationPackageId });
    expect(res.handoff.payload).toMatchObject({ businessId: w.businessId, tenantId: w.tenantId, workspaceId: w.workspaceId, snapshotId: out.snapshotId, scenarioBaselineId: res.scenarioBaselineId, constraints: [], uncertaintyAssignments: [], quality: { confidence: 1, freshnessSeconds: 90 } });
    expect(res.handoff.payload.variables.find((v) => v.variableCode === 'financial.USD.revenue')).toEqual({ variableCode: 'financial.USD.revenue', value: '150.00', unit: 'USD' });

    const baseline = (await admin.query('SELECT status, snapshot_version_id, baseline_code FROM business_digital_twin.scenario_baselines WHERE id = $1', [res.scenarioBaselineId])).rows[0];
    expect(baseline.status).toBe('published'); expect(baseline.snapshot_version_id).toBe(out.snapshotVersionId); expect(baseline.baseline_code).toBe(`perf-${out.snapshotVersionId}`);
    const inputs = (await admin.query('SELECT input_value FROM business_digital_twin.scenario_baseline_inputs WHERE scenario_baseline_version_id = $1', [res.scenarioBaselineVersionId])).rows.map((r) => r.input_value);
    expect(inputs).toHaveLength(res.handoff.payload.variables.length);
    expect(inputs.map((i) => i.variableCode).sort()).toEqual(res.handoff.payload.variables.map((v) => v.variableCode));
    const pkg = (await admin.query('SELECT publication_status, target_layer, target_block, idempotency_key FROM business_digital_twin.dt_publication_packages WHERE id = $1', [res.publicationPackageId])).rows[0];
    expect(pkg).toEqual({ publication_status: 'dispatched', target_layer: 'simulation', target_block: 'SIM-01', idempotency_key: `bdt-performance-sim:${out.snapshotVersionId}` });
    const ver = (await admin.query('SELECT snapshot_version_id, scenario_baseline_version_id FROM business_digital_twin.dt_insight_package_versions WHERE business_id = $1', [w.businessId])).rows;
    expect(ver).toEqual([{ snapshot_version_id: out.snapshotVersionId, scenario_baseline_version_id: res.scenarioBaselineVersionId }]);
    expect(await dtRows(w)).toEqual({ baselines: 1, packages: 1, insight: 1 });
  });

  it('is idempotent: a repeat replays the existing dispatched package and creates nothing', async () => {
    const w = await world(); const { twin } = await publishTwin(w); const svc = svcFor(twin);
    const first = await svc.handOff(ctxOf(w), { businessId: w.businessId, ...PERIOD });
    const again = await svc.handOff(ctxOf(w), { businessId: w.businessId, ...PERIOD });
    if (first.outcome !== 'HANDED_OFF' || again.outcome !== 'HANDED_OFF') throw new Error('x');
    expect(again).toEqual({ outcome: 'HANDED_OFF', replay: true, publicationPackageId: first.publicationPackageId, publicationStatus: 'dispatched', snapshotId: first.snapshotId });
    expect(await dtRows(w)).toEqual({ baselines: 1, packages: 1, insight: 1 });
  });

  it('a replay does not even attempt to create: no baseline, input or package write is made', async () => {
    const w = await world(); const { twin } = await publishTwin(w);
    await svcFor(twin).handOff(ctxOf(w), { businessId: w.businessId, ...PERIOD });
    const calls: string[] = [];
    const real = new ScenarioBaselineRepository();
    const spy = { createBaseline: async (...a: Parameters<ScenarioBaselineRepository['createBaseline']>) => { calls.push('createBaseline'); return real.createBaseline(...a); }, addInput: real.addInput.bind(real), validateBaseline: real.validateBaseline.bind(real), publishBaseline: real.publishBaseline.bind(real) };
    expect(await svcFor(twin, { baselines: spy }).handOff(ctxOf(w), { businessId: w.businessId, ...PERIOD })).toMatchObject({ outcome: 'HANDED_OFF', replay: true });
    expect(calls).toEqual([]);
  });

  it('the replay lookup is scoped to the business and the tenant: the same key is invisible to a sibling business and to another tenant', async () => {
    const w = await world(); const sib = await addBusiness(admin, w); const other = await world(); const { twin, out } = await publishTwin(w);
    await svcFor(twin).handOff(ctxOf(w), { businessId: w.businessId, ...PERIOD });
    const key = `bdt-performance-sim:${out.snapshotVersionId}`; const repo = new DTPublicationPackageRepository();
    expect(await repo.getByIdempotencyKey(ctxOf(w), w.businessId, key)).toMatchObject({ publicationStatus: 'dispatched' });
    expect(await repo.getByIdempotencyKey(ctxOf(w), sib.businessId, key)).toBeNull();
    expect(await repo.getByIdempotencyKey(ctxOf(other), w.businessId, key)).toBeNull();
  });

  it('concurrent identical hand-offs produce exactly one package (the database uniqueness decides; the loser replays)', async () => {
    const w = await world(); const { twin } = await publishTwin(w); const svc = svcFor(twin);
    const results = await Promise.all(Array.from({ length: 4 }, () => svc.handOff(ctxOf(w), { businessId: w.businessId, ...PERIOD })));
    expect(results.every((r) => r.outcome === 'HANDED_OFF')).toBe(true);
    expect(results.filter((r) => r.outcome === 'HANDED_OFF' && !r.replay)).toHaveLength(1);
    expect(new Set(results.map((r) => (r.outcome === 'HANDED_OFF' ? r.publicationPackageId : ''))).size).toBe(1);
    expect(await dtRows(w)).toEqual({ baselines: 1, packages: 1, insight: 1 });
  });

  it('a newer published twin state is a different hand-off (its own snapshot version, baseline and package); the older one is untouched', async () => {
    const w = await world(); const { twin } = await publishTwin(w);
    const first = await svcFor(twin).handOff(ctxOf(w), { businessId: w.businessId, ...PERIOD });
    const later = new BusinessPerformanceTwinService({ ...readersFor(w.businessId), now: () => new Date(NOW.getTime() + 60_000) });
    await later.publish(ctxOf(w), { businessId: w.businessId, ...PERIOD });
    const second = await svcFor(later).handOff(ctxOf(w), { businessId: w.businessId, ...PERIOD });
    if (first.outcome !== 'HANDED_OFF' || second.outcome !== 'HANDED_OFF' || first.replay || second.replay) throw new Error('x');
    expect(second.publicationPackageId).not.toBe(first.publicationPackageId);
    expect(await dtRows(w)).toEqual({ baselines: 2, packages: 2, insight: 2 });
  });

  it('refuses and persists NOTHING when there is no twin state, the state is partial, the state was tampered with, or the request is invalid', async () => {
    const w = await world();
    const empty = svcFor(twinFor(w));
    expect(await empty.handOff(ctxOf(w), { businessId: w.businessId, ...PERIOD })).toMatchObject({ outcome: 'NOT_HANDED_OFF', code: 'TWIN_STATE_MISSING' });
    for (const bad of [{ businessId: 'nope', ...PERIOD }, { businessId: w.businessId, from: '2026-02-30', to: '2026-03-10' }, { businessId: w.businessId, from: '2026-11-01', to: '2026-10-01' }, { businessId: w.businessId, from: '2025-01-01', to: '2026-12-31' }]) {
      expect(await empty.handOff(ctxOf(w), bad), JSON.stringify(bad)).toMatchObject({ outcome: 'NOT_HANDED_OFF', code: 'INVALID_REQUEST' });
    }
    const partial = await world();
    const { twin: partialTwin } = await publishTwin(partial, { fin: () => ({ outcome: 'UNAVAILABLE', code: 'FACTS_UNAVAILABLE', detail: 'down' }) });
    expect(await svcFor(partialTwin).handOff(ctxOf(partial), { businessId: partial.businessId, ...PERIOD })).toMatchObject({ outcome: 'NOT_HANDED_OFF', code: 'NOT_SIMULATION_READY' });
    const tampered = await world(); const { twin: tamperedTwin, out } = await publishTwin(tampered);
    const row = await admin.query('SELECT id, value_json FROM business_digital_twin.digital_twin_snapshot_values WHERE snapshot_version_id = $1', [out.snapshotVersionId]);
    const doctored = row.rows[0].value_json; doctored.evidence.sales.currencies[1].netMinor = 1;
    await admin.query('ALTER TABLE business_digital_twin.digital_twin_snapshot_values DISABLE TRIGGER USER');
    try { await admin.query('UPDATE business_digital_twin.digital_twin_snapshot_values SET value_json = $2 WHERE id = $1', [row.rows[0].id, doctored]); }
    finally { await admin.query('ALTER TABLE business_digital_twin.digital_twin_snapshot_values ENABLE TRIGGER USER'); }
    expect(await svcFor(tamperedTwin).handOff(ctxOf(tampered), { businessId: tampered.businessId, ...PERIOD })).toMatchObject({ outcome: 'NOT_HANDED_OFF', code: 'TWIN_STATE_INTEGRITY_FAILED' });
    for (const x of [w, partial, tampered]) expect(await dtRows(x)).toEqual(NONE);
  });

  it('is atomic: a failure part-way through rolls back the baseline, the inputs and the package (nothing half-built is visible)', async () => {
    const w = await world(); const { twin } = await publishTwin(w);
    const real = new ScenarioBaselineRepository();
    let added = 0;
    const flaky = {
      createBaseline: real.createBaseline.bind(real), validateBaseline: real.validateBaseline.bind(real), publishBaseline: real.publishBaseline.bind(real),
      addInput: async (...a: Parameters<ScenarioBaselineRepository['addInput']>) => { if (++added === 5) throw new Error('boom'); return real.addInput(...a); },
    };
    await expect(svcFor(twin, { baselines: flaky }).handOff(ctxOf(w), { businessId: w.businessId, ...PERIOD })).rejects.toThrow('boom');
    expect(await dtRows(w)).toEqual(NONE);
    expect(await n('SELECT count(*) n FROM business_digital_twin.scenario_baseline_inputs WHERE business_id = $1', [w.businessId])).toBe(0);
    const ok = await svcFor(twin).handOff(ctxOf(w), { businessId: w.businessId, ...PERIOD });      // and a clean retry still works
    expect(ok).toMatchObject({ outcome: 'HANDED_OFF', replay: false });
  });

  it('a hand-off that violates the frozen DT -> SIM contract is refused BEFORE anything is persisted (HANDOFF_INVALID)', async () => {
    const w = await world(); const { twin } = await publishTwin(w);
    const badTime = { getLatest: async (...a: Parameters<typeof twin.getLatest>) => { const l = await twin.getLatest(...a); return l && { ...l, effectiveAt: 'not-a-date' }; } };
    const calls: string[] = []; const real = new ScenarioBaselineRepository();
    const spy = { createBaseline: async (...a: Parameters<ScenarioBaselineRepository['createBaseline']>) => { calls.push('createBaseline'); return real.createBaseline(...a); }, addInput: real.addInput.bind(real), validateBaseline: real.validateBaseline.bind(real), publishBaseline: real.publishBaseline.bind(real) };
    const res = await svcFor(badTime as unknown as BusinessPerformanceTwinService, { baselines: spy }).handOff(ctxOf(w), { businessId: w.businessId, ...PERIOD });
    expect(res).toMatchObject({ outcome: 'NOT_HANDED_OFF', code: 'HANDOFF_INVALID', detail: expect.stringContaining('effective_at_invalid') });
    expect(calls).toEqual([]);                      // rejected before any write was even attempted
    expect(await dtRows(w)).toEqual(NONE);
  });

  it('a hand-off found invalid only AFTER the ids exist rolls the whole transaction back (nothing half-built), and a clean retry succeeds', async () => {
    const w = await world(); const { twin } = await publishTwin(w);
    const real = new ScenarioBaselineRepository();
    const blankCorrelation = {
      createBaseline: async (...a: Parameters<ScenarioBaselineRepository['createBaseline']>) => { const r = await real.createBaseline(...a); return { ...r, version: { ...r.version, correlationId: '' } }; },
      addInput: real.addInput.bind(real), validateBaseline: real.validateBaseline.bind(real), publishBaseline: real.publishBaseline.bind(real),
    };
    const res = await svcFor(twin, { baselines: blankCorrelation }).handOff(ctxOf(w), { businessId: w.businessId, ...PERIOD });
    expect(res).toMatchObject({ outcome: 'NOT_HANDED_OFF', code: 'HANDOFF_INVALID', detail: expect.stringContaining('correlationId_required') });
    expect(await dtRows(w)).toEqual(NONE);
    expect(await svcFor(twin).handOff(ctxOf(w), { businessId: w.businessId, ...PERIOD })).toMatchObject({ outcome: 'HANDED_OFF', replay: false });
  });

  it('isolates tenants and businesses: another tenant or a sibling business cannot hand off or see this business\'s state', async () => {
    const w = await world(); const sib = await addBusiness(admin, w); const other = await world();
    const { twin } = await publishTwin(w);
    const svc = svcFor(twin);
    expect(await svc.handOff(ctxOf(w), { businessId: sib.businessId, ...PERIOD })).toMatchObject({ code: 'TWIN_STATE_MISSING' });
    expect(await svc.handOff(ctxOf(other), { businessId: w.businessId, ...PERIOD })).toMatchObject({ code: 'TWIN_STATE_MISSING' });
    expect(await dtRows(sib)).toEqual(NONE); expect(await dtRows(other)).toEqual(NONE);
    const mine = await svc.handOff(ctxOf(w), { businessId: w.businessId, ...PERIOD });
    if (mine.outcome !== 'HANDED_OFF' || mine.replay) throw new Error('x');
    expect(mine.handoff.payload.businessId).toBe(w.businessId);
    expect(await svc.handOff(ctxOf(other), { businessId: w.businessId, ...PERIOD })).toMatchObject({ code: 'TWIN_STATE_MISSING' });   // no replay leak either
  });

  it('writes only Digital Twin tables: Simulation intake, orders, BO and BI rows are unchanged', async () => {
    const w = await world(); const { twin } = await publishTwin(w);
    const tables = ['simulation.simulation_intake_packages', 'platform.orders', 'business_operations.expense_items', 'business_intelligence.insight_packages', 'business_intelligence.metric_calculated_values'];
    const snap = async () => Promise.all(tables.map((t) => n(`SELECT count(*)::int n FROM ${t} WHERE tenant_id = $1`, [w.tenantId])));
    const before = await snap();
    await svcFor(twin).handOff(ctxOf(w), { businessId: w.businessId, ...PERIOD });
    expect(await snap()).toEqual(before);
    expect(before[0]).toBe(0);
  });
});
