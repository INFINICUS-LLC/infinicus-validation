/**
 * NEW-BDT-SIM-01 + SEC-01: PerformanceSimulationHandoffService against live PostgreSQL under the application role (RLS enforced). The BI readers are stubs returning
 * real BI report objects; the twin state is published through the real BusinessPerformanceTwinService; the Twin Confidence policy is a TEST DOUBLE (no methodology is
 * ratified). Proves: default deny, the confidence gate, persist-before-publication with reconstruction from the database, source revalidation (also on replay), the
 * baseline / insight / dispatched-package lifecycle, idempotent replay and races, atomic rollback, isolation, and that only Digital Twin tables are written.
 * Requires DATABASE_URL and ADMIN_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createPool, closePool, DTHandoffEnvelopeRepository, DTPublicationPackageRepository, ScenarioBaselineRepository, TwinConfidenceScoreRepository, type TenantContext } from '@infinicus/database';
import { validateDTToSIMHandoff, type FinancialFacts } from '@infinicus/handoff-contracts';
import { BusinessPerformanceTwinService } from '../src/performance/BusinessPerformanceTwinService.js';
import { PerformanceSimulationHandoffService } from '../src/performance/PerformanceSimulationHandoffService.js';
import { verifyPersistedHandoff } from '../src/performance/handoffEnvelope.js';
import { DT_TO_SIM_MIN_CONFIDENCE } from '../src/performance/twinConfidencePolicy.js';
import { addBusiness, createWorld, type World } from '../../database/tests/helpers/financialFixtures.js';
import { financialFor, PERIOD, readersFor, salesFor, testAssessment, testConfidencePolicy } from './helpers/performanceFixtures.js';

const run = !!process.env.DATABASE_URL && !!process.env.ADMIN_DATABASE_URL;
const ctxOf = (w: World): TenantContext => ({ tenantId: w.tenantId, workspaceId: w.workspaceId, userId: '00000000-0000-4000-8000-000000000001' });
const NOW = new Date('2026-11-02T10:00:00.000Z');
const LATER = new Date(NOW.getTime() + 90_000);

describe.runIf(run)('PerformanceSimulationHandoffService (live PostgreSQL, application role)', () => {
  let admin: Pool;
  beforeAll(() => { createPool({ connectionString: process.env.DATABASE_URL! }); admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL }); });
  afterAll(async () => { await admin?.end(); await closePool(); });

  const world = async () => createWorld(admin, 'BdtSim');
  /** Readers whose BI answers can be changed AFTER the twin state was published (the source of a stale hand-off). */
  function mutable(w: World) {
    const state: { fin: () => ReturnType<typeof financialFor>; sales: () => ReturnType<typeof salesFor> } = { fin: () => financialFor(w.businessId), sales: () => salesFor(w.businessId) };
    return { state, readers: readersFor(w.businessId, { fin: () => state.fin(), sales: () => state.sales() }) };
  }
  const publishTwin = async (w: World) => {
    const m = mutable(w);
    const twin = new BusinessPerformanceTwinService({ ...m.readers, now: () => NOW });
    const out = await twin.publish(ctxOf(w), { businessId: w.businessId, ...PERIOD });
    if (out.outcome !== 'PUBLISHED') throw new Error(JSON.stringify(out));
    return { twin, out, m };
  };
  type Extra = Partial<ConstructorParameters<typeof PerformanceSimulationHandoffService>[0]>;
  const svcFor = (twin: BusinessPerformanceTwinService, extra: Extra = {}) =>
    new PerformanceSimulationHandoffService({ twin, confidence: testConfidencePolicy(), now: () => LATER, ...extra });
  const req = (w: World) => ({ businessId: w.businessId, ...PERIOD });
  const n = async (sql: string, p: unknown[]) => Number((await admin.query(sql, p)).rows[0].n);
  const rows = async (w: World) => ({
    baselines: await n('SELECT count(*) n FROM business_digital_twin.scenario_baselines WHERE business_id = $1', [w.businessId]),
    packages: await n('SELECT count(*) n FROM business_digital_twin.dt_publication_packages WHERE business_id = $1', [w.businessId]),
    insight: await n('SELECT count(*) n FROM business_digital_twin.dt_insight_packages WHERE business_id = $1', [w.businessId]),
    scores: await n('SELECT count(*) n FROM business_digital_twin.twin_confidence_scores WHERE business_id = $1', [w.businessId]),
    envelopes: await n('SELECT count(*) n FROM business_digital_twin.dt_handoff_envelopes WHERE business_id = $1', [w.businessId]),
  });
  const NONE = { baselines: 0, packages: 0, insight: 0, scores: 0, envelopes: 0 };
  const ONE = { baselines: 1, packages: 1, insight: 1, scores: 1, envelopes: 1 };

  it('D2: hands off the published state AND persists the complete envelope, which is reconstructed from the database and independently verified', async () => {
    const w = await world(); const { twin, out } = await publishTwin(w);
    const res = await svcFor(twin).handOff(ctxOf(w), req(w));
    if (res.outcome !== 'HANDED_OFF' || res.replay) throw new Error(JSON.stringify(res));
    expect(validateDTToSIMHandoff(res.handoff)).toEqual({ valid: true, reasons: [] });
    expect(res.handoff.payload.quality).toEqual({ confidence: 0.8125, freshnessSeconds: 90 });
    expect(res.handoff.payload.quality.confidence).not.toBe(1);

    const record = await new DTHandoffEnvelopeRepository().getByPackage(ctxOf(w), w.businessId, res.publicationPackageId);
    const score = await new TwinConfidenceScoreRepository().getById(ctxOf(w), res.confidenceScoreId);
    expect(record).not.toBeNull();
    expect(record).toMatchObject({
      envelopeDigest: res.envelopeDigest, snapshotVersionId: out.snapshotVersionId, confidenceScoreId: res.confidenceScoreId, contractVersion: '1.0.0', schemaVersion: 'dt-to-sim-performance-handoff/1',
      causationId: out.snapshotVersionId, correlationId: res.handoff.correlationId, sourceEvidenceDigest: out.state.evidence.evidenceDigest, sourceRevalidatedAt: LATER,
    });
    expect(record!.envelope).toEqual(JSON.parse(JSON.stringify(res.handoff)));                       // the database holds exactly what was returned
    expect(verifyPersistedHandoff(record!, score, { tenantId: w.tenantId, workspaceId: w.workspaceId, businessId: w.businessId })).toEqual({ valid: true, reasons: [] });
    expect(score).toMatchObject({ confidence: 0.8125, snapshotVersionId: out.snapshotVersionId, instanceId: out.instanceId });
    expect(JSON.parse(score!.basis)).toMatchObject({ kind: 'twin-confidence', score: 0.8125, methodology: { id: 'TEST-ONLY-NOT-A-METHODOLOGY' } });
    expect(JSON.parse(score!.basis).factors).toHaveLength(7);
    const pkg = (await admin.query('SELECT publication_status, target_layer, idempotency_key FROM business_digital_twin.dt_publication_packages WHERE id = $1', [res.publicationPackageId])).rows[0];
    expect(pkg).toEqual({ publication_status: 'dispatched', target_layer: 'simulation', idempotency_key: `bdt-performance-sim:${out.snapshotVersionId}` });
    expect((await admin.query('SELECT status FROM business_digital_twin.scenario_baselines WHERE id = $1', [res.scenarioBaselineId])).rows[0].status).toBe('published');
    const inputs = await n('SELECT count(*) n FROM business_digital_twin.scenario_baseline_inputs WHERE scenario_baseline_version_id = $1', [res.scenarioBaselineVersionId]);
    expect(inputs).toBe(res.handoff.payload.variables.length);
    expect(await rows(w)).toEqual(ONE);
  });

  it('D1 default deny: without a ratified Twin Confidence methodology (the production policy) nothing is handed off or persisted', async () => {
    const w = await world(); const { twin } = await publishTwin(w);
    const closed = new PerformanceSimulationHandoffService({ twin, now: () => LATER });         // the DEFAULT policy
    expect(await closed.handOff(ctxOf(w), req(w))).toMatchObject({ outcome: 'NOT_HANDED_OFF', code: 'CONFIDENCE_UNAVAILABLE', detail: expect.stringContaining('no Twin Confidence methodology has been ratified') });
    expect(await rows(w)).toEqual(NONE);
  });

  it('D1 gate: below-threshold, unsupported and incomplete-basis confidence is refused and persists nothing; the threshold cannot be lowered', async () => {
    const w = await world(); const { twin } = await publishTwin(w);
    const base = testAssessment(0.9);
    if (base.status !== 'ASSESSED') throw new Error('x');
    const cases: [string, ReturnType<typeof testAssessment>, string][] = [
      ['just below 0.75', testAssessment(0.7499), 'CONFIDENCE_BELOW_THRESHOLD'], ['a score above one', testAssessment(1.2), 'CONFIDENCE_UNSUPPORTED'],
      ['five decimals', testAssessment(0.81255), 'CONFIDENCE_UNSUPPORTED'], ['a missing factor', { ...base, factors: base.factors.slice(1) }, 'CONFIDENCE_BASIS_INCOMPLETE'],
      ['no methodology', { ...base, methodology: { id: '', version: '', ratification: '' } }, 'CONFIDENCE_UNSUPPORTED'],
      ['unavailable', { status: 'UNAVAILABLE', reason: 'not assessable' }, 'CONFIDENCE_UNAVAILABLE'],
    ];
    for (const [name, assessment, code] of cases) {
      expect(await svcFor(twin, { confidence: testConfidencePolicy(assessment) }).handOff(ctxOf(w), req(w)), name).toMatchObject({ outcome: 'NOT_HANDED_OFF', code });
    }
    expect(await svcFor(twin, { minimumConfidence: 0.9 }).handOff(ctxOf(w), req(w))).toMatchObject({ code: 'CONFIDENCE_BELOW_THRESHOLD' });        // 0.8125 < a raised policy threshold of 0.9
    expect(() => svcFor(twin, { minimumConfidence: 0.7 })).toThrow(RangeError);
    expect(DT_TO_SIM_MIN_CONFIDENCE).toBe(0.75);
    expect(await rows(w)).toEqual(NONE);
  });

  it('D1 boundary: a score of exactly 0.75 passes, and the same inputs always give the same envelope digest', async () => {
    const a = await world(); const b = await world();
    const ra = await svcFor((await publishTwin(a)).twin, { confidence: testConfidencePolicy(testAssessment(0.75)) }).handOff(ctxOf(a), req(a));
    expect(ra).toMatchObject({ outcome: 'HANDED_OFF', replay: false });
    const { twin: tb } = await publishTwin(b);
    const rb = await svcFor(tb, { confidence: testConfidencePolicy(testAssessment(0.75)) }).handOff(ctxOf(b), req(b));
    if (ra.outcome !== 'HANDED_OFF' || rb.outcome !== 'HANDED_OFF' || ra.replay || rb.replay) throw new Error('x');
    expect(ra.handoff.payload.variables.map((v) => [v.variableCode, v.value, v.unit])).toEqual(rb.handoff.payload.variables.map((v) => [v.variableCode, v.value, v.unit]));   // ids differ, content does not
  });

  it('D3: the source BI evidence is re-derived before the commit; a change since the twin state was published refuses the hand-off (SOURCE_SUPERSEDED) without asking for confidence', async () => {
    const w = await world(); const { twin, m } = await publishTwin(w);
    const policy = testConfidencePolicy();
    const svc = svcFor(twin, { confidence: policy });
    m.state.fin = () => financialFor(w.businessId, { completedOrders: [{ date: '2026-10-05', currency: 'USD', amount: '150.0000', count: 2 }, { date: '2026-10-20', currency: 'KWD', amount: '31.5000', count: 1 }, { date: '2026-10-25', currency: 'EUR', amount: '5.0000', count: 1 }] });
    m.state.sales = () => salesFor(w.businessId);
    const res = await svc.handOff(ctxOf(w), req(w));
    expect(res).toMatchObject({ outcome: 'NOT_HANDED_OFF' });
    expect(['SOURCE_SUPERSEDED', 'SOURCE_UNVERIFIABLE']).toContain((res as { code: string }).code);
    expect(policy.calls).toBe(0);                                                                // freshness is decided BEFORE confidence is assessed
    expect(await rows(w)).toEqual(NONE);
  });

  it('D3: a change in either BI report supersedes the state; restoring the source restores a valid hand-off (the comparison is exact, not a clock)', async () => {
    const w = await world(); const { twin, m } = await publishTwin(w);
    const svc = svcFor(twin);
    m.state.sales = () => { const r = salesFor(w.businessId, 15000); if (r.outcome === 'REPORT') r.report.currencies[1]!.totals.voidedOrders = 7; return r; };    // a voided order appears: sales changed, revenue did not
    expect(await svc.handOff(ctxOf(w), req(w))).toMatchObject({ outcome: 'NOT_HANDED_OFF', code: 'SOURCE_SUPERSEDED', detail: expect.stringContaining('publish a new twin state first') });
    m.state.sales = () => salesFor(w.businessId);
    expect(await rows(w)).toEqual(NONE);
    expect(await svc.handOff(ctxOf(w), req(w))).toMatchObject({ outcome: 'HANDED_OFF', replay: false });
  });

  it('D3: when the BI evidence cannot be re-derived (a report is unavailable or the reports now disagree) the hand-off fails closed (SOURCE_UNVERIFIABLE)', async () => {
    const w = await world(); const { twin, m } = await publishTwin(w);
    const svc = svcFor(twin);
    m.state.fin = () => ({ outcome: 'UNAVAILABLE', code: 'FACTS_UNAVAILABLE', detail: 'down' });
    m.state.sales = () => ({ outcome: 'NOT_AVAILABLE', code: 'UNSUPPORTED_CURRENCY', detail: 'xyz' });
    expect(await svc.handOff(ctxOf(w), req(w))).toMatchObject({ outcome: 'NOT_HANDED_OFF', code: 'SOURCE_UNVERIFIABLE' });
    m.state.fin = () => financialFor(w.businessId); m.state.sales = () => salesFor(w.businessId, 15001);          // sales now disagrees with financial
    expect(await svc.handOff(ctxOf(w), req(w))).toMatchObject({ outcome: 'NOT_HANDED_OFF', code: 'SOURCE_UNVERIFIABLE' });
    expect(await rows(w)).toEqual(NONE);
  });

  it('is idempotent: a repeat replays the existing dispatched package with its envelope digest and creates nothing', async () => {
    const w = await world(); const { twin } = await publishTwin(w); const svc = svcFor(twin);
    const first = await svc.handOff(ctxOf(w), req(w));
    const again = await svc.handOff(ctxOf(w), req(w));
    if (first.outcome !== 'HANDED_OFF' || again.outcome !== 'HANDED_OFF' || first.replay) throw new Error('x');
    expect(again).toEqual({ outcome: 'HANDED_OFF', replay: true, publicationPackageId: first.publicationPackageId, publicationStatus: 'dispatched', snapshotId: first.snapshotId, confidenceScoreId: first.confidenceScoreId, envelopeDigest: first.envelopeDigest });
    expect(await rows(w)).toEqual(ONE);
  });

  it('a replay never bypasses the gates: source change and a closed confidence policy both refuse it, and the existing evidence is left intact', async () => {
    const w = await world(); const { twin, m } = await publishTwin(w);
    const first = await svcFor(twin).handOff(ctxOf(w), req(w));
    if (first.outcome !== 'HANDED_OFF' || first.replay) throw new Error('x');
    expect(await svcFor(twin, { confidence: undefined }).handOff(ctxOf(w), req(w))).toMatchObject({ code: 'CONFIDENCE_UNAVAILABLE' });     // default (closed) policy
    m.state.sales = () => { const r = salesFor(w.businessId, 15000); if (r.outcome === 'REPORT') r.report.currencies[0]!.totals.openOrders = 3; return r; };
    expect(await svcFor(twin).handOff(ctxOf(w), req(w))).toMatchObject({ code: 'SOURCE_SUPERSEDED' });
    expect(await rows(w)).toEqual(ONE);                                                           // nothing deleted, nothing added
    expect((await admin.query('SELECT publication_status FROM business_digital_twin.dt_publication_packages WHERE id = $1', [first.publicationPackageId])).rows[0].publication_status).toBe('dispatched');
  });

  it('a package of this hand-off that has no persisted envelope (e.g. one dispatched before SEC-01) is never replayed as valid (PERSISTED_HANDOFF_INVALID)', async () => {
    const w = await world(); const { twin, out } = await publishTwin(w);
    const p = new DTPublicationPackageRepository();
    const insight = await p.createInsightPackage(ctxOf(w), w.businessId, 'legacy-handoff');
    const version = await p.createVersion(ctxOf(w), insight.id, w.businessId, 'legacy', { snapshotVersionId: out.snapshotVersionId });
    await p.createPackage(ctxOf(w), w.businessId, version.id, 'simulation', 'SIM-01', `bdt-performance-sim:${out.snapshotVersionId}`);     // a draft with the hand-off's key but no envelope
    expect(await svcFor(twin).handOff(ctxOf(w), req(w))).toMatchObject({ outcome: 'NOT_HANDED_OFF', code: 'PERSISTED_HANDOFF_INVALID', detail: expect.stringContaining('no persisted envelope') });
    expect((await rows(w)).envelopes).toBe(0);
  });

  it('a replay verifies the PERSISTED hand-off: a tampered stored envelope is refused (PERSISTED_HANDOFF_INVALID), never returned as valid', async () => {
    const w = await world(); const { twin } = await publishTwin(w);
    const first = await svcFor(twin).handOff(ctxOf(w), req(w));
    if (first.outcome !== 'HANDED_OFF' || first.replay) throw new Error('x');
    await admin.query('ALTER TABLE business_digital_twin.dt_handoff_envelopes DISABLE TRIGGER USER');
    try { await admin.query(`UPDATE business_digital_twin.dt_handoff_envelopes SET envelope = jsonb_set(envelope, '{payload,quality,confidence}', '0.99') WHERE dt_publication_package_id = $1`, [first.publicationPackageId]); }
    finally { await admin.query('ALTER TABLE business_digital_twin.dt_handoff_envelopes ENABLE TRIGGER USER'); }
    expect(await svcFor(twin).handOff(ctxOf(w), req(w))).toMatchObject({ outcome: 'NOT_HANDED_OFF', code: 'PERSISTED_HANDOFF_INVALID', detail: expect.stringContaining('envelope_digest_mismatch') });
  });

  it('concurrent identical hand-offs produce exactly one package, envelope and score (the database uniqueness decides; the losers replay)', async () => {
    const w = await world(); const { twin } = await publishTwin(w); const svc = svcFor(twin);
    const results = await Promise.all(Array.from({ length: 4 }, () => svc.handOff(ctxOf(w), req(w))));
    expect(results.every((r) => r.outcome === 'HANDED_OFF')).toBe(true);
    expect(results.filter((r) => r.outcome === 'HANDED_OFF' && !r.replay)).toHaveLength(1);
    expect(new Set(results.map((r) => (r.outcome === 'HANDED_OFF' ? r.envelopeDigest : ''))).size).toBe(1);
    expect(await rows(w)).toEqual(ONE);
  });

  it('a newer published twin state is a different hand-off; the older one is untouched', async () => {
    const w = await world(); const { twin } = await publishTwin(w);
    const first = await svcFor(twin).handOff(ctxOf(w), req(w));
    const later = new BusinessPerformanceTwinService({ ...readersFor(w.businessId), now: () => new Date(NOW.getTime() + 60_000) });
    await later.publish(ctxOf(w), { businessId: w.businessId, ...PERIOD });
    const second = await svcFor(later).handOff(ctxOf(w), req(w));
    if (first.outcome !== 'HANDED_OFF' || second.outcome !== 'HANDED_OFF' || first.replay || second.replay) throw new Error('x');
    expect(second.publicationPackageId).not.toBe(first.publicationPackageId);
    expect(await rows(w)).toEqual({ baselines: 2, packages: 2, insight: 2, scores: 2, envelopes: 2 });
  });

  it('refuses and persists NOTHING when there is no twin state, the state is partial or tampered, or the request is invalid', async () => {
    const w = await world();
    const none = svcFor(new BusinessPerformanceTwinService({ ...readersFor(w.businessId), now: () => NOW }));
    expect(await none.handOff(ctxOf(w), req(w))).toMatchObject({ code: 'TWIN_STATE_MISSING' });
    for (const bad of [{ businessId: 'nope', ...PERIOD }, { businessId: w.businessId, from: '2026-02-30', to: '2026-03-10' }, { businessId: w.businessId, from: '2026-11-01', to: '2026-10-01' }, { businessId: w.businessId, from: '2025-01-01', to: '2026-12-31' }]) {
      expect(await none.handOff(ctxOf(w), bad), JSON.stringify(bad)).toMatchObject({ code: 'INVALID_REQUEST' });
    }
    const partial = await world();
    const pTwin = new BusinessPerformanceTwinService({ ...readersFor(partial.businessId, { fin: () => ({ outcome: 'UNAVAILABLE', code: 'FACTS_UNAVAILABLE', detail: 'down' }) }), now: () => NOW });
    expect((await pTwin.publish(ctxOf(partial), { businessId: partial.businessId, ...PERIOD })).outcome).toBe('PUBLISHED');
    expect(await svcFor(pTwin).handOff(ctxOf(partial), req(partial))).toMatchObject({ code: 'NOT_SIMULATION_READY' });
    const tampered = await world(); const { twin: tTwin, out } = await publishTwin(tampered);
    const row = await admin.query('SELECT id, value_json FROM business_digital_twin.digital_twin_snapshot_values WHERE snapshot_version_id = $1', [out.snapshotVersionId]);
    const doctored = row.rows[0].value_json; doctored.evidence.sales.currencies[1].netMinor = 1;
    await admin.query('ALTER TABLE business_digital_twin.digital_twin_snapshot_values DISABLE TRIGGER USER');
    try { await admin.query('UPDATE business_digital_twin.digital_twin_snapshot_values SET value_json = $2 WHERE id = $1', [row.rows[0].id, doctored]); }
    finally { await admin.query('ALTER TABLE business_digital_twin.digital_twin_snapshot_values ENABLE TRIGGER USER'); }
    expect(await svcFor(tTwin).handOff(ctxOf(tampered), req(tampered))).toMatchObject({ code: 'TWIN_STATE_INTEGRITY_FAILED' });
    for (const x of [w, partial, tampered]) expect(await rows(x)).toEqual(NONE);
  });

  it('is atomic: a failure at any step (an input, the envelope record, the dispatch) rolls back baseline, package, score AND envelope, and a clean retry succeeds', async () => {
    const w = await world(); const { twin } = await publishTwin(w);
    const realB = new ScenarioBaselineRepository(); const realE = new DTHandoffEnvelopeRepository(); const realP = new DTPublicationPackageRepository();
    let added = 0;
    const flakyInput = { createBaseline: realB.createBaseline.bind(realB), validateBaseline: realB.validateBaseline.bind(realB), publishBaseline: realB.publishBaseline.bind(realB), addInput: async (...a: Parameters<ScenarioBaselineRepository['addInput']>) => { if (++added === 5) throw new Error('boom-input'); return realB.addInput(...a); } };
    await expect(svcFor(twin, { baselines: flakyInput }).handOff(ctxOf(w), req(w))).rejects.toThrow('boom-input');
    const flakyEnvelope = { getByPackage: realE.getByPackage.bind(realE), record: async () => { throw new Error('boom-envelope'); } };
    await expect(svcFor(twin, { envelopes: flakyEnvelope }).handOff(ctxOf(w), req(w))).rejects.toThrow('boom-envelope');
    const flakyDispatch = { createInsightPackage: realP.createInsightPackage.bind(realP), createVersion: realP.createVersion.bind(realP), createPackage: realP.createPackage.bind(realP), markReady: realP.markReady.bind(realP), getByIdempotencyKey: realP.getByIdempotencyKey.bind(realP), dispatch: async () => { throw new Error('boom-dispatch'); } };
    await expect(svcFor(twin, { packages: flakyDispatch }).handOff(ctxOf(w), req(w))).rejects.toThrow('boom-dispatch');
    expect(await rows(w)).toEqual(NONE);
    expect(await svcFor(twin).handOff(ctxOf(w), req(w))).toMatchObject({ outcome: 'HANDED_OFF', replay: false });
    expect(await rows(w)).toEqual(ONE);
  });

  it('a hand-off that violates the frozen contract is refused BEFORE anything is attempted (HANDOFF_INVALID), and one found invalid after the ids exist rolls back everything', async () => {
    const w = await world(); const { twin } = await publishTwin(w);
    const calls: string[] = []; const real = new ScenarioBaselineRepository();
    const spy = { createBaseline: async (...a: Parameters<ScenarioBaselineRepository['createBaseline']>) => { calls.push('createBaseline'); return real.createBaseline(...a); }, addInput: real.addInput.bind(real), validateBaseline: real.validateBaseline.bind(real), publishBaseline: real.publishBaseline.bind(real) };
    const badTime = { currentEvidence: twin.currentEvidence.bind(twin), getLatest: async (...a: Parameters<typeof twin.getLatest>) => { const l = await twin.getLatest(...a); return l && { ...l, effectiveAt: 'not-a-date' }; } };
    expect(await svcFor(badTime, { baselines: spy }).handOff(ctxOf(w), req(w))).toMatchObject({ code: 'HANDOFF_INVALID', detail: expect.stringContaining('effective_at_invalid') });
    expect(calls).toEqual([]);
    const blankCorrelation = { ...spy, createBaseline: async (...a: Parameters<ScenarioBaselineRepository['createBaseline']>) => { const r = await real.createBaseline(...a); return { ...r, version: { ...r.version, correlationId: '' } }; } };
    expect(await svcFor(twin, { baselines: blankCorrelation }).handOff(ctxOf(w), req(w))).toMatchObject({ code: 'HANDOFF_INVALID', detail: expect.stringContaining('correlationId_required') });
    expect(await rows(w)).toEqual(NONE);
    expect(await svcFor(twin).handOff(ctxOf(w), req(w))).toMatchObject({ outcome: 'HANDED_OFF', replay: false });
  });

  it('isolates tenants and businesses: the envelope, the score and the replay lookup are invisible to another tenant and to a sibling business', async () => {
    const w = await world(); const sib = await addBusiness(admin, w); const other = await world();
    const { twin } = await publishTwin(w); const svc = svcFor(twin);
    expect(await svc.handOff(ctxOf(w), { businessId: sib.businessId, ...PERIOD })).toMatchObject({ code: 'TWIN_STATE_MISSING' });
    expect(await svc.handOff(ctxOf(other), req(w))).toMatchObject({ code: 'TWIN_STATE_MISSING' });
    const mine = await svc.handOff(ctxOf(w), req(w));
    if (mine.outcome !== 'HANDED_OFF' || mine.replay) throw new Error('x');
    const envelopes = new DTHandoffEnvelopeRepository(); const scores = new TwinConfidenceScoreRepository();
    expect(await envelopes.getByPackage(ctxOf(w), w.businessId, mine.publicationPackageId)).not.toBeNull();
    expect(await envelopes.getByPackage(ctxOf(w), sib.businessId, mine.publicationPackageId)).toBeNull();
    expect(await envelopes.getByPackage(ctxOf(other), w.businessId, mine.publicationPackageId)).toBeNull();
    expect(await scores.getById(ctxOf(other), mine.confidenceScoreId)).toBeNull();
    expect(await rows(sib)).toEqual(NONE); expect(await rows(other)).toEqual(NONE);
    expect(await svc.handOff(ctxOf(other), req(w))).toMatchObject({ code: 'TWIN_STATE_MISSING' });
  });

  it('writes only Digital Twin tables: Simulation intake, orders, BO and BI rows are unchanged', async () => {
    const w = await world(); const { twin } = await publishTwin(w);
    const tables = ['simulation.simulation_intake_packages', 'platform.orders', 'business_operations.expense_items', 'business_intelligence.insight_packages', 'business_intelligence.metric_calculated_values'];
    const snap = async () => Promise.all(tables.map((t) => n(`SELECT count(*)::int n FROM ${t} WHERE tenant_id = $1`, [w.tenantId])));
    const before = await snap();
    await svcFor(twin).handOff(ctxOf(w), req(w));
    expect(await snap()).toEqual(before);
    expect(before[0]).toBe(0);
  });
});
