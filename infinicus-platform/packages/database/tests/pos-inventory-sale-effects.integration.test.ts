import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';

const run = !!process.env.DATABASE_URL && !!process.env.ADMIN_DATABASE_URL;
const insertEvidence = `INSERT INTO business_operations.pos_inventory_sale_effects
  (tenant_id,workspace_id,business_id,order_id,order_line_id,completion_event_id,
   catalog_product_id,mapping_id,inventory_item_id,warehouse_id,inventory_unit_of_measure,
   sale_line_quantity,unit_conversion_factor,effect_quantity,completed_at,correlation_id)
 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'unit','2.5000',1,'2.5000',$11,$12) RETURNING id`;

describe.runIf(run)('POS2-04-S3 immutable, inert sale-effect evidence (disposable PG16)', () => {
  let admin: Pool;
  let app: Pool;
  const tenant = randomUUID(), workspace = randomUUID(), business = randomUUID();
  const actor = randomUUID(), product = randomUUID(), item = randomUUID(), warehouse = randomUUID();
  const order = randomUUID(), line = randomUUID(), note = randomUUID(), completion = randomUUID();
  const correlation = randomUUID();
  let mapping = '';
  let completedAt: string;
  let args: unknown[];

  async function scoped<T>(fn: (c: PoolClient) => Promise<T>, commit = false): Promise<T> {
    const c = await app.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.tenant_id',$1,true),
        set_config('app.workspace_id',$2,true),set_config('app.user_id',$3,true)`,
      [tenant, workspace, actor]);
      const result = await fn(c);
      if (commit) await c.query('COMMIT');
      return result;
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
    app = new Pool({ connectionString: process.env.DATABASE_URL });
    await admin.query(`INSERT INTO tenancy.tenants(id,name,slug,status,plan_code) VALUES
      ($1,'S3 test',$2,'active','test')`, [tenant, `s3-${tenant}`]);
    await admin.query(`INSERT INTO tenancy.workspaces(id,tenant_id,name,slug,status) VALUES
      ($1,$2,'S3 workspace',$3,'active')`, [workspace,tenant,`s3-${workspace}`]);
    await admin.query(`INSERT INTO platform.businesses(id,tenant_id,workspace_id,legal_name,business_code,status)
      VALUES ($1,$2,$3,'S3 business',$4,'active')`, [business,tenant,workspace,`s3-${business}`]);
    await admin.query(`INSERT INTO identity.users(id,email,status) VALUES($1,$2,'active')`,
      [actor,`s3-${actor}@example.invalid`]);
    const role = (await admin.query(`INSERT INTO tenancy.roles(tenant_id,code,name,scope)
      VALUES($1,$2,'S3','business') RETURNING id`, [tenant,`s3-${tenant}`])).rows[0].id as string;
    await admin.query(`INSERT INTO tenancy.role_permissions(role_id,permission_id)
      SELECT $1,id FROM tenancy.permissions WHERE code='bo:admin'`, [role]);
    const member = (await admin.query(`INSERT INTO tenancy.memberships(tenant_id,workspace_id,user_id,status)
      VALUES($1,$2,$3,'active') RETURNING id`, [tenant,workspace,actor])).rows[0].id as string;
    await admin.query(`INSERT INTO tenancy.membership_roles(membership_id,role_id,business_id)
      VALUES($1,$2,$3)`, [member,role,business]);
    await admin.query(`INSERT INTO business_operations.products
      (id,tenant_id,workspace_id,business_id,name,price)
      VALUES($1,$2,$3,$4,'S3 product',0)`, [product,tenant,workspace,business]);
    await admin.query(`INSERT INTO platform.inventory_items
      (id,tenant_id,workspace_id,business_id,sku,name)
      VALUES($1,$2,$3,$4,$5,'S3 item')`, [item,tenant,workspace,business,`s3-${item}`]);
    await admin.query(`INSERT INTO platform.warehouses
      (id,tenant_id,workspace_id,business_id,warehouse_code,name)
      VALUES($1,$2,$3,$4,$5,'S3 warehouse')`, [warehouse,tenant,workspace,business,`s3-${warehouse}`]);

    mapping = await scoped(async c => (await c.query(
      'SELECT * FROM business_operations.configure_pos_inventory_mapping($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [tenant,workspace,business,product,item,warehouse,actor,randomUUID(),null])).rows[0].mapping_id as string, true);

    await admin.query(`INSERT INTO platform.orders
      (id,tenant_id,workspace_id,business_id,order_number,order_date,currency_code,
       operational_status,total_amount,correlation_id,created_by)
      VALUES($1,$2,$3,$4,$5,CURRENT_DATE,'KWD','completed',0,$6,$7)`,
      [order,tenant,workspace,business,`S3-${order}`,randomUUID(),actor]);
    await admin.query(`INSERT INTO business_operations.order_line_items
      (id,tenant_id,workspace_id,business_id,order_id,line_number,item_type,product_id,
       description,quantity,unit_price,line_total)
      VALUES($1,$2,$3,$4,$5,1,'product',NULL,'S3 product',2.5000,0,0)`,
      [line,tenant,workspace,business,order]);
    await admin.query(`INSERT INTO business_operations.order_events
      (id,tenant_id,workspace_id,business_id,order_id,event_type,payload,correlation_id)
      VALUES($1,$2,$3,$4,$5,'note',$6,$7)`,
      [note,tenant,workspace,business,order,
       JSON.stringify({kind:'catalog_line_added',lineItemId:line,catalogProductId:product}),randomUUID()]);
    const completed = (await admin.query(`INSERT INTO business_operations.order_events
      (id,tenant_id,workspace_id,business_id,order_id,event_type,previous_status,new_status,correlation_id)
      VALUES($1,$2,$3,$4,$5,'completed','planned','completed',$6) RETURNING occurred_at::text AS occurred_at`,
      [completion,tenant,workspace,business,order,correlation])).rows[0];
    completedAt = completed.occurred_at as string;
    args = [tenant,workspace,business,order,line,completion,product,mapping,item,warehouse,completedAt,correlation];
  });

  afterAll(async () => { await app?.end(); await admin?.end(); });

  it('has ENABLE + FORCE RLS and refuses all application-role table access', async () => {
    const state = (await admin.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE oid = 'business_operations.pos_inventory_sale_effects'::regclass`)).rows[0];
    expect(state).toMatchObject({relrowsecurity:true,relforcerowsecurity:true});
    const privileges = (await app.query(`SELECT
      has_table_privilege(current_user,'business_operations.pos_inventory_sale_effects','SELECT') AS s,
      has_table_privilege(current_user,'business_operations.pos_inventory_sale_effects','INSERT') AS i,
      has_table_privilege(current_user,'business_operations.pos_inventory_sale_effects','UPDATE') AS u,
      has_table_privilege(current_user,'business_operations.pos_inventory_sale_effects','DELETE') AS d,
      has_table_privilege(current_user,'business_operations.pos_inventory_sale_effects','TRUNCATE') AS t`)).rows[0];
    expect(privileges).toEqual({s:false,i:false,u:false,d:false,t:false});
  });

  it('persists an exact, pending snapshot and changes no stock', async () => {
    const before = (await admin.query(`SELECT count(*)::int AS n FROM business_operations.inventory_movements
      WHERE business_id=$1`, [business])).rows[0].n;
    const saved = (await admin.query(insertEvidence,args)).rows[0].id as string;
    const snap = (await admin.query(`SELECT state,sale_line_quantity::text AS qty,
      effect_quantity::text AS effect,unit_conversion_factor::text AS factor,inventory_item_id,
      warehouse_id,completion_event_id FROM business_operations.pos_inventory_sale_effects
      WHERE id=$1`, [saved])).rows[0];
    expect(snap).toMatchObject({state:'pending',qty:'2.5000',effect:'2.5000',
      factor:'1',inventory_item_id:item,warehouse_id:warehouse,completion_event_id:completion});
    expect((await admin.query(`SELECT count(*)::int AS n FROM business_operations.inventory_movements
      WHERE business_id=$1`, [business])).rows[0].n).toBe(before);
  });

  it('refuses conflicting duplicate evidence even with a different mapping id', async () => {
    await expect(admin.query(insertEvidence,args)).rejects.toMatchObject({code:'23505'});
  });

  it('refuses forged mapping, quantity, product and completion provenance', async () => {
    const altered = (position: number, value: unknown) => args.map((a,i) => i === position ? value : a);
    await expect(admin.query(insertEvidence,altered(6,randomUUID()))).rejects.toBeDefined();
    await expect(admin.query(insertEvidence,altered(7,randomUUID()))).rejects.toBeDefined();
    await expect(admin.query(insertEvidence,altered(5,randomUUID()))).rejects.toBeDefined();
    await expect(admin.query(insertEvidence,altered(9,randomUUID()))).rejects.toBeDefined();
  });

  it('forbids privileged UPDATE and DELETE on immutable evidence', async () => {
    await expect(admin.query(`UPDATE business_operations.pos_inventory_sale_effects
      SET state='pending' WHERE order_line_id=$1`,[line])).rejects.toBeDefined();
    await expect(admin.query(`DELETE FROM business_operations.pos_inventory_sale_effects
      WHERE order_line_id=$1`,[line])).rejects.toBeDefined();
  });

  it('does not expose a route or create movement/balance effects', async () => {
    const n = (await admin.query(`SELECT count(*)::int AS n FROM business_operations.inventory_movements
      WHERE business_id=$1`, [business])).rows[0].n;
    expect(n).toBe(0);
    expect((await admin.query(`SELECT count(*)::int AS n FROM business_operations.inventory_balances
      WHERE business_id=$1`, [business])).rows[0].n).toBe(0);
  });

  it('S5 provenance preflight: the application role can append a catalogue note without authenticating its writer', async () => {
    // Characterization of the existing trust gap, NOT acceptance of forged notes
    // for activation. The transaction rolls back and leaves no attack fixture.
    const forgedId = await scoped(async c => {
      const grants = (await c.query(`SELECT
        has_table_privilege(current_user,'business_operations.order_events','INSERT') AS note_insert,
        has_table_privilege(current_user,'business_operations.pos_inventory_sale_effects','INSERT') AS effect_insert`)).rows[0];
      expect(grants).toEqual({ note_insert: true, effect_insert: false });
      const forgedCatalogId = randomUUID();
      const forged = await c.query<{ id: string; payload: { catalogProductId: string } }>(
        `INSERT INTO business_operations.order_events
          (tenant_id,workspace_id,business_id,order_id,event_type,payload,correlation_id,occurred_at)
         VALUES ($1,$2,$3,$4,'note',$5,$6,
           (SELECT occurred_at - interval '1 second'
              FROM business_operations.order_events WHERE id=$7))
         RETURNING id,payload`,
        [tenant,workspace,business,order,
          JSON.stringify({ kind: 'catalog_line_added', lineItemId: line, catalogProductId: forgedCatalogId }),
          randomUUID(),completion]
      );
      expect(forged.rows).toHaveLength(1);
      expect(forged.rows[0].payload.catalogProductId).toBe(forgedCatalogId);
      // The caller can also backdate occurred_at into the interval that S3
      // treats as evidence preceding completion: time ordering is not attestation.
      const chronology = await c.query<{ backdated: boolean }>(
        `SELECT forged.occurred_at < completed.occurred_at AS backdated
           FROM business_operations.order_events forged
           JOIN business_operations.order_events completed ON completed.id=$2
          WHERE forged.id=$1`,
        [forged.rows[0].id,completion]);
      expect(chronology.rows[0]?.backdated).toBe(true);
      return forged.rows[0].id;
    });
    const surviving = (await admin.query(
      'SELECT count(*)::int AS n FROM business_operations.order_events WHERE id=$1',
      [forgedId])).rows[0].n;
    expect(surviving).toBe(0);
  });

});
