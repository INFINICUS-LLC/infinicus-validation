/**
 * OM-EVID-1 - live PostgreSQL proof that the database itself enforces Guardrail Section XI on outcome_monitoring.action_execution_verifications.
 *
 * The OM service and the architecture tests already prove the CODE cannot assign more than PENDING / INCONCLUSIVE. This file proves the DATABASE refuses it
 * too, using raw INSERTs as the application role that bypass every application guard, and that the record is append-only, tenant-isolated and
 * stamped with the database clock. Requires DATABASE_URL (application role, RLS enforced) and ADMIN_DATABASE_URL.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { createPool, closePool, withTenantTransaction, type TenantContext } from '../src/client.js';

const run = !!process.env.DATABASE_URL;
const OM = 'outcome_monitoring';
const T = `${OM}.action_execution_verifications`;
const uc = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const DIGEST = `sha256:${'c'.repeat(64)}`;

let admin: Pool;
interface World { ctx: TenantContext; bizId: string }
async function world(): Promise<World> {
  const tenantId = randomUUID(); const workspaceId = randomUUID(); const bizId = randomUUID();
  await admin.query(`INSERT INTO tenancy.tenants (id, name, slug, status, plan_code) VALUES ($1,'OE1 T',$2,'active','test')`, [tenantId, uc('oe1t')]);
  await admin.query(`INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,'OE1 WS',$3,'active')`, [workspaceId, tenantId, uc('oe1w')]);
  await admin.query(`INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,'OE1 Biz',$4,'active')`, [bizId, tenantId, workspaceId, uc('oe1b')]);
  return { ctx: { tenantId, workspaceId, userId: randomUUID() }, bizId };
}

interface Row {
  executionId: string; executionState: string; outcomeState: string; executionOutcome: string; mutationResult: string; reason: string;
  contractVersion: string; digest: string; recordedAt: string; verifiedAt?: string | null;
}
const row = (over: Partial<Row> = {}): Row => ({
  executionId: randomUUID(), executionState: 'EXECUTION_VERIFIED', outcomeState: 'OUTCOME_PENDING', executionOutcome: 'SUCCEEDED', mutationResult: 'APPLIED', reason: 'oe1 reason',
  contractVersion: 'execution-evidence/1', digest: DIGEST, recordedAt: new Date(Date.now() - 1000).toISOString(), ...over,
});
/** Raw INSERT as the application role in the caller's tenant context. */
const insert = (w: World, r: Row, tenantOverride?: Pick<TenantContext, 'tenantId' | 'workspaceId'>) => withTenantTransaction(w.ctx, (c) => c.query(
  `INSERT INTO ${T} (tenant_id,workspace_id,business_id,execution_id,source_event_id,contract_version,evidence_digest,package_id,package_version,claim_id,
                     action_type_code,action_type_schema_version,target_kind,target_id,execution_outcome,mutation_result,execution_recorded_at,execution_state,
                     outcome_state,outcome_state_reason,correlation_id)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,$9,'inventory_reorder_policy_update','1','inventory_item','t-1',$10,$11,$12::timestamptz,$13,$14,$15,$16) RETURNING id, verified_at`,
  [tenantOverride?.tenantId ?? w.ctx.tenantId, tenantOverride?.workspaceId ?? w.ctx.workspaceId, w.bizId, r.executionId, randomUUID(), r.contractVersion, r.digest, randomUUID(), randomUUID(),
   r.executionOutcome, r.mutationResult, r.recordedAt, r.executionState, r.outcomeState, r.reason, randomUUID()]));
const countFor = async (w: World) => Number((await admin.query(`SELECT count(*)::int n FROM ${T} WHERE business_id=$1`, [w.bizId])).rows[0].n);

describe.runIf(run)('OM-EVID-1 execution verification table - database-enforced Section XI (live PostgreSQL, application role)', () => {
  let a: World; let b: World;
  beforeAll(async () => {
    createPool({ connectionString: process.env.DATABASE_URL! });
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });
    a = await world(); b = await world();
  });
  afterAll(async () => { await admin?.end(); await closePool(); });

  it('a genuine verification is accepted: EXECUTION_VERIFIED with PENDING (applied) and INCONCLUSIVE (no change)', async () => {
    expect((await insert(a, row())).rows).toHaveLength(1);
    expect((await insert(a, row({ outcomeState: 'OUTCOME_INCONCLUSIVE', mutationResult: 'NO_CHANGE' }))).rows).toHaveLength(1);
  });

  it.each(['OUTCOME_VERIFIED', 'OUTCOME_OBSERVED', 'OUTCOME_FAILED', 'OUTCOME_EFFECTIVE', 'outcome_verified', 'VERIFIED', ''])(
    'the database refuses outcome_state %j (an outcome cannot be fabricated) and writes nothing', async (state) => {
      const before = await countFor(a);
      await expect(insert(a, row({ outcomeState: state }))).rejects.toMatchObject({ code: '23514' });
      expect(await countFor(a)).toBe(before);
    });

  it.each(['EXECUTION_PENDING', 'EXECUTION_FAILED', 'OUTCOME_VERIFIED', 'execution_verified', ''])('the database refuses execution_state %j', async (state) => {
    const before = await countFor(a);
    await expect(insert(a, row({ executionState: state }))).rejects.toMatchObject({ code: '23514' });
    expect(await countFor(a)).toBe(before);
  });

  it('over every outcome x mutation x state combination exactly the legitimate ones are accepted', async () => {
    const accepted: string[] = [];
    for (const executionOutcome of ['SUCCEEDED', 'REFUSED', 'FAILED']) for (const mutationResult of ['APPLIED', 'NO_CHANGE', 'NOT_APPLICABLE']) for (const outcomeState of ['OUTCOME_PENDING', 'OUTCOME_INCONCLUSIVE']) {
      try { await insert(a, row({ executionOutcome, mutationResult, outcomeState })); accepted.push(`${executionOutcome}/${mutationResult}/${outcomeState}`); } catch (e) { expect((e as { code?: string }).code).toBe('23514'); }
    }
    expect(accepted.sort()).toEqual([
      'FAILED/NOT_APPLICABLE/OUTCOME_INCONCLUSIVE', 'REFUSED/NOT_APPLICABLE/OUTCOME_INCONCLUSIVE',
      'SUCCEEDED/APPLIED/OUTCOME_INCONCLUSIVE', 'SUCCEEDED/APPLIED/OUTCOME_PENDING', 'SUCCEEDED/NO_CHANGE/OUTCOME_INCONCLUSIVE',
    ]);
  });

  it('evidence references are checked: only contract execution-evidence/1, only a sha256 digest, a stated reason of at most 200 characters', async () => {
    await expect(insert(a, row({ contractVersion: 'execution-evidence/2' }))).rejects.toMatchObject({ code: '23514' });
    await expect(insert(a, row({ digest: 'sha256:abc' }))).rejects.toMatchObject({ code: '23514' });
    await expect(insert(a, row({ digest: `md5:${'c'.repeat(64)}` }))).rejects.toMatchObject({ code: '23514' });
    await expect(insert(a, row({ reason: '   ' }))).rejects.toMatchObject({ code: '23514' });
    await expect(insert(a, row({ reason: 'x'.repeat(201) }))).rejects.toMatchObject({ code: '23514' });
  });

  it('one verification per execution per business: a second row for the same execution is refused, so a different verdict cannot be added later', async () => {
    const r = row();
    await insert(a, r);
    await expect(insert(a, { ...r, outcomeState: 'OUTCOME_INCONCLUSIVE', digest: `sha256:${'d'.repeat(64)}` })).rejects.toMatchObject({ code: '23505' });
  });

  it('the record is append-only: UPDATE, DELETE and TRUNCATE are refused for the application role and for the administrator, and the row is unchanged', async () => {
    const r = row(); const id = (await insert(a, r)).rows[0].id as string;
    for (const sql of [`UPDATE ${T} SET outcome_state='OUTCOME_INCONCLUSIVE' WHERE id=$1`, `UPDATE ${T} SET execution_outcome='FAILED' WHERE id=$1`, `DELETE FROM ${T} WHERE id=$1`]) {
      await expect(withTenantTransaction(a.ctx, (c) => c.query(sql, [id]))).rejects.toMatchObject({ code: '23000' });
      await expect(admin.query(sql, [id])).rejects.toMatchObject({ code: '23000' });
    }
    await expect(withTenantTransaction(a.ctx, (c) => c.query(`TRUNCATE ${T}`))).rejects.toBeTruthy();
    await expect(admin.query(`TRUNCATE ${T}`)).rejects.toMatchObject({ code: '23000' });
    const now = (await admin.query(`SELECT outcome_state, execution_outcome FROM ${T} WHERE id=$1`, [id])).rows[0];
    expect(now).toEqual({ outcome_state: 'OUTCOME_PENDING', execution_outcome: 'SUCCEEDED' });
  });

  it('tenant isolation: another tenant cannot read the row, and cannot insert a row for this tenant', async () => {
    const r = row(); await insert(a, r);
    const seenByB = await withTenantTransaction(b.ctx, (c) => c.query(`SELECT 1 FROM ${T} WHERE execution_id=$1`, [r.executionId]));
    expect(seenByB.rows).toHaveLength(0);
    const seenByA = await withTenantTransaction(a.ctx, (c) => c.query(`SELECT 1 FROM ${T} WHERE execution_id=$1`, [r.executionId]));
    expect(seenByA.rows).toHaveLength(1);
    // tenant B's session writing a row stamped with tenant A's scope is refused by row-level security
    await expect(insert({ ...b, bizId: a.bizId }, row(), { tenantId: a.ctx.tenantId, workspaceId: a.ctx.workspaceId })).rejects.toMatchObject({ code: '42501' });
  });

  it('time is the database clock: verified_at is stamped by the trigger and an execution recorded in the future is refused', async () => {
    const before = Date.now();
    const inserted = (await insert(a, row())).rows[0];
    const verifiedAt = new Date(inserted.verified_at as string).getTime();
    expect(Math.abs(verifiedAt - before)).toBeLessThan(60_000);
    await expect(insert(a, row({ recordedAt: new Date(Date.now() + 3_600_000).toISOString() }))).rejects.toMatchObject({ code: '23514' });
  });

  it('the application role cannot switch the protections off (no ownership, no BYPASSRLS, FORCE RLS, both append-only triggers present)', async () => {
    const role = (await admin.query(`SELECT r.rolsuper, r.rolbypassrls, (c.relowner = r.oid) AS owner FROM pg_roles r, pg_class c WHERE r.rolname = current_user AND c.oid = $1::regclass`, [T])).rows[0];
    void role; // the admin pool is the fixture role; the application role is checked below through its own session
    const app = (await withTenantTransaction(a.ctx, (c) => c.query(`SELECT r.rolsuper, r.rolbypassrls, (c2.relowner = r.oid) AS owner FROM pg_roles r, pg_class c2 WHERE r.rolname = current_user AND c2.oid = $1::regclass`, [T]))).rows[0];
    expect(app).toEqual({ rolsuper: false, rolbypassrls: false, owner: false });
    const cat = (await admin.query(`SELECT c.relrowsecurity, c.relforcerowsecurity, (SELECT count(*)::int FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal AND t.tgname ~ '^forbid_') AS forbid FROM pg_class c WHERE c.oid=$1::regclass`, [T])).rows[0];
    expect(cat).toEqual({ relrowsecurity: true, relforcerowsecurity: true, forbid: 2 });
  });
});
