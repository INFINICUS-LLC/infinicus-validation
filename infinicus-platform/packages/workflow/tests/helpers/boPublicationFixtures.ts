/**
 * Test fixtures for the BI intake tests: what Business Operations writes when it dispatches a publication package (a package row and a 'dispatch'
 * handoff record, see OperationalPublicationService) and the BO -> BI handoff built from them. Used under the admin role only.
 */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { TenantContext } from '@infinicus/database';
import { BO_TO_BI_CONTRACT_VERSION, type BOToBIHandoff } from '@infinicus/handoff-contracts';
import { createWorld, type World } from '../../../database/tests/helpers/financialFixtures.js';

export interface BiWorld extends World { userId: string }
export const biCtx = (w: BiWorld): TenantContext => ({ tenantId: w.tenantId, workspaceId: w.workspaceId, userId: w.userId });

/** A fixture world plus a real user (created_by references identity.users). */
export async function createBiWorld(admin: Pool, label: string): Promise<BiWorld> {
  const w = await createWorld(admin, label); const userId = randomUUID();
  await admin.query(`INSERT INTO identity.users (id, email, status) VALUES ($1,$2,'active')`, [userId, `${userId}@bi.example.test`]);
  return { ...w, userId };
}

export interface PublishOptions {
  targetBlock?: string; periodStart?: string; periodEnd?: string; recordCount?: number;
  payloadReference?: Record<string, string | number | boolean | null>;
}
export interface Published { packageId: string; handoffId: string; correlationId: string; handoff: BOToBIHandoff }

let seq = 0;
export async function publishBoPackage(admin: Pool, w: World, o: PublishOptions = {}): Promise<Published> {
  const packageId = randomUUID(); const handoffId = randomUUID(); const correlationId = randomUUID();
  const targetBlock = o.targetBlock ?? 'BI-16'; const recordCount = o.recordCount ?? 42;
  const periodStart = o.periodStart ?? '2026-10-01T00:00:00.000Z'; const periodEnd = o.periodEnd ?? '2026-11-01T00:00:00.000Z';
  const payloadReference = o.payloadReference ?? { table: 'inventory_movements', rows: 42, complete: true };
  const packageCode = `pkg-${Date.now()}-${++seq}`;
  await admin.query(
    `INSERT INTO business_operations.bo_publication_packages
       (id, tenant_id, workspace_id, business_id, package_code, target_layer, target_block, period_start, period_end, record_count, payload_reference, package_status, correlation_id, version)
     VALUES ($1,$2,$3,$4,$5,'business_intelligence',$6,$7,$8,$9,$10,'dispatched',$11,2)`,
    [packageId, w.tenantId, w.workspaceId, w.businessId, packageCode, targetBlock, periodStart, periodEnd, recordCount, JSON.stringify(payloadReference), correlationId]);
  await admin.query(
    `INSERT INTO business_operations.bo_handoff_records
       (id, tenant_id, workspace_id, business_id, publication_id, handoff_type, source_layer, target_layer, target_block, record_count, payload, occurred_at, correlation_id)
     VALUES ($1,$2,$3,$4,$5,'dispatch','business_operations','business_intelligence',$6,$7,$8,now(),$9)`,
    [handoffId, w.tenantId, w.workspaceId, w.businessId, packageId, targetBlock, recordCount, JSON.stringify({ packageCode, payloadReference, schemaVersion: '1.0' }), correlationId]);
  const handoff: BOToBIHandoff = {
    handoffId, sourceLayer: 'BO', sourceBlock: 'BO-RUNTIME', targetLayer: 'BI', targetBlock, correlationId, lineage: [], status: 'ready', createdAt: new Date().toISOString(),
    payload: {
      contractVersion: BO_TO_BI_CONTRACT_VERSION, tenantId: w.tenantId, workspaceId: w.workspaceId, businessId: w.businessId, boPublicationPackageId: packageId,
      packageStatus: 'dispatched', targetBlock, periodStart, periodEnd, recordCount, source: { packageCode, payloadReference }, schemaVersion: '1.0',
      idempotencyKey: `bo-to-bi:${packageId}:2`,
    },
  };
  return { packageId, handoffId, correlationId, handoff };
}
