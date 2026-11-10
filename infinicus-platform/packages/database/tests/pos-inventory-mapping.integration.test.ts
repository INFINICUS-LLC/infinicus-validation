import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { truncateRefusal } from './helpers/truncateRefusal.js';
import { createPool, closePool } from '../src/client.js';
import { PosInventoryMappingRepository } from '../src/repositories/bo/PosInventoryMappingRepository.js';

const run = !!process.env.DATABASE_URL && !!process.env.ADMIN_DATABASE_URL;
const call = `SELECT * FROM business_operations.configure_pos_inventory_mapping($1,$2,$3,$4,$5,$6,$7,$8,$9)`;

describe.runIf(run)('POS2-04-S2 governed mapping foundation (disposable PostgreSQL)', () => {
  let admin: Pool; let app: Pool;
  const tenant = randomUUID(), workspace = randomUUID(), siblingWorkspace = randomUUID(), business = randomUUID();
  const foreignBusiness = randomUUID(), siblingBusiness = randomUUID(), foreignTenant = randomUUID(), foreignWorkspace = randomUUID();
  const actor = randomUUID(), foreignActor = randomUUID(), product = randomUUID(), product2 = randomUUID(), product3 = randomUUID(), item = randomUUID();
  const foreignItem = randomUUID(), siblingItem = randomUUID(), item2 = randomUUID(), warehouse = randomUUID(), siblingWarehouse = randomUUID(), correlation = randomUUID();
  const args = [tenant, workspace, business, product, item, warehouse, actor, correlation, null];

  async function scoped<T>(scope: [string, string, string], fn: (client: PoolClient) => Promise<T>, commit = false): Promise<T> {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.workspace_id',$2,true), set_config('app.user_id',$3,true)`, scope);
      const result = await fn(client);
      if (commit) await client.query('COMMIT');
      return result;
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }
  const asActor = <T>(fn: (client: PoolClient) => Promise<T>) => scoped([tenant, workspace, actor], fn);

  beforeAll(async () => {
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
    app = new Pool({ connectionString: process.env.DATABASE_URL });
    createPool({ connectionString: process.env.DATABASE_URL! });
    await admin.query(`INSERT INTO tenancy.tenants (id,name,slug,status,plan_code) VALUES ($1,'S2',$2,'active','test'),($3,'S2',$4,'active','test')`,
      [tenant, `s2-${tenant}`, foreignTenant, `s2-${foreignTenant}`]);
    await admin.query(`INSERT INTO tenancy.workspaces (id,tenant_id,name,slug,status) VALUES ($1,$2,'S2',$3,'active'),($4,$5,'S2',$6,'active')`,
      [workspace, tenant, `s2-${workspace}`, foreignWorkspace, foreignTenant, `s2-${foreignWorkspace}`]);
    await admin.query(`INSERT INTO tenancy.workspaces (id,tenant_id,name,slug,status) VALUES ($1,$2,'S2 sibling',$3,'active')`, [siblingWorkspace, tenant, `s2-${siblingWorkspace}`]);
    for (const [id, t, w] of [[business, tenant, workspace], [foreignBusiness, foreignTenant, foreignWorkspace]]) {
      await admin.query(`INSERT INTO platform.businesses (id,tenant_id,workspace_id,legal_name,business_code,status) VALUES ($1,$2,$3,'S2',$4,'active')`, [id, t, w, `s2-${id}`]);
    }
    await admin.query(`INSERT INTO platform.businesses (id,tenant_id,workspace_id,legal_name,business_code,status) VALUES ($1,$2,$3,'S2 sibling',$4,'active')`, [siblingBusiness, tenant, workspace, `s2-${siblingBusiness}`]);
    for (const [id, email] of [[actor, `s2-${actor}@example.invalid`], [foreignActor, `s2-${foreignActor}@example.invalid`]]) {
      await admin.query(`INSERT INTO identity.users (id,email,status) VALUES ($1,$2,'active')`, [id, email]);
    }
    await admin.query(`INSERT INTO tenancy.roles (id,tenant_id,code,name,scope) VALUES ($1,$2,$3,'S2','business')`, [randomUUID(), tenant, `s2-${tenant}`]);
    const role = (await admin.query(`SELECT id FROM tenancy.roles WHERE code=$1`, [`s2-${tenant}`])).rows[0].id;
    await admin.query(`INSERT INTO tenancy.role_permissions (role_id,permission_id) SELECT $1,id FROM tenancy.permissions WHERE code='bo:admin'`, [role]);
    const membership = (await admin.query(`INSERT INTO tenancy.memberships (tenant_id,workspace_id,user_id,status) VALUES ($1,$2,$3,'active') RETURNING id`, [tenant, workspace, actor])).rows[0].id;
    await admin.query(`INSERT INTO tenancy.membership_roles (membership_id,role_id,business_id) VALUES ($1,$2,$3)`, [membership, role, business]);
    // Negative authority fixture: a foreign tenant's role is linked to a local membership.
    // The governed function must not treat its bo:admin permission as authority in this tenant.
    const foreignRole = (await admin.query(`INSERT INTO tenancy.roles (tenant_id,code,name,scope) VALUES ($1,$2,'foreign S2','business') RETURNING id`, [foreignTenant, `s2-foreign-${foreignTenant}`])).rows[0].id;
    await admin.query(`INSERT INTO tenancy.role_permissions (role_id,permission_id) SELECT $1,id FROM tenancy.permissions WHERE code='bo:admin'`, [foreignRole]);
    const foreignMembership = (await admin.query(`INSERT INTO tenancy.memberships (tenant_id,workspace_id,user_id,status) VALUES ($1,$2,$3,'active') RETURNING id`, [tenant, workspace, foreignActor])).rows[0].id;
    await admin.query(`INSERT INTO tenancy.membership_roles (membership_id,role_id,business_id) VALUES ($1,$2,$3)`, [foreignMembership, foreignRole, business]);
    await admin.query(`INSERT INTO business_operations.products (id,tenant_id,workspace_id,business_id,name,price) VALUES ($1,$2,$3,$4,'S2 product',1)`, [product, tenant, workspace, business]);
    for (const id of [product2, product3]) await admin.query(`INSERT INTO business_operations.products (id,tenant_id,workspace_id,business_id,name,price) VALUES ($1,$2,$3,$4,'S2 product',1)`, [id, tenant, workspace, business]);
    for (const [id, t, w, b] of [[item, tenant, workspace, business], [item2, tenant, workspace, business], [siblingItem, tenant, workspace, siblingBusiness], [foreignItem, foreignTenant, foreignWorkspace, foreignBusiness]]) {
      await admin.query(`INSERT INTO platform.inventory_items (id,tenant_id,workspace_id,business_id,sku,name) VALUES ($1,$2,$3,$4,$5,'S2 item')`, [id, t, w, b, `s2-${id}`]);
    }
    await admin.query(`INSERT INTO platform.warehouses (id,tenant_id,workspace_id,business_id,warehouse_code,name) VALUES ($1,$2,$3,$4,$5,'S2 warehouse')`, [warehouse, tenant, workspace, business, `s2-${warehouse}`]);
    await admin.query(`INSERT INTO platform.warehouses (id,tenant_id,workspace_id,business_id,warehouse_code,name) VALUES ($1,$2,$3,$4,$5,'S2 sibling warehouse')`, [siblingWarehouse, tenant, workspace, siblingBusiness, `s2-${siblingWarehouse}`]);
  });
  afterAll(async () => { await closePool(); await app?.end(); await admin?.end(); });

  it('forces RLS and withholds all direct application table privileges', async () => {
    const rows = (await admin.query(`SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid IN ('business_operations.pos_inventory_mappings'::regclass,'business_operations.pos_inventory_mapping_history'::regclass) ORDER BY relname`)).rows;
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    for (const name of ['pos_inventory_mappings', 'pos_inventory_mapping_history']) {
      const privileges = (await app.query(`SELECT has_table_privilege(current_user,$1,'SELECT') s,has_table_privilege(current_user,$1,'INSERT') i,has_table_privilege(current_user,$1,'UPDATE') u,has_table_privilege(current_user,$1,'DELETE') d,has_table_privilege(current_user,$1,'TRUNCATE') t`, [`business_operations.${name}`])).rows[0];
      expect(privileges).toEqual({ s: false, i: false, u: false, d: false, t: false });
    }
  });

  it('creates one explicit mapping, preserves exact factor 1 and replays without another history row', async () => {
    const result = await scoped([tenant, workspace, actor], async (c) => {
      const first = (await c.query(call, args)).rows[0];
      const replay = (await c.query(call, args)).rows[0];
      expect(replay).toEqual({ mapping_id: first.mapping_id, changed: false });
      return first;
    }, true);
    expect(result.changed).toBe(true);
    const mapping = (await admin.query(`SELECT unit_conversion_factor::text factor,inventory_unit_of_measure,state FROM business_operations.pos_inventory_mappings WHERE id=$1`, [result.mapping_id])).rows[0];
    expect(mapping).toMatchObject({ factor: '1', inventory_unit_of_measure: 'unit', state: 'active' });
    expect((await admin.query(`SELECT count(*)::int n FROM business_operations.pos_inventory_mapping_history WHERE mapping_id=$1`, [result.mapping_id])).rows[0].n).toBe(1);
  });

  it('refuses foreign item, foreign scope, spoofed actor and an unprivileged actor', async () => {
    await expect(asActor(c => c.query(call, [tenant, workspace, business, product2, foreignItem, warehouse, actor, correlation, null]))).rejects.toThrow(/invalid inventory item/i);
    await expect(asActor(c => c.query(call, [tenant, workspace, business, product2, siblingItem, warehouse, actor, correlation, null]))).rejects.toThrow(/invalid inventory item/i);
    await expect(asActor(c => c.query(call, [tenant, workspace, business, product2, item, siblingWarehouse, actor, correlation, null]))).rejects.toThrow(/warehouse scope/i);
    await expect(scoped([foreignTenant, foreignWorkspace, actor], c => c.query(call, args))).rejects.toThrow(/scope mismatch/i);
    await expect(scoped([tenant, siblingWorkspace, actor], c => c.query(call, args))).rejects.toThrow(/scope mismatch/i);
    await expect(scoped([tenant, workspace, foreignActor], c => c.query(call, args))).rejects.toThrow(/scope mismatch/i);
    await expect(scoped([tenant, workspace, foreignActor], c => c.query(call, [...args.slice(0, 6), foreignActor, ...args.slice(7)]))).rejects.toThrow(/bo:admin/i);
    await expect(asActor(c => c.query(call, [tenant, workspace, siblingBusiness, product2, item, warehouse, actor, correlation, null]))).rejects.toThrow(/bo:admin/i);
  });

  it('refuses conflicting association, direct mutation, and leaves inventory and orders unchanged', async () => {
    await asActor(async (c) => {
      const before = (await admin.query(`SELECT count(*)::int n FROM business_operations.inventory_movements`)).rows[0].n;
      await c.query(call, args);
      await expect(c.query(call, [...args.slice(0, 4), item2, ...args.slice(5)])).rejects.toThrow(/conflicting active association/i);
      expect((await admin.query(`SELECT count(*)::int n FROM business_operations.inventory_movements`)).rows[0].n).toBe(before);
    });
    await expect(app.query(`INSERT INTO business_operations.pos_inventory_mappings DEFAULT VALUES`)).rejects.toThrow(/permission denied/i);
  });

  it('rolls back a new mapping and audit history together', async () => {
    const before = (await admin.query(`SELECT count(*)::int n FROM business_operations.pos_inventory_mappings WHERE catalog_product_id=$1`, [product2])).rows[0].n;
    await asActor(async c => { expect((await c.query(call, [tenant, workspace, business, product2, item, warehouse, actor, correlation, null])).rows[0].changed).toBe(true); });
    expect((await admin.query(`SELECT count(*)::int n FROM business_operations.pos_inventory_mappings WHERE catalog_product_id=$1`, [product2])).rows[0].n).toBe(before);
  });

  it('refuses a fractional conversion even when PostgreSQL would round numeric(18,4)', async () => {
    const client = await admin.connect();
    try {
      await client.query('BEGIN');
      // Privileged mutation probe: reach the CHECK independently of the governed function, which always supplies exactly 1.
      await client.query(`SELECT set_config('app.pos_mapping_writer','configure',true)`);
      await expect(client.query(`INSERT INTO business_operations.pos_inventory_mappings
        (tenant_id,workspace_id,business_id,catalog_product_id,inventory_item_id,warehouse_id,unit_conversion_factor,inventory_unit_of_measure,state,created_by)
        VALUES ($1,$2,$3,$4,$5,$6,'1.00001','unit','active',$7)`,
      [tenant, workspace, business, product2, item, warehouse, actor])).rejects.toThrow(/unit_conversion_factor/);
    } finally { await client.query('ROLLBACK'); client.release(); }
  });

  it('serializes concurrent first creation and records exactly one audit transition', async () => {
    const newArgs = [tenant, workspace, business, product3, item, warehouse, actor, correlation, null];
    const result = await Promise.all([
      scoped([tenant, workspace, actor], c => c.query(call, newArgs), true),
      scoped([tenant, workspace, actor], c => c.query(call, newArgs), true),
    ]);
    expect(result.map(r => r.rows[0].changed).sort()).toEqual([false, true]);
    expect(result[0].rows[0].mapping_id).toBe(result[1].rows[0].mapping_id);
    expect((await admin.query(`SELECT count(*)::int n FROM business_operations.pos_inventory_mapping_history WHERE mapping_id=$1`, [result[0].rows[0].mapping_id])).rows[0].n).toBe(1);
  });

  it('refuses administrator mutation and preserves state through failed writes', async () => {
    const id = (await admin.query(`SELECT id FROM business_operations.pos_inventory_mappings WHERE catalog_product_id=$1 AND state='active'`, [product])).rows[0].id;
    await expect(admin.query(`UPDATE business_operations.pos_inventory_mappings SET state='inactive',deactivated_at=clock_timestamp() WHERE id=$1`, [id])).rejects.toThrow(/governed writer/i);
    await expect(admin.query(`DELETE FROM business_operations.pos_inventory_mappings WHERE id=$1`, [id])).rejects.toThrow(/append-only/i);
    // Include the referencing history table so PostgreSQL's FK precheck cannot mask the trigger proof.
    await expect(truncateRefusal(admin, `TRUNCATE business_operations.pos_inventory_mappings, business_operations.pos_inventory_mapping_history, business_operations.pos_inventory_sale_effects`)).rejects.toThrow(/append-only/i);
    expect((await admin.query(`SELECT state FROM business_operations.pos_inventory_mappings WHERE id=$1`, [id])).rows[0].state).toBe('active');
  });

  it('RLS hides rows under foreign and empty tenant/workspace even with temporary SELECT', async () => {
    const client = await admin.connect();
    try {
      await client.query('BEGIN');
      await client.query(`GRANT SELECT ON business_operations.pos_inventory_mappings TO app_test_user`);
      await client.query(`SET LOCAL ROLE app_test_user`);
      const count = async () => (await client.query(`SELECT count(*)::int n FROM business_operations.pos_inventory_mappings`)).rows[0].n as number;
      expect(await count()).toBe(0);
      await client.query(`SELECT set_config('app.tenant_id',$1,true),set_config('app.workspace_id',$2,true)`, [foreignTenant, foreignWorkspace]);
      expect(await count()).toBe(0);
      await client.query(`SELECT set_config('app.tenant_id',$1,true),set_config('app.workspace_id',$2,true)`, [tenant, siblingWorkspace]);
      expect(await count()).toBe(0);
      await client.query(`SELECT set_config('app.tenant_id',$1,true),set_config('app.workspace_id',$2,true)`, [tenant, workspace]);
      expect(await count()).toBeGreaterThan(0);
    } finally {
      await client.query('ROLLBACK'); client.release();
    }
  });

  it('deactivates via the governed function and appends an immutable transition', async () => {
    const id = (await admin.query(`SELECT id FROM business_operations.pos_inventory_mappings WHERE catalog_product_id=$1 AND state='active'`, [product])).rows[0].id;
    const result = await scoped([tenant, workspace, actor], c => c.query(call, [tenant, workspace, business, product, null, null, actor, correlation, id]), true);
    expect(result.rows[0]).toEqual({ mapping_id: id, changed: true });
    expect((await admin.query(`SELECT state FROM business_operations.pos_inventory_mappings WHERE id=$1`, [id])).rows[0].state).toBe('inactive');
    expect((await admin.query(`SELECT transition FROM business_operations.pos_inventory_mapping_history WHERE mapping_id=$1 ORDER BY occurred_at`, [id])).rows.map(r => r.transition)).toEqual(['created', 'deactivated']);
    await expect(admin.query(`DELETE FROM business_operations.pos_inventory_mapping_history WHERE mapping_id=$1`, [id])).rejects.toThrow(/append-only/i);
  });

  it('the TypeScript repository binds the canonical transaction context and replays the same association', async () => {
    const repo = new PosInventoryMappingRepository();
    const ctx = { tenantId: tenant, workspaceId: workspace, userId: actor };
    const command = { businessId: business, catalogProductId: product2, inventoryItemId: item,
      warehouseId: warehouse, correlationId: correlation };
    const first = await repo.configure(ctx, command);
    const replay = await repo.configure(ctx, command);
    expect(first.changed).toBe(true);
    expect(replay).toEqual({ mappingId: first.mappingId, changed: false });
  });
});
