import type { PoolClient } from 'pg';
import type { BusinessEventEnvelope } from '@infinicus/event-contracts';
import { validateBusinessEventEnvelope } from '@infinicus/event-contracts';
import type { TenantContext } from '../client.js';
import { withTenantTransaction } from '../client.js';
import {
  EventLedgerConflictError,
  EventLedgerNotFoundError,
  EventLedgerScopeError,
  EventLedgerValidationError,
} from './errors.js';

export type StoredBusinessEvent<TPayload = unknown> = BusinessEventEnvelope<TPayload>;

function rowToEvent(row: Record<string, unknown>): StoredBusinessEvent {
  return {
    eventId: row.event_id as string,
    eventType: row.event_type as string,
    eventVersion: row.event_version as string,
    tenantId: row.tenant_id as string,
    workspaceId: row.workspace_id as string,
    businessId: row.business_id as string | null,
    sourceDomain: row.source_domain as StoredBusinessEvent['sourceDomain'],
    sourceService: row.source_service as string,
    aggregateType: row.aggregate_type as string,
    aggregateId: row.aggregate_id as string,
    correlationId: row.correlation_id as string,
    causationId: row.causation_id as string | null,
    occurredAt: (row.occurred_at as Date).toISOString(),
    recordedAt: (row.recorded_at as Date).toISOString(),
    actor: row.actor_type === null ? null : {
      actorType: row.actor_type as NonNullable<StoredBusinessEvent['actor']>['actorType'],
      actorId: row.actor_id as string | null,
    },
    idempotencyKey: row.idempotency_key as string | null,
    payload: row.payload,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    provenance: row.provenance as StoredBusinessEvent['provenance'],
    schemaName: row.schema_name as string,
    schemaVersion: row.schema_version as string,
    sensitivity: row.sensitivity as StoredBusinessEvent['sensitivity'],
  };
}

const SELECT_COLUMNS = `
  event_id, event_type, event_version,
  tenant_id, workspace_id, business_id,
  source_domain, source_service,
  aggregate_type, aggregate_id,
  correlation_id, causation_id,
  actor_type, actor_id, idempotency_key,
  payload, metadata, provenance,
  schema_name, schema_version, sensitivity,
  occurred_at, recorded_at
`;

async function findIdempotent(
  client: PoolClient,
  event: BusinessEventEnvelope,
): Promise<StoredBusinessEvent | null> {
  if (!event.idempotencyKey) return null;
  const result = await client.query<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS}
       FROM events.business_event_ledger
      WHERE tenant_id = $1
        AND workspace_id = $2
        AND source_domain = $3
        AND source_service = $4
        AND idempotency_key = $5
      LIMIT 1`,
    [
      event.tenantId,
      event.workspaceId,
      event.sourceDomain,
      event.sourceService,
      event.idempotencyKey,
    ],
  );
  return result.rows[0] ? rowToEvent(result.rows[0]) : null;
}

function sameLogicalEvent(existing: StoredBusinessEvent, incoming: BusinessEventEnvelope): boolean {
  return existing.eventType === incoming.eventType
    && existing.eventVersion === incoming.eventVersion
    && existing.aggregateType === incoming.aggregateType
    && existing.aggregateId === incoming.aggregateId
    && existing.correlationId === incoming.correlationId;
}

export class EventLedgerRepository {
  async append<TPayload>(
    ctx: TenantContext,
    event: BusinessEventEnvelope<TPayload>,
  ): Promise<StoredBusinessEvent<TPayload>> {
    const validation = validateBusinessEventEnvelope(event);
    if (!validation.valid) throw new EventLedgerValidationError(validation.reasons);
    if (event.tenantId !== ctx.tenantId || event.workspaceId !== ctx.workspaceId) {
      throw new EventLedgerScopeError();
    }

    return withTenantTransaction(ctx, async (client) => {
      const prior = await findIdempotent(client, event);
      if (prior) {
        if (!sameLogicalEvent(prior, event)) throw new EventLedgerConflictError(event.eventId);
        return prior as StoredBusinessEvent<TPayload>;
      }

      try {
        const result = await client.query<Record<string, unknown>>(
          `INSERT INTO events.business_event_ledger (
             event_id, event_type, event_version,
             tenant_id, workspace_id, business_id,
             source_domain, source_service,
             aggregate_type, aggregate_id,
             correlation_id, causation_id,
             actor_type, actor_id, idempotency_key,
             payload, metadata, provenance,
             schema_name, schema_version, sensitivity,
             occurred_at, recorded_at
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
             $16::jsonb,$17::jsonb,$18::jsonb,$19,$20,$21,$22,$23
           )
           RETURNING ${SELECT_COLUMNS}`,
          [
            event.eventId,
            event.eventType,
            event.eventVersion,
            event.tenantId,
            event.workspaceId,
            event.businessId,
            event.sourceDomain,
            event.sourceService,
            event.aggregateType,
            event.aggregateId,
            event.correlationId,
            event.causationId,
            event.actor?.actorType ?? null,
            event.actor?.actorId ?? null,
            event.idempotencyKey,
            JSON.stringify(event.payload),
            JSON.stringify(event.metadata),
            event.provenance === null ? null : JSON.stringify(event.provenance),
            event.schemaName,
            event.schemaVersion,
            event.sensitivity,
            event.occurredAt,
            event.recordedAt,
          ],
        );
        return rowToEvent(result.rows[0]) as StoredBusinessEvent<TPayload>;
      } catch (error) {
        const pgError = error as { code?: string };
        if (pgError.code === '23505') {
          const replay = await findIdempotent(client, event);
          if (replay && sameLogicalEvent(replay, event)) {
            return replay as StoredBusinessEvent<TPayload>;
          }
          throw new EventLedgerConflictError(event.eventId);
        }
        throw error;
      }
    });
  }

  async findById(ctx: TenantContext, eventId: string): Promise<StoredBusinessEvent> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `SELECT ${SELECT_COLUMNS}
           FROM events.business_event_ledger
          WHERE event_id = $1`,
        [eventId],
      );
      if (!result.rows[0]) throw new EventLedgerNotFoundError(eventId);
      return rowToEvent(result.rows[0]);
    });
  }

  async listByCorrelation(
    ctx: TenantContext,
    correlationId: string,
    limit = 100,
  ): Promise<StoredBusinessEvent[]> {
    const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `SELECT ${SELECT_COLUMNS}
           FROM events.business_event_ledger
          WHERE correlation_id = $1
          ORDER BY occurred_at ASC, recorded_at ASC, event_id ASC
          LIMIT $2`,
        [correlationId, boundedLimit],
      );
      return result.rows.map(rowToEvent);
    });
  }
}
