/**
 * AC-2 Block 7 - the ADI input boundary (real PostgreSQL, production buildApp).
 *
 * The principal path no longer rests on an ad-hoc Business Operations snapshot: ADI recommends only when governed Business Intelligence evidence AND the Business
 * Digital Twin state derived from it exist, are current, describe the same facts as Business Operations holds now, and the newest twin state is the one used.
 * ADI reads them through ports and writes nothing in BI, BDT or BO (other than BO's own evaluation facts, bound to the proposal).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { loadConfig } from '@infinicus/configuration';
import { closePool, createPool, type TenantContext } from '@infinicus/database';
import { TwinComputationService } from '@infinicus/workflow';
import { buildApp } from '../src/app.js';
import { buildReorderPolicyRecommendationProducer } from '../src/reorderPolicyRecommendationComposition.js';
import { chainKit } from './helpers/authorizedPackageChain.js';
import { deleteMovementsForTenants } from './helpers/movementCleanup.js';
import { daysAgo, dalKit, unique, type World } from './helpers/dalIngestion.js';

const run = !!process.env.DATABASE_URL && !!process.env.ADMIN_DATABASE_URL;
const RULE_SET = 'inventory-reorder-policy/v1.1.0';
const ADI = 'ai_decision_intelligence';
const HOUR = 3_600_000;

let app: FastifyInstance;
let admin: Pool;
const tenantIds: string[] = [];
let kit: ReturnType<typeof dalKit>;

const put = (w: { ctx: TenantContext; token: string }, url: string, payload: unknown) =>
  app.inject({ method: 'PUT', url, headers: kit.headers(w, { 'idempotency-key': unique('key') }), payload: payload as never });
const post = (w: { ctx: TenantContext; token: string }, url: string, payload: unknown = {}) =>
  app.inject({ method: 'POST', url, headers: kit.headers(w, { 'idempotency-key': unique('key') }), payload: payload as never });
const item = (w: World, itemId: string) => `/v1/businesses/${w.businessId}/inventory-items/${itemId}`;
const publishBi = (w: World, itemId: string) => post(w, `${item(w, itemId)}/bi-evidence`, { ruleSetVersion: RULE_SET });
const publishTwin = (w: World, itemId: string) => post(w, `${item(w, itemId)}/twin-state`);
const recommend = (w: World, itemId: string) => post(w, `${item(w, itemId)}/reorder-policy-recommendation`);

/** DAL -> BO, the BO baseline and the declared currency. No BI, no BDT yet. */
async function base() {
  const w = await kit.world();
  const ids = await kit.ingestFirstAction(w, 'SKU-A', 'WH-A');
  expect((await put(w, `${item(w, ids.itemId)}/warehouses/${ids.warehouseId}/initial-reorder-policy`, { reorderPoint: 170, reorderQuantity: 190 })).statusCode).toBe(200);
  expect((await put(w, `/v1/businesses/${w.businessId}/declared-currency`, { currency: 'USD', expectedVersion: null, reason: 'initial declaration' })).statusCode).toBe(201);
  return { w, ...ids };
}
const counts = async (w: World) => {
  const n = async (sql: string) => Number((await admin.query(sql, [w.businessId])).rows[0].n);
  return {
    recommendations: await n(`SELECT count(*) n FROM ${ADI}.decision_recommendations WHERE business_id=$1`),
    versions: await n(`SELECT count(*) n FROM ${ADI}.decision_recommendation_versions WHERE business_id=$1`),
    evaluations: await n(`SELECT count(*) n FROM business_operations.inventory_policy_evaluations WHERE business_id=$1`),
  };
};
const upstream = async (w: World) => {
  const n = async (sql: string) => Number((await admin.query(sql, [w.businessId])).rows[0].n);
  return {
    biMetricValues: await n(`SELECT count(*) n FROM business_intelligence.metric_calculated_values WHERE business_id=$1`),
    biVersions: await n(`SELECT count(*) n FROM business_intelligence.insight_package_versions WHERE business_id=$1`),
    twinSnapshots: await n(`SELECT count(*) n FROM business_digital_twin.digital_twin_snapshots WHERE business_id=$1`),
    balances: JSON.stringify((await admin.query(`SELECT * FROM business_operations.inventory_balances WHERE business_id=$1 ORDER BY id`, [w.businessId])).rows),
  };
};
const noRecommendation = (res: { statusCode: number; json(): any }, code: string) => {
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ outcome: 'NO_RECOMMENDATION', code });
};

describe.runIf(run)('AC-2 Block 7: ADI recommends only on governed BI and BDT evidence', () => {
  beforeAll(async () => {
    createPool({ connectionString: process.env.DATABASE_URL! });
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
    app = await buildApp(loadConfig({ DATABASE_URL: process.env.DATABASE_URL!, NODE_ENV: 'test', LOG_LEVEL: 'silent', RATE_LIMIT_MAX: '5000' }));
    await app.ready();
    kit = dalKit({ app, admin, tenantIds });
  });
  afterAll(async () => {
    await app?.close();
    if (tenantIds.length > 0) {
      const c = await admin.connect();
      try {
        await c.query('BEGIN'); await c.query("SET LOCAL session_replication_role = 'replica'");
        await c.query('DELETE FROM audit.audit_events WHERE tenant_id = ANY($1)', [tenantIds]);
        await c.query('DELETE FROM business_operations.inventory_policy_evaluations WHERE tenant_id = ANY($1)', [tenantIds]);
        await c.query('COMMIT');
      } catch { await c.query('ROLLBACK').catch(() => undefined); } finally { c.release(); }
      await deleteMovementsForTenants(admin, tenantIds);
    }
    await admin?.end(); await closePool();
  });

  it('without BI evidence ADI recommends NOTHING (BO truth alone is not enough) and persists nothing', async () => {
    const { w, itemId } = await base();
    noRecommendation(await recommend(w, itemId), 'BI_EVIDENCE_MISSING');
    expect(await counts(w)).toEqual({ recommendations: 0, versions: 0, evaluations: 0 });
  });

  it('with BI evidence but no BDT state ADI recommends nothing', async () => {
    const { w, itemId } = await base();
    expect((await publishBi(w, itemId)).statusCode).toBe(201);
    noRecommendation(await recommend(w, itemId), 'BDT_STATE_MISSING');
    expect(await counts(w)).toEqual({ recommendations: 0, versions: 0, evaluations: 0 });
  });

  it('with current, consistent BI evidence and BDT state ADI recommends; the proposal cites both, the recommendation is bound to the twin snapshot, and ADI writes nothing upstream', async () => {
    const { w, itemId, balanceId } = await base();
    const bi = (await publishBi(w, itemId)).json();
    const twin = (await publishTwin(w, itemId)).json();
    const before = await upstream(w);
    const res = await recommend(w, itemId);
    expect(res.statusCode, res.body).toBe(201);
    const out = res.json();
    const refs = out.proposal.evidenceReferences as { kind: string; id?: string; digest: string }[];
    const facts = refs.find((r) => r.kind === 'bo_inventory_policy_facts')!;
    expect(refs.find((r) => r.kind === 'bi_inventory_evidence')).toMatchObject({ id: bi.insightPackageVersionId, digest: bi.factsDigest });
    expect(refs.find((r) => r.kind === 'bdt_inventory_item_state')).toMatchObject({ id: twin.snapshotId, digest: twin.factsDigest });
    expect(new Set(refs.map((r) => r.digest)).size).toBe(1); // BO facts, the four BO evaluations, the BI evidence and the BDT state all describe ONE fact set
    expect(facts).toMatchObject({ id: balanceId, digest: bi.factsDigest });
    expect(out.proposal.proposedParameters).toEqual({ reorderPoint: 175, reorderQuantity: 190 });
    expect(out.proposal.reasoning.basis.join(' ')).toContain('Governed evidence');
    // the recommendation is anchored to the twin snapshot (the existing P0-3 freshness gate will judge it at approval and issuance) and expires with the evidence
    const version = (await admin.query(`SELECT twin_snapshot_id, valid_until, is_time_sensitive FROM ${ADI}.decision_recommendation_versions WHERE id=$1`, [out.recommendationVersionId])).rows[0];
    expect(version).toMatchObject({ twin_snapshot_id: twin.snapshotId, is_time_sensitive: true });
    expect(new Date(version.valid_until).toISOString()).toBe(bi.validUntil);
    // ADI wrote nothing in BI, BDT or BO balances; BO's own evaluation facts (four dimensions) were recorded for the proposal
    expect(await upstream(w)).toEqual(before);
    expect((await counts(w)).evaluations).toBe(4);
  });

  it('BI evidence republished after the twin was derived: the twin no longer matches the latest evidence -> nothing is recommended', async () => {
    const { w, itemId } = await base();
    expect((await publishBi(w, itemId)).statusCode).toBe(201);
    expect((await publishTwin(w, itemId)).statusCode).toBe(201);
    expect((await publishBi(w, itemId)).statusCode).toBe(201); // a newer evidence version the twin was not derived from
    noRecommendation(await recommend(w, itemId), 'BI_BDT_EVIDENCE_MISMATCH');
    expect(await counts(w)).toEqual({ recommendations: 0, versions: 0, evaluations: 0 });
  });

  it('a newer Digital Twin snapshot of the business supersedes the state used -> nothing is recommended until the item state is re-derived', async () => {
    const { w, itemId } = await base();
    expect((await publishBi(w, itemId)).statusCode).toBe(201);
    expect((await publishTwin(w, itemId)).statusCode).toBe(201);
    await new Promise((r) => setTimeout(r, 1200)); // capture times have one-second resolution
    await new TwinComputationService().getOrComputeTwin(w.ctx, w.businessId, { forceRefresh: true }); // a newer published snapshot of the same business
    noRecommendation(await recommend(w, itemId), 'BDT_STATE_STALE');
    expect(await counts(w)).toEqual({ recommendations: 0, versions: 0, evaluations: 0 });
  });

  it('Business Operations facts that changed after the evidence was published (a new issue movement through DAL) -> the digests differ and nothing is recommended', async () => {
    const { w, itemId } = await base();
    expect((await publishBi(w, itemId)).statusCode).toBe(201);
    expect((await publishTwin(w, itemId)).statusCode).toBe(201);
    const more = await kit.publishThroughDal(w, [{ recordType: 'inventory_movement', data: { sku: 'SKU-A', warehouseCode: 'WH-A', movementType: 'issue', quantity: 5, occurredAt: daysAgo(0.5), referenceType: 'manual' } }]);
    expect((await kit.boIntake(w, more.packageId)).statusCode).toBe(200);
    noRecommendation(await recommend(w, itemId), 'EVIDENCE_DIGEST_MISMATCH');
    expect(await counts(w)).toEqual({ recommendations: 0, versions: 0, evaluations: 0 });
    // republishing BI and BDT against the new facts restores the path
    expect((await publishBi(w, itemId)).statusCode).toBe(201);
    expect((await publishTwin(w, itemId)).statusCode).toBe(201);
    expect((await recommend(w, itemId)).statusCode).toBe(201);
  });

  it('evidence past its expiry (the rule set\'s maximum age) -> nothing is recommended', async () => {
    const { w, itemId } = await base();
    expect((await publishBi(w, itemId)).statusCode).toBe(201);
    expect((await publishTwin(w, itemId)).statusCode).toBe(201);
    const later = buildReorderPolicyRecommendationProducer({ evidence: { now: () => new Date(Date.now() + 25 * HOUR) } });
    expect(await later.produce(w.ctx, { businessId: w.businessId, itemId }, { permissionUsed: 'bo:write' })).toMatchObject({ outcome: 'NO_RECOMMENDATION', code: 'BI_EVIDENCE_EXPIRED' });
    expect(await counts(w)).toEqual({ recommendations: 0, versions: 0, evaluations: 0 });
  });

  it('a proposal that does not cite the governed BI and BDT evidence cannot be captured by ABA (the producer is not the only line of defence)', async () => {
    const ck = chainKit({ app, admin, tenantIds });
    const c = await ck.authorFromAdi({ mode: 'until-capture' });
    // fixture surgery: strip the BI and BDT references from the stored proposal (superuser, triggers suspended in one transaction)
    const conn = await admin.connect();
    try {
      await conn.query('BEGIN'); await conn.query("SET LOCAL session_replication_role = 'replica'");
      await conn.query(
        `UPDATE ${ADI}.recommendation_rationales SET evidence_reference = jsonb_set(evidence_reference, '{evidenceReferences}',
           (SELECT jsonb_agg(e) FROM jsonb_array_elements(evidence_reference->'evidenceReferences') e WHERE e->>'kind' NOT IN ('bi_inventory_evidence','bdt_inventory_item_state')))
         WHERE recommendation_version_id = $1 AND rationale_code = 'proposed_action'`, [c.recommendationVersionId]);
      await conn.query('COMMIT');
    } catch (e) { await conn.query('ROLLBACK').catch(() => undefined); throw e; } finally { conn.release(); }
    const res = await ck.post(c.s, `${c.base}/capture`, { actionType: { code: 'inventory_reorder_policy_update', schemaVersion: '1' }, target: { kind: 'inventory_item', id: c.itemId }, proposedParameters: { ...c.proposal.proposedParameters } });
    expect(res.statusCode, res.body).toBeGreaterThanOrEqual(400);
    expect(res.body).toContain('ADI_PROPOSAL_EVIDENCE_INCOMPLETE');
    expect(res.body).toContain('bi_inventory_evidence');
    expect((await admin.query(`SELECT 1 FROM approved_business_action.authorized_action_captures WHERE business_id=$1`, [c.s.bizId])).rowCount).toBe(0);
  }, 90_000);
});
