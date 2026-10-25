import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { truncateRefusal } from './helpers/truncateRefusal.js';

const run = !!process.env.DATABASE_URL && !!process.env.ADMIN_DATABASE_URL;
const tenant = randomUUID();
const workspace = randomUUID();
const business = randomUUID();
let admin: Pool;
let app: Pool;

describe.runIf(run)('BO order event database integrity on disposable PostgreSQL', () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL! });
    app = new Pool({ connectionString: process.env.DATABASE_URL! });
    await admin.query(`INSERT INTO tenancy.tenants (id,name,slug,status,plan_code) VALUES ($1,'event integrity',$2,'active','test')`, [tenant, `ev-${tenant}`]);
    await admin.query(`INSERT INTO tenancy.workspaces (id,tenant_id,name,slug,status) VALUES ($1,$2,'event integrity',$3,'active')`, [workspace, tenant, `ev-${workspace}`]);
    await admin.query(`INSERT INTO platform.businesses (id,tenant_id,workspace_id,legal_name,business_code,status) VALUES ($1,$2,$3,'event integrity',$4,'active')`, [business, tenant, workspace, `ev-${business}`]);
  });
  afterAll(async () => { await app?.end(); await admin?.end(); });

  const order = async () => {
    const id = randomUUID();
    await admin.query(`INSERT INTO platform.orders (id,tenant_id,workspace_id,business_id,order_number,order_date,operational_status)
      VALUES ($1,$2,$3,$4,$5,CURRENT_DATE,'completed')`, [id, tenant, workspace, business, `ev-${id}`]);
    return id;
  };
  const complete = (orderId: string, eventTenant = tenant, eventWorkspace = workspace, eventBusiness = business) =>
    admin.query(`INSERT INTO business_operations.order_events
      (tenant_id,workspace_id,business_id,order_id,event_type,previous_status,new_status)
      VALUES ($1,$2,$3,$4,'completed','planned','completed') RETURNING id`,
    [eventTenant, eventWorkspace, eventBusiness, orderId]);

  it('allows distinct completions and refuses mutation, truncation and duplicates', async () => {
    const firstOrder = await order();
    const secondOrder = await order();
    const first = (await complete(firstOrder)).rows[0].id as string;
    await complete(secondOrder);
    await expect(complete(firstOrder)).rejects.toThrow();
    await expect(admin.query(`UPDATE business_operations.order_events SET occurred_at=now() WHERE id=$1`, [first])).rejects.toThrow();
    await expect(admin.query(`DELETE FROM business_operations.order_events WHERE id=$1`, [first])).rejects.toThrow();
    await expect(truncateRefusal(admin, `TRUNCATE business_operations.order_events`)).rejects.toThrow();
  });

  it('serializes concurrent duplicate completions through the partial unique index', async () => {
    const id = await order();
    const results = await Promise.allSettled([complete(id), complete(id)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });

  it('refuses cross-tenant, workspace and business order links', async () => {
    const id = await order();
    for (const scope of [[randomUUID(), workspace, business], [tenant, randomUUID(), business], [tenant, workspace, randomUUID()]]) {
      await expect(complete(id, scope[0], scope[1], scope[2])).rejects.toThrow();
    }
    await complete(id);
  });

  it('keeps application INSERT and scoped SELECT while denying mutation and foreign-scope reads', async () => {
    const id = await order();
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL app.tenant_id = '${tenant}'`);
      await client.query(`SET LOCAL app.workspace_id = '${workspace}'`);
      const event = await client.query<{ id: string }>(`INSERT INTO business_operations.order_events
        (tenant_id,workspace_id,business_id,order_id,event_type) VALUES ($1,$2,$3,$4,'note') RETURNING id`,
      [tenant, workspace, business, id]);
      await client.query('COMMIT');
      await expect(client.query(`UPDATE business_operations.order_events SET notes='changed' WHERE id=$1`, [event.rows[0].id])).rejects.toThrow();
      await expect(client.query(`DELETE FROM business_operations.order_events WHERE id=$1`, [event.rows[0].id])).rejects.toThrow();
      await expect(truncateRefusal(app, `TRUNCATE business_operations.order_events`)).rejects.toThrow();
      await client.query('BEGIN');
      await client.query(`SET LOCAL app.tenant_id = '${tenant}'`);
      await client.query(`SET LOCAL app.workspace_id = '${workspace}'`);
      expect((await client.query(`SELECT id FROM business_operations.order_events WHERE id=$1`, [event.rows[0].id])).rowCount).toBe(1);
      await client.query('COMMIT');
      await client.query('BEGIN');
      await client.query(`SET LOCAL app.tenant_id = '${randomUUID()}'`);
      await client.query(`SET LOCAL app.workspace_id = '${randomUUID()}'`);
      expect((await client.query(`SELECT id FROM business_operations.order_events WHERE id=$1`, [event.rows[0].id])).rowCount).toBe(0);
      await client.query('COMMIT');
    } finally { client.release(); }
  });

  it('rolls back a completion insert with its enclosing transaction', async () => {
    const id = await order();
    const client = await admin.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO business_operations.order_events
        (tenant_id,workspace_id,business_id,order_id,event_type) VALUES ($1,$2,$3,$4,'completed')`,
      [tenant, workspace, business, id]);
      await client.query('ROLLBACK');
    } finally { client.release(); }
    expect((await admin.query(`SELECT id FROM business_operations.order_events WHERE order_id=$1`, [id])).rowCount).toBe(0);
  });
});
