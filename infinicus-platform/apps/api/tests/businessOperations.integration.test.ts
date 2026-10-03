import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { loadConfig } from '@infinicus/configuration';
import { DataAcquisitionService } from '@infinicus/data-acquisition-runtime';
import {
  closePool,
  createPool,
  MembershipRepository,
  RoleRepository,
  UserRepository,
  type TenantContext,
} from '@infinicus/database';
import { buildApp } from '../src/app.js';

const RUN = !!process.env.DATABASE_URL;
const T1 = '87777777-3200-0000-0000-000000000001';
const WS1 = '87777777-3200-0000-0000-000000000002';
const STRONG_PASSWORD = 'Correct-Horse-9!';

let app: FastifyInstance;
let adminPool: Pool;
let ctx: TenantContext;
let token: string;
let businessId: string;
let intakePackageId: string;

function unique(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function headers() {
  return {
    authorization: `Bearer ${token}`,
    'x-tenant-id': T1,
    'x-workspace-id': WS1,
  };
}

describe.runIf(RUN)('BUILD-32 Operations API — live PostgreSQL', () => {
  beforeAll(async () => {
    const appUrl = process.env.DATABASE_URL!;
    const adminUrl = process.env.ADMIN_DATABASE_URL ?? appUrl;
    const config = loadConfig({
      DATABASE_URL: appUrl,
      DB_SSL: process.env.DB_SSL ?? 'false',
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
    });
    createPool({ connectionString: config.databaseUrl, ssl: config.dbSsl });
    adminPool = new Pool({ connectionString: adminUrl });

    await adminPool.query(
      `INSERT INTO tenancy.tenants (id, name, slug, status, plan_code)
       VALUES ($1,'BUILD-32 API Tenant','build32-api-tenant','active','test')
       ON CONFLICT (id) DO NOTHING`,
      [T1]
    );
    await adminPool.query(
      `INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status)
       VALUES ($1,$2,'BUILD-32 API Workspace','build32-api-ws','active')
       ON CONFLICT (id) DO NOTHING`,
      [WS1, T1]
    );

    app = await buildApp(config);
    await app.ready();

    const email = `${unique('build32-api')}@example.test`;
    const register = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email, password: STRONG_PASSWORD },
    });
    expect(register.statusCode).toBe(201);
    const userId = register.json().id as string;
    await new UserRepository().activate(userId);

    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password: STRONG_PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    token = login.json().rawSessionToken as string;

    ctx = { tenantId: T1, workspaceId: WS1, userId };
    const memberships = new MembershipRepository();
    const membership = await memberships.create(ctx, userId);
    await memberships.activate(ctx, membership.id);
    const owner = await new RoleRepository().getByCode(ctx, 'owner');
    await memberships.assignRole(ctx, membership.id, owner.id);

    const biz = await adminPool.query<{ id: string }>(
      `INSERT INTO platform.businesses
         (tenant_id, workspace_id, legal_name, business_code, status)
       VALUES ($1,$2,'BUILD-32 API Business',$3,'active')
       RETURNING id`,
      [T1, WS1, unique('build32-api-biz')]
    );
    businessId = biz.rows[0].id;

    const da = new DataAcquisitionService();
    const source = await da.registerSource(ctx, {
      businessId,
      name: 'BUILD-32 API intake source',
      sourceCode: unique('build32-api-source'),
      sourceType: 'manual',
      sensitivityLevel: 'internal',
      status: 'active',
    });
    const intake = await da.submitManualIntake(ctx, {
      businessId,
      dataSourceId: source.id,
      submissionType: 'operations',
      records: [{
        recordType: 'operational_fact',
        data: {
          eventType: 'expense',
          amount: 42.75,
          category: 'build32-api-intake',
          notes: 'Operations API intake test',
        },
      }],
      sourceReference: 'integration://build32-api',
      submittedBy: ctx.userId,
    });
    const prepared = await da.preparePublicationPackage(
      ctx,
      businessId,
      intake.collectionRunId,
      { targetBlock: 'BO-RUNTIME' }
    );
    const published = await da.publishPackage(ctx, businessId, prepared.id);
    intakePackageId = published.id;

    const supplier = await adminPool.query<{ id: string }>(
      `INSERT INTO platform.suppliers
         (tenant_id, workspace_id, business_id, name, supplier_code, risk_status, status)
       VALUES ($1,$2,$3,'Operations Supplier',$4,'low','active')
       RETURNING id`,
      [T1, WS1, businessId, unique('supplier')]
    );
    await adminPool.query(
      `INSERT INTO business_operations.supplier_performance_scores
         (tenant_id, workspace_id, business_id, supplier_id, period_start, period_end,
          quality_score, delivery_score, price_score, service_score, overall_score)
       VALUES ($1,$2,$3,$4,'2026-09-01','2026-09-30',90,88,82,91,88)`,
      [T1, WS1, businessId, supplier.rows[0].id]
    );

    const warehouse = await adminPool.query<{ id: string }>(
      `INSERT INTO platform.warehouses
         (tenant_id, workspace_id, business_id, warehouse_code, name, status)
       VALUES ($1,$2,$3,$4,'Main Warehouse','active')
       RETURNING id`,
      [T1, WS1, businessId, unique('wh')]
    );
    const item = await adminPool.query<{ id: string }>(
      `INSERT INTO platform.inventory_items
         (tenant_id, workspace_id, business_id, sku, name, status)
       VALUES ($1,$2,$3,$4,'Operations Item','active')
       RETURNING id`,
      [T1, WS1, businessId, unique('sku')]
    );
    await adminPool.query(
      `INSERT INTO business_operations.inventory_balances
         (tenant_id, workspace_id, business_id, inventory_item_id, warehouse_id,
          quantity_on_hand, quantity_reserved, reorder_point, reorder_quantity)
       VALUES ($1,$2,$3,$4,$5,25,5,10,20)`,
      [T1, WS1, businessId, item.rows[0].id, warehouse.rows[0].id]
    );

    await adminPool.query(
      `INSERT INTO business_operations.purchase_orders
         (tenant_id, workspace_id, business_id, supplier_id, po_number, order_date,
          expected_date, currency_code, total_amount, po_status)
       VALUES ($1,$2,$3,$4,$5,'2026-10-01','2026-10-10','USD',500,'submitted')`,
      [T1, WS1, businessId, supplier.rows[0].id, unique('PO')]
    );

    const employee = await adminPool.query<{ id: string }>(
      `INSERT INTO platform.employees
         (tenant_id, workspace_id, business_id, employee_code, display_name, employment_status, status)
       VALUES ($1,$2,$3,$4,'Operations Worker','active','active')
       RETURNING id`,
      [T1, WS1, businessId, unique('EMP')]
    );
    await adminPool.query(
      `INSERT INTO business_operations.employee_assignments
         (tenant_id, workspace_id, business_id, employee_id, assignment_code,
          assignment_type, title, valid_from, allocation_pct, status)
       VALUES ($1,$2,$3,$4,$5,'function','Inventory Control','2026-10-01',100,'active')`,
      [T1, WS1, businessId, employee.rows[0].id, unique('ASSIGN')]
    );

    const asset = await adminPool.query<{ id: string }>(
      `INSERT INTO platform.assets
         (tenant_id, workspace_id, business_id, asset_code, name, asset_type, condition_status, status)
       VALUES ($1,$2,$3,$4,'Cold Room','equipment','good','active')
       RETURNING id`,
      [T1, WS1, businessId, unique('ASSET')]
    );
    await adminPool.query(
      `INSERT INTO business_operations.asset_inspections
         (tenant_id, workspace_id, business_id, asset_id, inspection_type,
          condition_rating, pass_fail, findings)
       VALUES ($1,$2,$3,$4,'routine','good',true,'No material defects')`,
      [T1, WS1, businessId, asset.rows[0].id]
    );

    await adminPool.query(
      `INSERT INTO business_operations.business_events
         (tenant_id, workspace_id, business_id, event_type, amount, quantity, category)
       VALUES ($1,$2,$3,'sale',250,4,'api-fixture')`,
      [T1, WS1, businessId]
    );
  });

  afterAll(async () => {
    await app?.close();
    await adminPool?.end();
    await closePool();
  });

  it('requires authentication for Operations intake', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/businesses/${businessId}/operations/intake/${intakePackageId}`,
      headers: {
        'x-tenant-id': T1,
        'x-workspace-id': WS1,
        'idempotency-key': unique('unauth-intake'),
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it('consumes a canonical published DA package through the Operations API', async () => {
    const first = await app.inject({
      method: 'POST',
      url: `/v1/businesses/${businessId}/operations/intake/${intakePackageId}`,
      headers: {
        ...headers(),
        'idempotency-key': unique('build32-intake'),
      },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().publicationPackageId).toBe(intakePackageId);
    expect(first.json().idempotentReplay).toBe(false);
    expect(first.json().acceptedRecordCount).toBe(1);
    expect(first.json().commandCount).toBe(1);

    const event = await adminPool.query<{ amount: string; category: string }>(
      `SELECT amount, category
       FROM business_operations.business_events
       WHERE tenant_id = $1 AND business_id = $2 AND event_type = 'expense'
         AND category = 'build32-api-intake'
       ORDER BY created_at DESC
       LIMIT 1`,
      [T1, businessId]
    );
    expect(event.rowCount).toBe(1);
    expect(Number(event.rows[0].amount)).toBeCloseTo(42.75, 2);

    const replay = await app.inject({
      method: 'POST',
      url: `/v1/businesses/${businessId}/operations/intake/${intakePackageId}`,
      headers: {
        ...headers(),
        'idempotency-key': unique('build32-intake-replay'),
      },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().idempotentReplay).toBe(true);
    expect(replay.json().commandCount).toBe(0);
  });

  it('rejects unauthenticated Operations reads', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/businesses/${businessId}/operations/inventory`,
      headers: { 'x-tenant-id': T1, 'x-workspace-id': WS1 },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects invalid summary periods through schema validation', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/businesses/${businessId}/operations/summary?from=2026-10-03&to=2026-10-01`,
      headers: headers(),
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns the canonical Operations summary', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/businesses/${businessId}/operations/summary?from=2026-10-01&to=2026-10-04`,
      headers: headers(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().businessId).toBe(businessId);
    expect(res.json().summary.sales.totalRevenue).toBeGreaterThanOrEqual(250);
  });

  it('returns business-scoped inventory balances', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/businesses/${businessId}/operations/inventory`,
      headers: headers(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(1);
    expect(res.json().items[0].quantityOnHand).toBe(25);
    expect(res.json().items[0].quantityAvailable).toBe(20);
  });

  it('returns business-scoped procurement state', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/businesses/${businessId}/operations/procurement?status=submitted`,
      headers: headers(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().purchaseOrders).toHaveLength(1);
    expect(res.json().purchaseOrders[0].poStatus).toBe('submitted');
  });

  it('returns suppliers with latest performance', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/businesses/${businessId}/operations/suppliers`,
      headers: headers(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().suppliers).toHaveLength(1);
    expect(res.json().suppliers[0].latestPerformanceScore).toBe(88);
  });

  it('returns workforce assignments without redefining employee master data', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/businesses/${businessId}/operations/workforce`,
      headers: headers(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().assignments).toHaveLength(1);
    expect(res.json().assignments[0].title).toBe('Inventory Control');
  });

  it('returns assets with latest inspection state', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/businesses/${businessId}/operations/assets`,
      headers: headers(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().assets).toHaveLength(1);
    expect(res.json().assets[0].latestInspectionRating).toBe('good');
    expect(res.json().assets[0].latestInspectionPass).toBe(true);
  });

  it('returns 404 for a business outside the active scope', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/businesses/${crypto.randomUUID()}/operations/inventory`,
      headers: headers(),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe.skipIf(RUN)('BUILD-32 Operations API — skipped without PostgreSQL', () => {
  it('requires DATABASE_URL for live integration', () => {
    expect(RUN).toBe(false);
  });
});
