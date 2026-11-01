/**
 * BO-PUB-DEV-01: extracts the inventory movement ledger of one business and one period as deterministic, verified publication EVIDENCE (a PROPOSED contract, see
 * inventoryMovementEvidence.ts). Business Operations owns the ledger, so this is a BO component reading BO's own table; Business Intelligence never does.
 *
 * Read-only: every statement is a SELECT. It writes no evidence (no table exists for it; durable persistence needs an owner-approved migration), publishes nothing,
 * activates nothing and touches no other layer. The only other BO table it reads is the publication package HEADER, and only when the caller names one, to check the
 * header agrees with what the ledger holds (period, target, state, declared record count). Scope comes from the authenticated context; a business outside it is
 * indistinguishable from one that does not exist. A fixed column list is selected: `notes`, `performed_by` and `created_at` are never read.
 */
import { withTenantTransaction, type TenantContext } from '@infinicus/database';
import {
  buildInventoryMovementEvidence, INVENTORY_MOVEMENT_EVIDENCE, validPeriodInstant,
  type EvidenceIssue, type InventoryMovementEvidence, type RawInventoryMovementRow,
} from './inventoryMovementEvidence.js';

export type ExtractionFailureCode =
  | 'REQUEST_INVALID' | 'BUSINESS_NOT_FOUND' | 'TOO_MANY_RECORDS'
  | 'HEADER_NOT_FOUND' | 'HEADER_NOT_FOR_BI' | 'HEADER_NOT_PUBLISHED' | 'HEADER_PERIOD_MISMATCH' | 'HEADER_COUNT_MISMATCH'
  | 'EVIDENCE_REJECTED';
export type ExtractionResult =
  | { ok: true; evidence: InventoryMovementEvidence }
  | { ok: false; code: ExtractionFailureCode; issueCount: number; issues: EvidenceIssue[] };

export interface ExtractInventoryMovementEvidenceRequest {
  businessId: string;
  /** Half-open period [periodStart, periodEnd) as UTC instants `YYYY-MM-DDTHH:MM:SS.sssZ`. */
  periodStart: string;
  periodEnd: string;
  /** An existing BO publication package header (bo_publication_packages) the evidence is for; when given, the header must agree with the ledger. */
  boPublicationPackageId?: string;
  correlationId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PUBLISHED_STATES = ['ready', 'dispatched', 'received'];

/** The fixed column list: nothing outside the proposed record schema is ever read. */
const LEDGER = `
SELECT m.id, m.tenant_id, m.workspace_id, m.business_id, m.inventory_item_id, m.warehouse_id, m.movement_type, m.quantity::text AS quantity,
       m.reference_type, m.reference_id, m.unit_cost::text AS unit_cost, m.unit_cost_currency,
       to_char(m.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at, m.correlation_id
  FROM business_operations.inventory_movements m
 WHERE m.tenant_id = $1 AND m.workspace_id = $2 AND m.business_id = $3 AND m.occurred_at >= $4::timestamptz AND m.occurred_at < $5::timestamptz
 ORDER BY m.occurred_at ASC, m.id ASC
 LIMIT $6`;
const HEADER = `
SELECT target_layer, package_status, record_count, (period_start = $5::timestamptz AND period_end = $6::timestamptz) AS period_matches
  FROM business_operations.bo_publication_packages
 WHERE id = $1 AND tenant_id = $2 AND workspace_id = $3 AND business_id = $4`;

const refuse = (code: ExtractionFailureCode, issues: EvidenceIssue[] = [], issueCount = issues.length): ExtractionResult => ({ ok: false, code, issueCount, issues });

export class InventoryMovementEvidenceExtractor {
  async extract(ctx: TenantContext, request: ExtractInventoryMovementEvidenceRequest): Promise<ExtractionResult> {
    const businessId = typeof request?.businessId === 'string' ? request.businessId.toLowerCase() : '';
    const packageId = request?.boPublicationPackageId === undefined ? null : typeof request.boPublicationPackageId === 'string' ? request.boPublicationPackageId.toLowerCase() : '';
    if (!UUID.test(businessId) || (packageId !== null && !UUID.test(packageId)) || typeof request.correlationId !== 'string' || !UUID.test(request.correlationId)
      || !validPeriodInstant(request.periodStart) || !validPeriodInstant(request.periodEnd) || request.periodStart >= request.periodEnd) return refuse('REQUEST_INVALID');

    return withTenantTransaction(ctx, async (client): Promise<ExtractionResult> => {
      const business = await client.query('SELECT 1 FROM platform.businesses WHERE id = $1 AND tenant_id = $2 AND workspace_id = $3 AND deleted_at IS NULL', [businessId, ctx.tenantId, ctx.workspaceId]);
      if (business.rowCount !== 1) return refuse('BUSINESS_NOT_FOUND');
      // One more than the bound, so an oversize period is detected and refused whole instead of being truncated.
      const ledger = await client.query<RawInventoryMovementRow>(LEDGER, [ctx.tenantId, ctx.workspaceId, businessId, request.periodStart, request.periodEnd, INVENTORY_MOVEMENT_EVIDENCE.maxRecords + 1]);
      if (ledger.rows.length > INVENTORY_MOVEMENT_EVIDENCE.maxRecords) return refuse('TOO_MANY_RECORDS');

      if (packageId !== null) {
        const header = await client.query<{ target_layer: string; package_status: string; record_count: number; period_matches: boolean }>(HEADER, [packageId, ctx.tenantId, ctx.workspaceId, businessId, request.periodStart, request.periodEnd]);
        if (header.rowCount !== 1) return refuse('HEADER_NOT_FOUND');
        const h = header.rows[0]!;
        if (h.target_layer !== 'business_intelligence') return refuse('HEADER_NOT_FOR_BI');
        if (!PUBLISHED_STATES.includes(h.package_status)) return refuse('HEADER_NOT_PUBLISHED');
        if (!h.period_matches) return refuse('HEADER_PERIOD_MISMATCH');
        if (Number(h.record_count) !== ledger.rows.length) return refuse('HEADER_COUNT_MISMATCH');
      }

      const built = buildInventoryMovementEvidence({
        scope: { tenantId: ctx.tenantId, workspaceId: ctx.workspaceId, businessId }, period: { periodStart: request.periodStart, periodEnd: request.periodEnd },
        boPublicationPackageId: packageId, correlationId: request.correlationId, rows: ledger.rows,
      });
      if (!built.ok) return refuse(built.code === 'TOO_MANY_RECORDS' ? 'TOO_MANY_RECORDS' : 'EVIDENCE_REJECTED', built.issues, built.issueCount);
      return { ok: true, evidence: built.value };
    });
  }
}
