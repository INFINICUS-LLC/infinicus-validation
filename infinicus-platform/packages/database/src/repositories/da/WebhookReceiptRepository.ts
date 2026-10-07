/**
 * Persistence for data_acquisition.webhook_receipts (created alongside
 * collection_runs in 0014_create_da_collection_runs.sql, unused until this
 * BUILD-31 follow-up).
 *
 * A receipt is written once, after a webhook delivery has been fully
 * processed into a collection run — this table is the idempotency ledger
 * webhook delivery retries are checked against
 * (webhook_receipts_idempotency: UNIQUE (data_source_id, idempotency_key)),
 * not a durable "received but not yet processed" queue. A delivery that
 * fails during processing leaves no receipt row, so a retry after a
 * failure legitimately reprocesses — only a delivery that already
 * succeeded is deduplicated.
 */

import { randomUUID } from 'crypto';
import type { PoolClient, QueryResult } from 'pg';
import type { TenantContext } from '../../client.js';
import { withTenantTransaction } from '../../client.js';

export interface WebhookReceipt {
  id: string;
  tenantId: string;
  workspaceId: string;
  businessId: string | null;
  dataSourceId: string;
  connectorId: string | null;
  collectionRunId: string;
  externalEventId: string | null;
  requestId: string | null;
  signatureStatus: string;
  idempotencyKey: string;
  headers: Record<string, unknown>;
  payload: unknown;
  payloadHash: string;
  receivedAt: Date;
  processedAt: Date | null;
  status: string;
  correlationId: string;
  createdAt: Date;
}

export interface CreateWebhookReceiptInput {
  businessId?: string;
  dataSourceId: string;
  connectorId?: string;
  collectionRunId: string;
  externalEventId?: string;
  requestId?: string;
  idempotencyKey: string;
  headers?: Record<string, unknown>;
  payload: unknown;
  payloadHash: string;
  correlationId?: string;
}

function rowToWebhookReceipt(row: Record<string, unknown>): WebhookReceipt {
  return {
    id:              row.id                as string,
    tenantId:        row.tenant_id         as string,
    workspaceId:     row.workspace_id      as string,
    businessId:      row.business_id       as string | null,
    dataSourceId:    row.data_source_id    as string,
    connectorId:     row.connector_id      as string | null,
    collectionRunId: row.collection_run_id as string,
    externalEventId: row.external_event_id as string | null,
    requestId:       row.request_id        as string | null,
    signatureStatus: row.signature_status  as string,
    idempotencyKey:  row.idempotency_key   as string,
    headers:         row.headers           as Record<string, unknown>,
    payload:         row.payload,
    payloadHash:     row.payload_hash      as string,
    receivedAt:      row.received_at       as Date,
    processedAt:     row.processed_at      as Date | null,
    status:          row.status            as string,
    correlationId:   row.correlation_id    as string,
    createdAt:       row.created_at        as Date,
  };
}

export class WebhookReceiptRepository {
  /**
   * Records a successfully processed webhook delivery. Always written with
   * signature_status='valid' and status='processed' — a delivery is only
   * ever persisted here after passing token verification and completing
   * the same validate/score/provenance pipeline manual intake uses (see
   * DataAcquisitionService.receiveWebhook), so there is no partially-valid
   * or still-pending state to represent.
   */
  async createOn(
    client: PoolClient,
    ctx: TenantContext,
    input: CreateWebhookReceiptInput
  ): Promise<WebhookReceipt> {
    const result: QueryResult<Record<string, unknown>> = await client.query(
      `INSERT INTO data_acquisition.webhook_receipts
         (tenant_id, workspace_id, business_id, data_source_id, connector_id,
          collection_run_id, external_event_id, request_id, signature_status,
          idempotency_key, headers, payload, payload_hash, processed_at,
          status, correlation_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'valid',$9,$10,$11,$12,now(),'processed',$13)
       RETURNING *`,
      [
        ctx.tenantId,
        ctx.workspaceId,
        input.businessId      ?? null,
        input.dataSourceId,
        input.connectorId     ?? null,
        input.collectionRunId,
        input.externalEventId ?? null,
        input.requestId       ?? null,
        input.idempotencyKey,
        JSON.stringify(input.headers ?? {}),
        JSON.stringify(input.payload),
        input.payloadHash,
        input.correlationId ?? randomUUID(),
      ]
    );
    return rowToWebhookReceipt(result.rows[0]);
  }

  /**
   * Looks up a prior receipt by its idempotency key, scoped to one data
   * source (matching webhook_receipts_idempotency's own composite key).
   * Returns null when no matching receipt exists — a fresh delivery, not
   * a retry — so the caller can proceed with normal processing.
   *
   * Runs on a caller-supplied client so it composes into the same
   * transaction that will go on to create the run when this returns null,
   * without a redundant separate round trip.
   */
  async findByIdempotencyKeyOn(
    client: PoolClient,
    dataSourceId: string,
    idempotencyKey: string
  ): Promise<WebhookReceipt | null> {
    const result = await client.query<Record<string, unknown>>(
      `SELECT * FROM data_acquisition.webhook_receipts
       WHERE data_source_id = $1 AND idempotency_key = $2`,
      [dataSourceId, idempotencyKey]
    );
    return result.rows.length > 0 ? rowToWebhookReceipt(result.rows[0]) : null;
  }

  async findByIdempotencyKey(
    ctx: TenantContext,
    dataSourceId: string,
    idempotencyKey: string
  ): Promise<WebhookReceipt | null> {
    return withTenantTransaction(ctx, (client) =>
      this.findByIdempotencyKeyOn(client, dataSourceId, idempotencyKey)
    );
  }
}
