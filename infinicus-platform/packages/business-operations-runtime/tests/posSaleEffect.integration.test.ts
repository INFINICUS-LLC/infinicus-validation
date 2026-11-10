import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { OperationalCommandExecutor } from '../src/OperationalCommandExecutor.js';

const run = !!process.env.DATABASE_URL && !!process.env.ADMIN_DATABASE_URL;
describe.runIf(run)('POS2-04-S4 unwired canonical BO sale-effect command (disposable PG16)', () => {
  let admin: Pool; let app: Pool;
  const ctx = {tenantId: randomUUID(), workspaceId: randomUUID(), userId: randomUUID()};
  const business = randomUUID(), product = randomUUID(), item = randomUUID(), warehouse = randomUUID();
  const order = randomUUID(), completion = randomUUID(), correlation = randomUUID();
  const lines = [randomUUID(), randomUUID()];
  const effects: string[] = [];
  let mapping = '';
  const executor = new OperationalCommandExecutor();

  async function transaction<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.tenant_id',$1,true),
        set_config('app.workspace_id',$2,true),set_config('app.user_id',$3,true)`,
      [ctx.tenantId,ctx.workspaceId,ctx.userId]);
      const result = await fn(c);
      await c.query('COMMIT');
      return result;
    } catch(e) {await c.query('ROLLBACK').catch(() => undefined);throw e;}
    finally {c.release();}
  }

  beforeAll(async () => {
    admin = new Pool({connectionString:process.env.ADMIN_DATABASE_URL});
    app = new Pool({connectionString:process.env.DATABASE_URL});
    await admin.query(`INSERT INTO tenancy.tenants(id,name,slug,status,plan_code)
      VALUES($1,'S4',$2,'active','test')`,[ctx.tenantId,`s4-${ctx.tenantId}`]);
    await admin.query(`INSERT INTO tenancy.workspaces(id,tenant_id,name,slug,status)
      VALUES($1,$2,'S4',$3,'active')`,[ctx.workspaceId,ctx.tenantId,`s4-${ctx.workspaceId}`]);
    await admin.query(`INSERT INTO platform.businesses(id,tenant_id,workspace_id,legal_name,business_code,status)
      VALUES($1,$2,$3,'S4',$4,'active')`,[business,ctx.tenantId,ctx.workspaceId,`s4-${business}`]);
    await admin.query(`INSERT INTO identity.users(id,email,status)
      VALUES($1,$2,'active')`,[ctx.userId,`s4-${ctx.userId}@example.invalid`]);
    const role = (await admin.query(`INSERT INTO tenancy.roles(tenant_id,code,name,scope)
      VALUES($1,$2,'S4','business') RETURNING id`,[ctx.tenantId,`s4-${ctx.tenantId}`])).rows[0].id;
    await admin.query(`INSERT INTO tenancy.role_permissions(role_id,permission_id)
      SELECT $1,id FROM tenancy.permissions WHERE code='bo:admin'`,[role]);
    const member=(await admin.query(`INSERT INTO tenancy.memberships(tenant_id,workspace_id,user_id,status)
      VALUES($1,$2,$3,'active') RETURNING id`,[ctx.tenantId,ctx.workspaceId,ctx.userId])).rows[0].id;
    await admin.query(`INSERT INTO tenancy.membership_roles(membership_id,role_id,business_id)
      VALUES($1,$2,$3)`,[member,role,business]);
    await admin.query(`INSERT INTO business_operations.products
      (id,tenant_id,workspace_id,business_id,name,price)
      VALUES($1,$2,$3,$4,'S4 product',1)`,[product,ctx.tenantId,ctx.workspaceId,business]);
    await admin.query(`INSERT INTO platform.inventory_items
      (id,tenant_id,workspace_id,business_id,sku,name)
      VALUES($1,$2,$3,$4,$5,'S4 item')`,[item,ctx.tenantId,ctx.workspaceId,business,`s4-${item}`]);
    await admin.query(`INSERT INTO platform.warehouses
      (id,tenant_id,workspace_id,business_id,warehouse_code,name)
      VALUES($1,$2,$3,$4,$5,'S4 warehouse')`,[warehouse,ctx.tenantId,ctx.workspaceId,business,`s4-${warehouse}`]);
    mapping=await transaction(app,async c=>(await c.query(
      'SELECT * FROM business_operations.configure_pos_inventory_mapping($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [ctx.tenantId,ctx.workspaceId,business,product,item,warehouse,ctx.userId,randomUUID(),null])).rows[0].mapping_id);
    await admin.query(`INSERT INTO platform.orders
      (id,tenant_id,workspace_id,business_id,order_number,order_date,currency_code,
       operational_status,total_amount,correlation_id,created_by)
      VALUES($1,$2,$3,$4,$5,CURRENT_DATE,'KWD','completed',0,$6,$7)`,
      [order,ctx.tenantId,ctx.workspaceId,business,`S4-${order}`,randomUUID(),ctx.userId]);
    for(let n=0;n<lines.length;n++){
      await admin.query(`INSERT INTO business_operations.order_line_items
        (id,tenant_id,workspace_id,business_id,order_id,line_number,item_type,description,quantity,unit_price,line_total)
        VALUES($1,$2,$3,$4,$5,$6,'product','S4 product',2.5000,0,0)`,
        [lines[n],ctx.tenantId,ctx.workspaceId,business,order,n+1]);
      await admin.query(`INSERT INTO business_operations.order_events
        (tenant_id,workspace_id,business_id,order_id,event_type,payload,correlation_id)
        VALUES($1,$2,$3,$4,'note',$5,$6)`,
        [ctx.tenantId,ctx.workspaceId,business,order,
          JSON.stringify({kind:'catalog_line_added',lineItemId:lines[n],catalogProductId:product}),randomUUID()]);
    }
    const time=(await admin.query(`INSERT INTO business_operations.order_events
      (id,tenant_id,workspace_id,business_id,order_id,event_type,previous_status,new_status,correlation_id)
      VALUES($1,$2,$3,$4,$5,'completed','planned','completed',$6)
      RETURNING occurred_at::text AS occurred_at`,
      [completion,ctx.tenantId,ctx.workspaceId,business,order,correlation])).rows[0].occurred_at;
    for(const line of lines){
      const e=(await admin.query(`INSERT INTO business_operations.pos_inventory_sale_effects
        (tenant_id,workspace_id,business_id,order_id,order_line_id,completion_event_id,
         catalog_product_id,mapping_id,inventory_item_id,warehouse_id,inventory_unit_of_measure,
         sale_line_quantity,unit_conversion_factor,effect_quantity,completed_at,correlation_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'unit',2.5000,1,2.5000,$11,$12) RETURNING id`,
        [ctx.tenantId,ctx.workspaceId,business,order,line,completion,product,mapping,item,warehouse,time,correlation])).rows[0].id;
      effects.push(e);
    }
    await admin.query(`INSERT INTO business_operations.inventory_balances
       (tenant_id,workspace_id,business_id,inventory_item_id,warehouse_id,quantity_on_hand,quantity_reserved)
       VALUES($1,$2,$3,$4,$5,4,0)`,[ctx.tenantId,ctx.workspaceId,business,item,warehouse]);
  });
  afterAll(async()=>{await app?.end();await admin?.end();});
  it('forces RLS and withholds application-role access to terminal outcomes',async()=>{
    const a=(await admin.query(`SELECT relrowsecurity,relforcerowsecurity FROM pg_class
       WHERE oid='business_operations.pos_inventory_sale_effect_outcomes'::regclass`)).rows[0];
    expect(a).toEqual({relrowsecurity:true,relforcerowsecurity:true});
    const x=(await app.query(`SELECT
      has_table_privilege(current_user,'business_operations.pos_inventory_sale_effect_outcomes','SELECT') s,
      has_table_privilege(current_user,'business_operations.pos_inventory_sale_effect_outcomes','INSERT') i,
      has_table_privilege(current_user,'business_operations.pos_inventory_sale_effect_outcomes','UPDATE') u`)).rows[0];
    expect(x).toEqual({s:false,i:false,u:false});
  });
  it('executes exactly once through the canonical movement writer and replays without another movement',async()=>{
    const first=await transaction(admin,c=>executor.applyPosSaleEffectOn(c,ctx,business,effects[0]));
    expect(first.outcome).toBe('applied'); expect(first.replayed).toBe(false);expect(first.movementId).toBeTruthy();
    const again=await transaction(admin,c=>executor.applyPosSaleEffectOn(c,ctx,business,effects[0]));
    expect(again).toMatchObject({outcome:'applied',outcomeId:first.outcomeId,movementId:first.movementId,replayed:true});
    const m=(await admin.query(`SELECT count(*)::int n FROM business_operations.inventory_movements
      WHERE reference_type='order_line' AND reference_id=$1`,[lines[0]])).rows[0].n;
    expect(m).toBe(1);
    const b=(await admin.query(`SELECT quantity_on_hand::text qty FROM business_operations.inventory_balances
      WHERE inventory_item_id=$1 AND warehouse_id=$2`,[item,warehouse])).rows[0].qty;
    expect(b).toBe('1.5000');
  });
  it('persists one shortage exception without movement and never changes completed sale',async()=>{
    const shortage=await transaction(admin,c=>executor.applyPosSaleEffectOn(c,ctx,business,effects[1]));
    expect(shortage).toMatchObject({outcome:'exception',movementId:null,replayed:false});
    const replay=await transaction(admin,c=>executor.applyPosSaleEffectOn(c,ctx,business,effects[1]));
    expect(replay).toMatchObject({outcome:'exception',outcomeId:shortage.outcomeId,movementId:null,replayed:true});
    const rec=(await admin.query(`SELECT reason, available_quantity::text AS available FROM
      business_operations.pos_inventory_sale_effect_outcomes WHERE id=$1`,[shortage.outcomeId])).rows[0];
    expect(rec).toEqual({reason:'INSUFFICIENT_STOCK',available:'1.5000'});
    expect((await admin.query(`SELECT operational_status FROM platform.orders WHERE id=$1`,[order])).rows[0].operational_status).toBe('completed');
    expect((await admin.query(`SELECT count(*)::int n FROM business_operations.inventory_movements
      WHERE business_id=$1`,[business])).rows[0].n).toBe(1);
  });
  it('rejects foreign business and does not expose outcome mutations',async()=>{
    await expect(transaction(admin,c=>executor.applyPosSaleEffectOn(c,ctx,randomUUID(),effects[0]))).rejects.toThrow();
    await expect(admin.query(`UPDATE business_operations.pos_inventory_sale_effect_outcomes
      SET reason=reason WHERE effect_id=$1`,[effects[0]])).rejects.toThrow(/append-only/i);
  });
});
