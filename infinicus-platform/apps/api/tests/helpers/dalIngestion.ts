/**
 * Test kit (AC-2 Blocks 3-4): a tenant world and the first-action source facts entering Business Operations ONLY through Data Acquisition
 * (manual intake -> validation / provenance -> publication package -> BO intake route). It writes no BO or platform row itself.
 */
import { expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { DataAcquisitionService } from '@infinicus/data-acquisition-runtime';
import { MembershipRepository, RoleRepository, UserRepository, type TenantContext } from '@infinicus/database';

export const STRONG_PASSWORD = 'Correct-Horse-9!';
export const DAY = 86_400_000;
export const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();
export const unique = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

export interface World { ctx: TenantContext; token: string; businessId: string; dataSourceId: string }

/** The first-action source facts exactly as a data source would state them: natural keys only, explicit cost currency, business instants. */
export function firstActionRecords(sku: string, warehouseCode: string): Record<string, unknown>[] {
  return [
    { recordType: 'warehouse', data: { warehouseCode, name: 'Main warehouse' } },
    { recordType: 'inventory_item', data: { sku, name: 'Widget', unitOfMeasure: 'unit' } },
    { recordType: 'inventory_movement', data: { sku, warehouseCode, movementType: 'receipt', quantity: 1000, unitCost: 10, unitCostCurrency: 'USD', occurredAt: daysAgo(5), referenceType: 'manual' } },
    ...Array.from({ length: 12 }, (_, i) => ({ recordType: 'inventory_movement', data: { sku, warehouseCode, movementType: 'issue', quantity: 75, occurredAt: daysAgo(i + 1), referenceType: 'manual' } })),
  ];
}

export function dalKit(env: { app: FastifyInstance; admin: Pool; tenantIds: string[] }) {
  const { app, admin, tenantIds } = env;
  const da = new DataAcquisitionService();

  async function world(): Promise<World> {
    const email = `${unique('ac2')}@ac2.example`;
    const reg = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, password: STRONG_PASSWORD } });
    expect(reg.statusCode).toBe(201);
    const userId = reg.json().id as string;
    await new UserRepository().activate(userId);
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: STRONG_PASSWORD } });
    const token = login.json().rawSessionToken as string;
    const tenantId = randomUUID(); const workspaceId = randomUUID(); const sfx = unique('s');
    tenantIds.push(tenantId);
    await admin.query(`INSERT INTO tenancy.tenants (id, name, slug, status, plan_code) VALUES ($1,'AC2 Tenant',$2,'active','test')`, [tenantId, `ac2-${sfx}`]);
    await admin.query(`INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,'AC2 WS',$3,'active')`, [workspaceId, tenantId, `ac2-ws-${sfx}`]);
    const ctx: TenantContext = { tenantId, workspaceId, userId };
    const memberships = new MembershipRepository();
    const m = await memberships.create(ctx, userId);
    await memberships.activate(ctx, m.id);
    await memberships.assignRole(ctx, m.id, (await new RoleRepository().getByCode(ctx, 'owner')).id);
    const businessId = (await admin.query(`INSERT INTO platform.businesses (tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,'AC2 Biz',$3,'active') RETURNING id`, [tenantId, workspaceId, unique('ac2-biz')])).rows[0].id as string;
    const source = await da.registerSource(ctx, { businessId, name: 'AC2 inventory feed', sourceCode: unique('ac2-src'), sourceType: 'manual', sensitivityLevel: 'internal', status: 'active' });
    return { ctx, token, businessId, dataSourceId: source.id };
  }

  const headers = (w: { ctx: TenantContext; token: string }, extra: Record<string, string> = {}) => ({
    authorization: `Bearer ${w.token}`, 'x-tenant-id': w.ctx.tenantId, 'x-workspace-id': w.ctx.workspaceId, ...extra,
  });

  /** DAL: manual intake -> publication package -> published. Returns the package id and the DAL run summary. */
  async function publishThroughDal(w: World, records: unknown[]) {
    const intake = await da.submitManualIntake(w.ctx, { businessId: w.businessId, dataSourceId: w.dataSourceId, submissionType: 'operations', records, sourceReference: 'integration://ac2-first-action', submittedBy: w.ctx.userId });
    const prepared = await da.preparePublicationPackage(w.ctx, w.businessId, intake.collectionRunId, { targetBlock: 'BO-RUNTIME' });
    const published = await da.publishPackage(w.ctx, w.businessId, prepared.id);
    return { intake, packageId: published.id };
  }
  const boIntake = (w: World, packageId: string) => app.inject({ method: 'POST', url: `/v1/businesses/${w.businessId}/operations/intake/${packageId}`, headers: headers(w, { 'idempotency-key': unique('ac2-intake') }) });
  const count = async (sql: string, params: unknown[]) => Number((await admin.query(sql, params)).rows[0].n);
  const boRows = (w: World) => ({
    items: () => count(`SELECT count(*) n FROM platform.inventory_items WHERE business_id=$1`, [w.businessId]),
    warehouses: () => count(`SELECT count(*) n FROM platform.warehouses WHERE business_id=$1`, [w.businessId]),
    movements: () => count(`SELECT count(*) n FROM business_operations.inventory_movements WHERE business_id=$1`, [w.businessId]),
    balances: () => count(`SELECT count(*) n FROM business_operations.inventory_balances WHERE business_id=$1`, [w.businessId]),
  });
  return { da, world, headers, publishThroughDal, boIntake, count, boRows };
}
