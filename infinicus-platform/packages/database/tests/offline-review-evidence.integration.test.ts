import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

const run = !!process.env.DATABASE_URL && !!process.env.ADMIN_DATABASE_URL;
const TABLE = 'business_operations.offline_review_evidence';
const digest = 'a'.repeat(64);

describe.runIf(run)('M1-A6 disabled review evidence (disposable PostgreSQL)', () => {
  let admin: Pool; let app: Pool;
  const tenant = randomUUID(); const workspace = randomUUID(); const business = randomUUID();
  const otherTenant = randomUUID(); const otherWorkspace = randomUUID(); const otherBusiness = randomUUID();
  const intake = randomUUID(); const clientSale = randomUUID(); const otherIntake = randomUUID(); const historicalIntake = randomUUID();
  const actor = randomUUID(); const resolution = randomUUID();

  async function asApp<T>(scope: { tenant: string; workspace: string } | null, fn: (q: (sql: string, args?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>) => Promise<T>): Promise<T> {
    const c = await app.connect();
    try {
      await c.query('BEGIN');
      if (scope) await c.query("SELECT set_config('app.tenant_id',$1,true), set_config('app.workspace_id',$2,true)", [scope.tenant, scope.workspace]);
      return await fn((sql, args) => c.query(sql, args));
    } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
  }

  function event(over: Record<string, unknown> = {}) {
    return {
      event_id: randomUUID(), tenant_id: tenant, workspace_id: workspace, business_id: business,
      offline_sale_id: intake, client_sale_id: clientSale, intake_request_digest: digest,
      resolution_id: resolution, event_version: 1, event_type: 'EVIDENCE_NOTE_RECORDED',
      reason_code: 'STRUCTURAL_NOTE', source_reference: randomUUID(), actor_id: actor,
      idempotency_key: randomUUID(), request_digest: digest, event_digest: digest,
      recorded_at: '2000-01-01T00:00:00Z', ...over,
    };
  }
  async function insert(row: Record<string, unknown>) {
    const keys = Object.keys(row);
    return admin.query(`INSERT INTO ${TABLE} (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, Object.values(row));
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL! });
    app = new Pool({ connectionString: process.env.DATABASE_URL! });
    for (const [t, w, b] of [[tenant, workspace, business], [otherTenant, otherWorkspace, otherBusiness]]) {
      await admin.query("INSERT INTO tenancy.tenants(id,name,slug,status,plan_code) VALUES($1,'M1A6',$2,'active','test')", [t, `m1a6-${t}`]);
      await admin.query("INSERT INTO tenancy.workspaces(id,tenant_id,name,slug,status) VALUES($1,$2,'M1A6',$3,'active')", [w, t, `m1a6-${w}`]);
      await admin.query("INSERT INTO platform.businesses(id,tenant_id,workspace_id,legal_name,business_code,status) VALUES($1,$2,$3,'M1A6',$4,'active')", [b, t, w, `m1a6-${b}`]);
    }
    await admin.query("INSERT INTO identity.users(id,email,password_hash,status) VALUES($1,$2,'synthetic','active')", [actor, `m1a6-${actor}@example.invalid`]);
    for (const [id, t, w, b, sale] of [[intake, tenant, workspace, business, clientSale], [otherIntake, otherTenant, otherWorkspace, otherBusiness, randomUUID()]]) {
      await admin.query(`INSERT INTO business_operations.offline_sales
        (id,tenant_id,workspace_id,business_id,client_sale_id,device_id,claimed_register_session_id,outcome,review_reason,currency_code,
         device_created_at,clock_skew_seconds,catalogue_snapshot_at,device_total_minor,request_digest,lines_detail)
        VALUES($1,$2,$3,$4,$5,'synthetic', $6,'needs_review','underpaid','KWD',now(),0,now(),100,$7,'[]')`,
      [id,t,w,b,sale,randomUUID(),digest]);
    }
    await admin.query(`INSERT INTO business_operations.offline_sales
      (id,tenant_id,workspace_id,business_id,client_sale_id,device_id,claimed_register_session_id,outcome,review_reason,currency_code,
       device_created_at,clock_skew_seconds,catalogue_snapshot_at,device_total_minor,request_digest,lines_detail)
      VALUES($1,$2,$3,$4,$5,'synthetic',$6,'needs_review','underpaid','KWD',now(),0,now(),100,$7,'[]')`,
    [historicalIntake,tenant,workspace,business,randomUUID(),randomUUID(),digest]);
  });
  afterAll(async () => { await admin?.end(); await app?.end(); });

  it('forces RLS, grants app SELECT only, and refuses app writes', async () => {
    const flags = (await admin.query(`SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='${TABLE}'::regclass`)).rows[0];
    expect(flags).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const p = (await admin.query(`SELECT has_table_privilege('app_test_user','${TABLE}','SELECT') r,
      has_table_privilege('app_test_user','${TABLE}','INSERT') i,
      has_table_privilege('app_test_user','${TABLE}','UPDATE') u,
      has_table_privilege('app_test_user','${TABLE}','DELETE') d,
      has_table_privilege('app_test_user','${TABLE}','TRUNCATE') t`)).rows[0];
    expect(p).toEqual({ r: true, i: false, u: false, d: false, t: false });
    await expect(asApp({tenant,workspace}, q => q(`INSERT INTO ${TABLE} DEFAULT VALUES`))).rejects.toThrow();
    await expect(asApp({tenant,workspace}, q => q(`UPDATE ${TABLE} SET reason_code='CORRECTION'`))).rejects.toThrow();
    await expect(asApp({tenant,workspace}, q => q(`DELETE FROM ${TABLE}`))).rejects.toThrow();
    await expect(asApp({tenant,workspace}, q => q(`TRUNCATE ${TABLE}`))).rejects.toThrow();
  });

  it('rejects foreign source and skips; database issues the timestamp and digest', async () => {
    await expect(insert(event({ offline_sale_id: otherIntake }))).rejects.toThrow();
    await expect(insert(event({ event_version: 2 }))).rejects.toThrow();
    const first = (await insert(event())).rows[0];
    expect(first.recorded_at.getUTCFullYear()).toBeGreaterThan(2020);
    expect(first.event_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(first.event_digest).not.toBe(digest);
    expect(first.digest_version).toBe('V2_UTC');
    for (const zone of ['UTC', 'Asia/Kuwait', 'America/New_York']) {
      const c = await admin.connect();
      try {
        await c.query('SELECT set_config($1,$2,false)', ['TimeZone', zone]);
        const reproduced = await c.query(`SELECT event_digest = encode(digest(jsonb_build_array(digest_version, event_id,
          tenant_id, workspace_id, business_id, offline_sale_id, client_sale_id, intake_request_digest,
          resolution_id, event_version, previous_event_id, previous_event_digest, supersedes_event_id,
          event_type, reason_code, source_reference, actor_id, service_reference, idempotency_key,
          request_digest, to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))::text,
          'sha256'), 'hex') AS matches FROM ${TABLE} WHERE event_id=$1`, [first.event_id]);
        expect(reproduced.rows[0].matches).toBe(true);
      } finally { c.release(); }
    }
  });

  it('enforces predecessor/version, replay key and append-only refusal', async () => {
    const first = (await admin.query(`SELECT * FROM ${TABLE} WHERE resolution_id=$1 AND event_version=1`, [resolution])).rows[0];
    await expect(insert(event({event_version: 2, previous_event_id: randomUUID(), previous_event_digest: first.event_digest}))).rejects.toThrow();
    const second = (await insert(event({event_version: 2, previous_event_id: first.event_id, previous_event_digest: first.event_digest}))).rows[0];
    await expect(insert(event({event_version: 2, previous_event_id: first.event_id, previous_event_digest: first.event_digest}))).rejects.toThrow();
    await expect(insert(event({event_version: 3, previous_event_id: second.event_id, previous_event_digest: second.event_digest, idempotency_key: second.idempotency_key}))).rejects.toThrow();
    await expect(admin.query(`UPDATE ${TABLE} SET reason_code='CORRECTION' WHERE event_id=$1`, [first.event_id])).rejects.toThrow();
    await expect(admin.query(`DELETE FROM ${TABLE} WHERE event_id=$1`, [first.event_id])).rejects.toThrow();
    await expect(admin.query(`TRUNCATE ${TABLE}`)).rejects.toThrow();
  });

  it('serializes concurrent next versions and rolls back failed transactions', async () => {
    const second = (await admin.query(`SELECT * FROM ${TABLE} WHERE resolution_id=$1 AND event_version=2`, [resolution])).rows[0];
    const third = () => insert(event({event_version: 3, previous_event_id: second.event_id, previous_event_digest: second.event_digest}));
    const both = await Promise.allSettled([third(), third()]);
    expect(both.filter(x => x.status === 'fulfilled')).toHaveLength(1);
    const c = await admin.connect();
    try {
      await c.query('BEGIN');
      const row = event({ resolution_id: randomUUID() });
      const keys = Object.keys(row);
      await c.query(`INSERT INTO ${TABLE} (${keys.join(',')}) VALUES (${keys.map((_,i) => `$${i+1}`).join(',')})`, Object.values(row));
      await c.query('ROLLBACK');
      expect((await admin.query(`SELECT count(*)::int n FROM ${TABLE} WHERE event_id=$1`, [row.event_id])).rows[0].n).toBe(0);
    } finally { c.release(); }
  });

  it('reads only scoped evidence; historical intake stays without events', async () => {
    const visible = await asApp({tenant,workspace}, q => q(`SELECT event_version FROM ${TABLE} WHERE business_id=$1 AND offline_sale_id=$2 ORDER BY event_version`, [business,intake]));
    expect(visible.rows.map(x => x.event_version)).toEqual([1,2,3]);
    const historical = await asApp({tenant,workspace}, q => q(`SELECT * FROM ${TABLE} WHERE business_id=$1 AND offline_sale_id=$2`, [business,historicalIntake]));
    expect(historical.rows).toEqual([]);
    const crossBusiness = await asApp({tenant,workspace}, q => q(`SELECT * FROM ${TABLE} WHERE business_id=$1`, [otherBusiness]));
    expect(crossBusiness.rows).toEqual([]);
    const other = await asApp({tenant: otherTenant,workspace: otherWorkspace}, q => q(`SELECT * FROM ${TABLE}`));
    expect(other.rows).toHaveLength(0);
    expect((await admin.query('SELECT count(*)::int n FROM platform.orders WHERE business_id=$1', [business])).rows[0].n).toBe(0);
    expect((await admin.query('SELECT count(*)::int n FROM business_operations.order_payments WHERE business_id=$1', [business])).rows[0].n).toBe(0);
  });
});
