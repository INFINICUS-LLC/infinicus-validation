/**
 * Test helper for the BI read API: what Business Operations writes when it dispatches a publication package (a package row and a 'dispatch' handoff record,
 * see OperationalPublicationService), the BO -> BI handoff built from them, and the REAL BI services run on top (intake, then dataset materialization).
 */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { TenantContext } from '@infinicus/database';
import { BO_TO_BI_CONTRACT_VERSION, type BOToBIHandoff } from '@infinicus/handoff-contracts';
import { BusinessIntelligenceDatasetService, BusinessIntelligenceIntakeService } from '@infinicus/workflow';

export interface PublishOptions { targetBlock?: string; periodStart?: string; periodEnd?: string; recordCount?: number; payloadReference?: Record<string, string | number | boolean | null> }
let seq = 0;

export async function publishBoPackage(admin: Pool, w: { ctx: TenantContext; businessId: string }, o: PublishOptions = {}): Promise<{ packageId: string; handoffId: string; correlationId: string; handoff: BOToBIHandoff }> {
  const packageId = randomUUID(); const handoffId = randomUUID(); const correlationId = randomUUID();
  const targetBlock = o.targetBlock ?? 'BI-16'; const recordCount = o.recordCount ?? 42;
  const periodStart = o.periodStart ?? '2026-10-01T00:00:00.000Z'; const periodEnd = o.periodEnd ?? '2026-11-01T00:00:00.000Z';
  const payloadReference = o.payloadReference ?? { table: 'inventory_movements', rows: 42, complete: true };
  const packageCode = `pkg-${Date.now()}-${++seq}`;
  const { tenantId, workspaceId } = w.ctx;
  await admin.query(
    `INSERT INTO business_operations.bo_publication_packages
       (id, tenant_id, workspace_id, business_id, package_code, target_layer, target_block, period_start, period_end, record_count, payload_reference, package_status, correlation_id, version)
     VALUES ($1,$2,$3,$4,$5,'business_intelligence',$6,$7,$8,$9,$10,'dispatched',$11,2)`,
    [packageId, tenantId, workspaceId, w.businessId, packageCode, targetBlock, periodStart, periodEnd, recordCount, JSON.stringify(payloadReference), correlationId]);
  await admin.query(
    `INSERT INTO business_operations.bo_handoff_records
       (id, tenant_id, workspace_id, business_id, publication_id, handoff_type, source_layer, target_layer, target_block, record_count, payload, occurred_at, correlation_id)
     VALUES ($1,$2,$3,$4,$5,'dispatch','business_operations','business_intelligence',$6,$7,$8,now(),$9)`,
    [handoffId, tenantId, workspaceId, w.businessId, packageId, targetBlock, recordCount, JSON.stringify({ packageCode, payloadReference, schemaVersion: '1.0' }), correlationId]);
  const handoff: BOToBIHandoff = {
    handoffId, sourceLayer: 'BO', sourceBlock: 'BO-RUNTIME', targetLayer: 'BI', targetBlock, correlationId, lineage: [], status: 'ready', createdAt: new Date().toISOString(),
    payload: {
      contractVersion: BO_TO_BI_CONTRACT_VERSION, tenantId, workspaceId, businessId: w.businessId, boPublicationPackageId: packageId, packageStatus: 'dispatched', targetBlock,
      periodStart, periodEnd, recordCount, source: { packageCode, payloadReference }, schemaVersion: '1.0', idempotencyKey: `bo-to-bi:${packageId}:2`,
    },
  };
  return { packageId, handoffId, correlationId, handoff };
}

const intakeService = new BusinessIntelligenceIntakeService();
const datasetService = new BusinessIntelligenceDatasetService();

/** A BO package taken in by BI and, when `materialize`, turned into a dataset version - through the real services. */
export async function ingestAndMaterialize(admin: Pool, w: { ctx: TenantContext; businessId: string }, o: PublishOptions & { materialize?: boolean } = {}) {
  const p = await publishBoPackage(admin, w, o);
  const out = await intakeService.ingest(w.ctx, p.handoff);
  if (out.outcome !== 'VALIDATED') throw new Error(`intake did not validate: ${JSON.stringify(out)}`);
  const dataset = o.materialize === false ? null : await datasetService.materialize(w.ctx, out.intakePackageId);
  return { ...p, intakeId: out.intakePackageId, dataset };
}
/** A BO package whose claims disagree with BO's record: BI records a REJECTED intake. */
export async function ingestRejected(admin: Pool, w: { ctx: TenantContext; businessId: string }) {
  const p = await publishBoPackage(admin, w);
  const out = await intakeService.ingest(w.ctx, { ...p.handoff, payload: { ...p.handoff.payload, recordCount: p.handoff.payload.recordCount + 1 } });
  if (out.outcome !== 'REJECTED') throw new Error('expected a rejected intake');
  return { ...p, intakeId: out.intakePackageId, reasons: out.reasons };
}
