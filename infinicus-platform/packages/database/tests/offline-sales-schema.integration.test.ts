/**
 * OFF-1 step 2 - migration 0210 (offline_sales + orders.client_sale_id) - live PostgreSQL proof.
 * Requires DATABASE_URL (application role, RLS enforced) and ADMIN_DATABASE_URL (superuser), migrated through 0210.
 * Schema only: the service and route (later OFF-1 steps) do not exist yet, so every row here is written directly.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { truncateRefusal } from './helpers/truncateRefusal.js';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { withExclusiveLocksNoWait } from './helpers/ddlProof.js';

const run = !!process.env.DATABASE_URL;
const MIGRATION_FILE = resolve(__dirname, '../../../infrastructure/database/migrations/0210_create_offline_sales.sql');
const MIGRATION = readFileSync(MIGRATION_FILE, 'utf8');
const T = 'business_operations.offline_sales';
const APPEND_ONLY = (op: string) => new RegExp(`business_operations\\.offline_sales: append-only table - ${op} is not permitted`);
const DIGEST = 'a'.repeat(64);

type Row = Record<string, unknown>;

describe.runIf(run)('migration 0210 - offline_sales schema - live PostgreSQL', () => {
  let admin: Pool; let app: Pool;
  let t = ''; let ws = ''; let biz = ''; let biz2 = ''; let otherT = ''; let otherWs = ''; let otherBiz = '';
  let session = ''; let session2 = ''; let otherSession = '';
  const sessions: Record<string, string> = {};

  /** Superuser insert: bypasses RLS so the constraints and triggers are exercised on their own. */
  const insertAdmin = (row: Row, table = T) => {
    const cols = Object.keys(row);
    return admin.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`, cols.map((c) => row[c]));
  };
  const makeOrder = async (over: Row = {}): Promise<string> => {
    const row: Row = {
      tenant_id: t, workspace_id: ws, business_id: biz, order_number: `ORD-T-${randomUUID().slice(0, 8)}`, order_date: '2026-10-21',
      currency_code: 'KWD', register_session_id: session, operational_status: 'completed', client_sale_id: randomUUID(), ...over,
    };
    return (await insertAdmin(row, 'platform.orders')).rows[0].id as string;
  };
  const orderSale = async (orderId: string): Promise<string> =>
    (await admin.query('SELECT client_sale_id FROM platform.orders WHERE id = $1', [orderId])).rows[0].client_sale_id as string;

  /** A valid needs_review row (no order); overrides adjust it. */
  const review = (over: Row = {}): Row => ({
    tenant_id: t, workspace_id: ws, business_id: biz, client_sale_id: randomUUID(), device_id: 'tablet-1', claimed_register_session_id: session,
    register_session_id: session, outcome: 'needs_review', review_reason: 'underpaid', currency_code: 'KWD',
    device_created_at: '2026-10-21T10:00:00Z', clock_skew_seconds: 2, catalogue_snapshot_at: '2026-10-21T09:00:00Z',
    device_total_minor: 1500, server_total_minor: 1750, difference_minor: 250, request_digest: DIGEST, lines_detail: JSON.stringify([{ product_id: randomUUID(), quantity: 1 }]),
    ...over,
  });
  /** A valid accepted row for an order created by makeOrder. */
  const accepted = async (over: Row = {}, orderOver: Row = {}): Promise<Row> => {
    const orderId = await makeOrder(orderOver);
    return review({
      client_sale_id: await orderSale(orderId), order_id: orderId, outcome: 'accepted', review_reason: null,
      server_total_minor: 1500, difference_minor: 0, ...over,
    });
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- query rows are untyped in this live-database proof
  const asApp = async <R>(scope: { t: string; ws: string } | null, fn: (q: (s: string, p?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>) => Promise<R>): Promise<R> => {
    const c = await app.connect();
    try {
      await c.query('BEGIN');
      if (scope) await c.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.workspace_id',$2,true)`, [scope.t, scope.ws]);
      return await fn((s, p) => c.query(s, p));
    } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
  };

  beforeAll(async () => {
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL! });
    app = new Pool({ connectionString: process.env.DATABASE_URL! });
    t = randomUUID(); ws = randomUUID(); biz = randomUUID(); biz2 = randomUUID(); otherT = randomUUID(); otherWs = randomUUID(); otherBiz = randomUUID();
    for (const [tt, ww] of [[t, ws], [otherT, otherWs]]) {
      await admin.query(`INSERT INTO tenancy.tenants (id, name, slug, status, plan_code) VALUES ($1,'Offline 0210',$2,'active','test')`, [tt, `off-${tt}`]);
      await admin.query(`INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,'WS',$3,'active')`, [ww, tt, `ws-${ww}`]);
    }
    for (const [b, tt, ww] of [[biz, t, ws], [biz2, t, ws], [otherBiz, otherT, otherWs]]) {
      await admin.query(`INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,$3,'Off Biz',$4,'active')`, [b, tt, ww, `off-${b}`]);
    }
    for (const [key, b, tt, ww] of [['s1', biz, t, ws], ['s2', biz2, t, ws], ['other', otherBiz, otherT, otherWs]] as const) {
      const r = await insertAdmin({ tenant_id: tt, workspace_id: ww, business_id: b, opening_cash: 0, currency_code: 'KWD' }, 'business_operations.register_sessions');
      sessions[key] = r.rows[0].id as string;
    }
    session = sessions.s1; session2 = sessions.s2; otherSession = sessions.other;
  });
  afterAll(async () => {
    const c = await admin.connect();
    try {
      await c.query('BEGIN');
      await c.query("SET LOCAL session_replication_role = 'replica'");
      const ids = [t, otherT];
      for (const tbl of ['business_operations.offline_sales', 'business_operations.order_payments', 'platform.orders', 'business_operations.register_sessions', 'platform.businesses', 'tenancy.workspaces']) {
        await c.query(`DELETE FROM ${tbl} WHERE tenant_id = ANY($1)`, [ids]);
      }
      await c.query('DELETE FROM tenancy.tenants WHERE id = ANY($1)', [ids]);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
    await admin.end(); await app.end();
  });

  describe('structure', () => {
    it('RLS is enabled AND forced, with exactly the standard tenant + workspace policy', async () => {
      expect((await admin.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = '${T}'::regclass`)).rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      const pol = (await admin.query(`SELECT policyname, permissive, roles::text r, cmd, qual, with_check FROM pg_policies WHERE schemaname='business_operations' AND tablename='offline_sales'`)).rows;
      expect(pol).toHaveLength(1);
      expect(pol[0]).toMatchObject({ policyname: 'offline_sales_isolation', permissive: 'PERMISSIVE', r: '{public}', cmd: 'ALL', with_check: null });
      expect(pol[0].qual).toBe("((tenant_id = (current_setting('app.tenant_id'::text, true))::uuid) AND (workspace_id = (current_setting('app.workspace_id'::text, true))::uuid))");
    });

    it('carries the append-only guards, the consistency guard, and the partial unique index; the order column is nullable', async () => {
      const trg = (await admin.query(`SELECT tgname, pg_get_triggerdef(oid) d FROM pg_trigger WHERE tgrelid = '${T}'::regclass AND NOT tgisinternal ORDER BY tgname`)).rows;
      expect(trg.map((r) => r.tgname)).toEqual(['check_offline_sale_consistency_trg', 'forbid_mutation_offline_sales', 'forbid_truncate_offline_sales']);
      expect(trg.find((r) => r.tgname === 'forbid_mutation_offline_sales').d).toMatch(/BEFORE (UPDATE OR DELETE|DELETE OR UPDATE) .* FOR EACH ROW/);
      expect(trg.find((r) => r.tgname === 'forbid_truncate_offline_sales').d).toMatch(/BEFORE TRUNCATE .* FOR EACH STATEMENT/);
      const idx = (await admin.query(`SELECT indexdef FROM pg_indexes WHERE schemaname='platform' AND indexname='orders_business_client_sale_unique'`)).rows[0].indexdef as string;
      expect(idx).toMatch(/CREATE UNIQUE INDEX .* \(business_id, client_sale_id\) WHERE \(client_sale_id IS NOT NULL\)/);
      const col = (await admin.query(`SELECT data_type, is_nullable FROM information_schema.columns WHERE table_schema='platform' AND table_name='orders' AND column_name='client_sale_id'`)).rows[0];
      expect(col).toEqual({ data_type: 'uuid', is_nullable: 'YES' });
      const fn = (await admin.query(`SELECT prosecdef FROM pg_proc WHERE oid = 'business_operations.check_offline_sale_consistency()'::regprocedure`)).rows[0];
      expect(fn.prosecdef).toBe(false);
    });

    it('the application role is not the owner, not a superuser and not BYPASSRLS', async () => {
      const u = (await app.query('SELECT current_user u')).rows[0].u as string;
      const r = (await admin.query(`SELECT r.rolsuper, r.rolbypassrls, (c.relowner = r.oid) AS owns FROM pg_roles r, pg_class c WHERE r.rolname = $1 AND c.oid = '${T}'::regclass`, [u])).rows[0];
      expect(r).toEqual({ rolsuper: false, rolbypassrls: false, owns: false });
    });
  });

  describe('valid rows', () => {
    it('stores a needs_review row with no order, an accepted row and an accepted_with_difference row', async () => {
      await expect(insertAdmin(review())).resolves.toBeTruthy();
      await expect(insertAdmin(await accepted())).resolves.toBeTruthy();
      await expect(insertAdmin(await accepted({ outcome: 'accepted_with_difference', server_total_minor: 1600, difference_minor: 100 }))).resolves.toBeTruthy();
    });

    it('a needs_review row may name a session the server could not verify (claimed id only, no foreign key on the claim)', async () => {
      await expect(insertAdmin(review({ claimed_register_session_id: randomUUID(), register_session_id: null, review_reason: 'session_not_found', server_total_minor: null, difference_minor: null }))).resolves.toBeTruthy();
    });

    it('every review_reason code is accepted', async () => {
      for (const reason of ['session_not_found', 'session_closed', 'session_currency_mismatch', 'product_unavailable', 'price_drift_not_allowed', 'underpaid', 'invariant_failed', 'other']) {
        await expect(insertAdmin(review({ review_reason: reason }))).resolves.toBeTruthy();
      }
    });
  });

  describe('invariants refused by the database', () => {
    const refused = async (row: Row | Promise<Row>, message: RegExp) => { await expect(insertAdmin(await row)).rejects.toThrow(message); };

    it('review_reason exists exactly when the outcome is needs_review', async () => {
      await refused(review({ review_reason: null }), /offline_sales_review_reason_iff_review/);
      await refused(accepted({ review_reason: 'underpaid' }), /offline_sales_review_reason_iff_review/);
    });

    it('an order exists exactly when the outcome is accepted or accepted_with_difference', async () => {
      await refused(review({ order_id: await makeOrder() }), /offline_sales_order_iff_accepted|offline_sales: order .* was not created for client_sale_id/);
      await refused(accepted({ order_id: null }), /offline_sales_order_iff_accepted/);
    });

    it('an accepted outcome needs a verified register session (checked after the consistency guard, so the order has no session either)', async () => {
      const orderId = await makeOrder({ register_session_id: null });
      await refused(review({ client_sale_id: await orderSale(orderId), order_id: orderId, outcome: 'accepted', review_reason: null, register_session_id: null, server_total_minor: 1500, difference_minor: 0 }), /offline_sales_accepted_has_verified_session/);
    });

    it('difference is exactly server minus device, and both are present or both absent', async () => {
      await refused(review({ difference_minor: 249 }), /offline_sales_difference_is_server_minus_device/);
      await refused(review({ server_total_minor: null, difference_minor: 250 }), /offline_sales_difference_is_server_minus_device/);
      await refused(review({ server_total_minor: 1750, difference_minor: null }), /offline_sales_difference_is_server_minus_device/);
    });

    it('an accepted outcome carries a server total, and an exact accept carries no difference', async () => {
      await refused(accepted({ outcome: 'accepted_with_difference', server_total_minor: null, difference_minor: null }), /offline_sales_accepted_has_server_total/);
      await refused(accepted({ outcome: 'accepted', server_total_minor: 1600, difference_minor: 100 }), /offline_sales_exact_accept_has_no_difference/);
    });

    it('rejects an unknown outcome or reason, a bad currency, a bad digest, a non-array detail and negative totals', async () => {
      await refused(review({ outcome: 'accepted_maybe' }), /violates check constraint "offline_sales_/);
      await refused(review({ review_reason: 'because' }), /offline_sales_review_reason_check/);
      await refused(review({ currency_code: 'kwd' }), /offline_sales_currency_code_check/);
      await refused(review({ currency_code: 'KWDD' }), /offline_sales_currency_code_check/);
      await refused(review({ request_digest: 'A'.repeat(64) }), /offline_sales_request_digest_check/);
      await refused(review({ request_digest: 'a'.repeat(63) }), /offline_sales_request_digest_check/);
      await refused(review({ lines_detail: JSON.stringify({ not: 'an array' }) }), /offline_sales_lines_detail_check/);
      await refused(review({ device_total_minor: -1, server_total_minor: null, difference_minor: null }), /offline_sales_device_total_minor_check/);
      await refused(review({ server_total_minor: -5, difference_minor: -1505 }), /offline_sales_server_total_minor_check/);
    });

    it('device_id is 1-64 characters from a safe set', async () => {
      for (const bad of ['', 'x'.repeat(65), 'has space', 'semi;colon', "quote'", 'ünïcode']) await refused(review({ device_id: bad }), /offline_sales_device_id_check/);
      for (const good of ['a', 'x'.repeat(64), 'tab-1_A.b:c']) await expect(insertAdmin(review({ device_id: good }))).resolves.toBeTruthy();
    });

    it('one record per client_sale_id per business, but the same id may exist in another business', async () => {
      const id = randomUUID();
      await insertAdmin(review({ client_sale_id: id }));
      await refused(review({ client_sale_id: id }), /offline_sales_business_client_sale_unique/);
      await expect(insertAdmin(review({ client_sale_id: id, business_id: biz2, claimed_register_session_id: session2, register_session_id: session2 }))).resolves.toBeTruthy();
    });

    it('a verified register session or an order from another business is refused by the composite foreign keys', async () => {
      await refused(review({ register_session_id: session2 }), /offline_sales_session_same_business_fk/);
      // the order and the claimed session both belong to biz2 while the row says biz: the consistency guard passes (order and row agree on the session),
      // so the business-scoped composite foreign keys refuse it (the order key and the session key are both violated; PostgreSQL reports the first)
      const foreignOrder = await makeOrder({ business_id: biz2, register_session_id: session2 });
      await refused(review({ client_sale_id: await orderSale(foreignOrder), order_id: foreignOrder, outcome: 'accepted', review_reason: null, register_session_id: session2, server_total_minor: 1500, difference_minor: 0 }), /violates foreign key constraint "offline_sales_(order|session)_same_business_fk"/);
    });
  });

  describe('consistency guard (before insert)', () => {
    it('refuses an order that is not completed', async () => {
      const row = await accepted({}, { operational_status: 'planned' });
      await expect(insertAdmin(row)).rejects.toThrow(/offline_sales: order .* is planned, an accepted offline sale needs a completed order/);
    });
    it('refuses an order created for a different client_sale_id', async () => {
      const row = await accepted({ client_sale_id: randomUUID() });
      await expect(insertAdmin(row)).rejects.toThrow(/was not created for client_sale_id/);
    });
    it('refuses an order taken in a different register session', async () => {
      const orderId = await makeOrder();
      const other = (await insertAdmin({ tenant_id: t, workspace_id: ws, business_id: biz, opening_cash: 0, currency_code: 'KWD', status: 'closed', closed_at: '2026-10-20T20:00:00Z', closing_cash: 0 }, 'business_operations.register_sessions')).rows[0].id as string;
      await expect(insertAdmin(review({ client_sale_id: await orderSale(orderId), order_id: orderId, outcome: 'accepted', review_reason: null, register_session_id: other, claimed_register_session_id: other, server_total_minor: 1500, difference_minor: 0 }))).rejects.toThrow(/register session differs/);
    });
    it('refuses a sale whose currency differs from the order\'s', async () => {
      const row = await accepted({ currency_code: 'USD' });
      await expect(insertAdmin(row)).rejects.toThrow(/sale currency USD differs from order currency KWD/);
    });
    it('does not interfere with a needs_review row (no order)', async () => {
      await expect(insertAdmin(review())).resolves.toBeTruthy();
    });
  });

  describe('orders.client_sale_id', () => {
    it('is unique per business when set; the same id in another business and any number of NULLs are allowed', async () => {
      const id = randomUUID();
      await makeOrder({ client_sale_id: id });
      await expect(makeOrder({ client_sale_id: id })).rejects.toThrow(/orders_business_client_sale_unique/);
      await expect(makeOrder({ client_sale_id: id, business_id: biz2, register_session_id: session2 })).resolves.toBeTruthy();
      await makeOrder({ client_sale_id: null }); await makeOrder({ client_sale_id: null });
    });
  });

  describe('append-only', () => {
    let id = '';
    beforeAll(async () => { id = (await insertAdmin(review())).rows[0].id as string; });
    it('refuses UPDATE, DELETE and TRUNCATE for the superuser', async () => {
      await expect(admin.query(`UPDATE ${T} SET device_id = 'x' WHERE id = $1`, [id])).rejects.toThrow(APPEND_ONLY('UPDATE'));
      await expect(admin.query(`DELETE FROM ${T} WHERE id = $1`, [id])).rejects.toThrow(APPEND_ONLY('DELETE'));
      // 0217 adds a child FK. Include both tables so PostgreSQL reaches the
      // append-only TRUNCATE triggers rather than stopping at the FK precheck.
      await expect(truncateRefusal(admin, `TRUNCATE ${T}, business_operations.offline_review_evidence`))
        .rejects.toThrow(/business_operations\.(offline_sales|offline_review_evidence): append-only table - TRUNCATE is not permitted/);
    });
    it('refuses UPDATE and DELETE for the application role inside its own tenant', async () => {
      await asApp({ t, ws }, async (q) => {
        await q('SAVEPOINT a');
        await expect(q(`UPDATE ${T} SET device_id = 'x' WHERE id = $1`, [id])).rejects.toThrow(APPEND_ONLY('UPDATE'));
        await q('ROLLBACK TO a');
        await expect(q(`DELETE FROM ${T} WHERE id = $1`, [id])).rejects.toThrow(APPEND_ONLY('DELETE'));
      });
    });
  });

  describe('tenant isolation (application role)', () => {
    let mine = ''; let theirs = '';
    beforeAll(async () => {
      mine = (await insertAdmin(review())).rows[0].id as string;
      theirs = (await insertAdmin(review({ tenant_id: otherT, workspace_id: otherWs, business_id: otherBiz, claimed_register_session_id: otherSession, register_session_id: otherSession }))).rows[0].id as string;
    });
    it('sees only its own tenant and workspace rows', async () => {
      const ids = await asApp({ t, ws }, async (q) => (await q(`SELECT id FROM ${T}`)).rows.map((r) => r.id));
      expect(ids).toContain(mine); expect(ids).not.toContain(theirs);
      const other = await asApp({ t: otherT, ws: otherWs }, async (q) => (await q(`SELECT id FROM ${T}`)).rows.map((r) => r.id));
      expect(other).toContain(theirs); expect(other).not.toContain(mine);
    });
    it('right tenant but wrong workspace sees nothing', async () => {
      expect(await asApp({ t, ws: otherWs }, async (q) => (await q(`SELECT id FROM ${T}`)).rows)).toEqual([]);
    });
    it('no tenant context fails closed (zero rows or an error, never data)', async () => {
      const r = await asApp(null, async (q) => q(`SELECT id FROM ${T}`)).then((x) => ({ rows: x.rows, error: '' }), (e: Error) => ({ rows: [] as unknown[], error: e.message }));
      expect(r.rows).toEqual([]);
      if (r.error) expect(r.error).toMatch(/invalid input syntax for type uuid|row-level security/i);
    });
    it('cannot insert a row for another tenant, and can insert its own', async () => {
      const own = review({ client_sale_id: randomUUID() });
      const cols = Object.keys(own); const vals = cols.map((c) => own[c]);
      const ins = (row: string[]) => `INSERT INTO ${T} (${row.join(',')}) VALUES (${row.map((_, i) => `$${i + 1}`).join(',')})`;
      await expect(asApp({ t, ws }, async (q) => q(ins(cols), vals))).resolves.toMatchObject({ rowCount: 1 });
      const foreign = review({ tenant_id: otherT, workspace_id: otherWs, business_id: otherBiz, claimed_register_session_id: otherSession, register_session_id: otherSession });
      const fcols = Object.keys(foreign); const fvals = fcols.map((c) => foreign[c]);
      await expect(asApp({ t, ws }, async (q) => q(ins(fcols), fvals))).rejects.toThrow(/row-level security/i);
    });
  });

  /** Every table the 0210 rollback / re-apply locks exclusively (measured with pg_locks): see helpers/ddlProof.ts for why this is taken up front with NOWAIT. */
  const LOCKED = ['business_operations.offline_review_evidence', 'business_operations.offline_sales', 'platform.orders', 'platform.businesses', 'business_operations.register_sessions', 'tenancy.workspaces', 'tenancy.tenants', 'identity.users'];

  describe('rollback block and idempotency', () => {
    const rollbackStatements = (): string[] =>
      MIGRATION.split('\n').filter((l) => /^--\s{3}(DROP|ALTER)/.test(l)).map((l) => l.replace(/^--\s+/, '').replace(/\s+--.*$/, ''));

    it('the documented rollback removes exactly the 0210 objects, and nothing else changes (proven inside a transaction that is rolled back)', async () => {
      const stmts = rollbackStatements();
      expect(stmts).toHaveLength(4);
      const objects = async (c: { query: Pool['query'] }) => ({
        table: (await c.query(`SELECT to_regclass('${T}') IS NOT NULL AS x`)).rows[0].x,
        fn: (await c.query(`SELECT to_regprocedure('business_operations.check_offline_sale_consistency()') IS NOT NULL AS x`)).rows[0].x,
        idx: (await c.query(`SELECT to_regclass('platform.orders_business_client_sale_unique') IS NOT NULL AS x`)).rows[0].x,
        col: (await c.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='platform' AND table_name='orders' AND column_name='client_sale_id'`)).rows[0].n,
        ordersCols: (await c.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='platform' AND table_name='orders'`)).rows[0].n,
      });
      await withExclusiveLocksNoWait(admin, { tables: LOCKED }, async (c) => {
        const before = await objects(c);
        expect(before).toMatchObject({ table: true, fn: true, idx: true, col: 1 });
        await c.query("SET LOCAL lock_timeout = '5s'");                  // a safety net only: the locks are already held, so nothing below waits
        // Prove the historical 0210 rollback in a disposable transaction with
        // its later 0217 dependent relation removed first. The outer rollback
        // restores both; neither migration's production history is rewritten.
        expect((await c.query("SELECT to_regclass('business_operations.offline_review_evidence') IS NOT NULL AS x")).rows[0].x).toBe(true);
        await c.query('DROP TABLE business_operations.offline_review_evidence');
        for (const s of stmts) await c.query(s);
        const during = await objects(c);
        expect(during).toMatchObject({ table: false, fn: false, idx: false, col: 0, ordersCols: before.ordersCols - 1 });
        await c.query('ROLLBACK');
        await c.query('BEGIN');                                          // the helper rolls this one back too
        expect(await objects(c)).toEqual(before);
        expect((await c.query("SELECT to_regclass('business_operations.offline_review_evidence') IS NOT NULL AS x")).rows[0].x).toBe(true);
      });
    });

    it('re-applying the migration is a no-op: no duplicate objects, no duplicate ledger row, rows untouched', async () => {
      const count = async () => Number((await admin.query(`SELECT count(*) n FROM ${T} WHERE tenant_id = $1`, [t])).rows[0].n);
      const before = await count();
      const cols = async () => (await admin.query(`SELECT count(*)::int n FROM information_schema.columns WHERE table_schema='business_operations' AND table_name='offline_sales'`)).rows[0].n;
      const colsBefore = await cols();
      // The migration carries its own BEGIN/COMMIT: the locks taken up front are held until that COMMIT, so its statements wait for nothing.
      for (let i = 0; i < 2; i++) await withExclusiveLocksNoWait(admin, { tables: LOCKED }, (c) => c.query(MIGRATION));
      expect(await count()).toBe(before);
      expect(await cols()).toBe(colsBefore);
      expect((await admin.query(`SELECT count(*)::int n FROM _migrations WHERE filename = '0210_create_offline_sales.sql'`)).rows[0].n).toBe(1);
      expect((await admin.query(`SELECT count(*)::int n FROM pg_trigger WHERE tgrelid = '${T}'::regclass AND NOT tgisinternal`)).rows[0].n).toBe(3);
      expect((await admin.query(`SELECT count(*)::int n FROM pg_policies WHERE schemaname='business_operations' AND tablename='offline_sales'`)).rows[0].n).toBe(1);
    });
  });
});
