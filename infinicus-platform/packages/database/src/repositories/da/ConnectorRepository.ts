import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'crypto';
import type { PoolClient, QueryResult } from 'pg';
import type { TenantContext } from '../../client.js';
import { withTenantTransaction, withTransaction } from '../../client.js';
import {
  NotFoundError,
  UnsupportedConnectorError,
  ValidationError,
} from './errors.js';
import { runGuardedTransition } from './guards.js';
import { boundedPage } from './pagination.js';
import type { PageOptions } from './pagination.js';
import { emitConnectorRegistered } from './outbox.js';

/**
 * Connector types permitted by connectors_type_check.
 *
 * These are the thirteen values legal after migration
 * 0169_add_manual_json_connector_type.sql — the original twelve from
 * 0013_create_da_sources_connectors.sql plus 'manual_json', which BUILD-31
 * §4.4 requires as the first implemented connector type.
 */
export type ConnectorType =
  | 'rest_api'
  | 'graphql'
  | 'webhook'
  | 'postgres'
  | 'mysql'
  | 'mssql'
  | 'sqlite'
  | 'sftp'
  | 'object_storage'
  | 'file_upload'
  | 'event_stream'
  | 'custom'
  | 'manual_json';

/**
 * Connector lifecycle states, mirroring connectors_status_check in
 * migration 0013_create_da_sources_connectors.sql.
 *
 * This is a set of permitted *values*, not a lifecycle policy. BUILD-31 does
 * not define which connector status may follow which, so this module makes no
 * such claim — see updateStatus.
 */
export type ConnectorStatus =
  | 'draft'
  | 'active'
  | 'paused'
  | 'suspended'
  | 'retired'
  | 'failed';

/**
 * Connector health states, mirroring connectors_health_check in
 * migration 0013_create_da_sources_connectors.sql.
 */
export type ConnectorHealthStatus =
  | 'unknown'
  | 'healthy'
  | 'degraded'
  | 'unhealthy'
  | 'offline';

const CONNECTOR_TYPES: readonly ConnectorType[] = Object.freeze([
  'rest_api',
  'graphql',
  'webhook',
  'postgres',
  'mysql',
  'mssql',
  'sqlite',
  'sftp',
  'object_storage',
  'file_upload',
  'event_stream',
  'custom',
  'manual_json',
]);

const CONNECTOR_STATUSES: readonly ConnectorStatus[] = Object.freeze([
  'draft',
  'active',
  'paused',
  'suspended',
  'retired',
  'failed',
]);

const CONNECTOR_HEALTH_STATUSES: readonly ConnectorHealthStatus[] = Object.freeze([
  'unknown',
  'healthy',
  'degraded',
  'unhealthy',
  'offline',
]);

function isConnectorType(value: string): value is ConnectorType {
  return (CONNECTOR_TYPES as readonly string[]).includes(value);
}

function isConnectorStatus(value: string): value is ConnectorStatus {
  return (CONNECTOR_STATUSES as readonly string[]).includes(value);
}

function isConnectorHealthStatus(value: string): value is ConnectorHealthStatus {
  return (CONNECTOR_HEALTH_STATUSES as readonly string[]).includes(value);
}

export interface Connector {
  id: string;
  tenantId: string;
  workspaceId: string;
  dataSourceId: string;
  name: string;
  connectorType: string;
  protocol: string | null;
  connectorVersion: string;
  capabilities: Record<string, unknown>;
  configurationReference: string | null;
  healthStatus: string;
  lastHealthCheckAt: Date | null;
  status: string;
  version: number;
  correlationId: string;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string | null;
  deletedAt: Date | null;
  /** Non-secret half of the webhook bearer token (see generateWebhookToken); null until generated. */
  webhookTokenPrefix: string | null;
}

/** Result of find_connector_for_webhook() — the minimal fields needed to verify an inbound webhook and open a real tenant-scoped transaction. Never exposed as a full Connector. */
export interface WebhookConnectorLookup {
  connectorId: string;
  tenantId: string;
  workspaceId: string;
  businessId: string | null;
  dataSourceId: string;
  connectorStatus: string;
  sourceStatus: string;
  webhookTokenHash: string;
  createdBy: string | null;
}

export interface CreateConnectorInput {
  dataSourceId: string;
  name: string;
  connectorType: string;
  protocol?: string;
  connectorVersion?: string;
  capabilities?: Record<string, unknown>;
  configurationReference?: string;
  status?: string;
  correlationId?: string;
  createdBy?: string;
}

function rowToConnector(row: Record<string, unknown>): Connector {
  return {
    id:                     row.id                       as string,
    tenantId:               row.tenant_id                as string,
    workspaceId:            row.workspace_id             as string,
    dataSourceId:           row.data_source_id           as string,
    name:                   row.name                     as string,
    connectorType:          row.connector_type           as string,
    protocol:               row.protocol                 as string | null,
    connectorVersion:       row.connector_version        as string,
    capabilities:           row.capabilities             as Record<string, unknown>,
    configurationReference: row.configuration_reference  as string | null,
    healthStatus:           row.health_status            as string,
    lastHealthCheckAt:      row.last_health_check_at     as Date | null,
    status:                 row.status                   as string,
    version:                row.version                  as number,
    correlationId:          row.correlation_id           as string,
    createdAt:              row.created_at               as Date,
    updatedAt:              row.updated_at               as Date,
    createdBy:              row.created_by               as string | null,
    deletedAt:              row.deleted_at               as Date | null,
    webhookTokenPrefix:     row.webhook_token_prefix     as string | null,
  };
}

const WEBHOOK_TOKEN_PREFIX_BYTES = 6;
const WEBHOOK_TOKEN_SECRET_BYTES = 32;

export function hashWebhookToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

/**
 * Constant-time comparison of two hex-encoded hashes — a plain `===` would
 * leak timing information proportional to the number of matching leading
 * characters, letting an attacker recover the hash (and thus forge a
 * request that produces it) byte by byte.
 */
export function webhookTokenHashesMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export class ConnectorRepository {
  /**
   * Registers a connector and publishes da.connector.registered.
   *
   * BUILD-31 §6.2 defines this as one transaction: the connector row and the
   * outbox row commit together or not at all, so the emission runs on the same
   * client inside withTenantTransaction.
   *
   * Both inputs are validated before the transaction opens, so an unsupported
   * value never reaches PostgreSQL and never surfaces as a raw CHECK
   * violation — BUILD-31 §7 requires the application error model, not the
   * database, to reject it. The CHECK constraint remains as defence in depth.
   */
  async create(ctx: TenantContext, input: CreateConnectorInput): Promise<Connector> {
    if (!isConnectorType(input.connectorType)) {
      throw new UnsupportedConnectorError(input.connectorType);
    }

    if (input.status !== undefined && !isConnectorStatus(input.status)) {
      throw new ValidationError(
        'Unsupported connector status: ' + String(input.status)
      );
    }

    return withTenantTransaction(ctx, async (client) => {
      const result: QueryResult<Record<string, unknown>> = await client.query(
        `INSERT INTO data_acquisition.connectors
           (tenant_id, workspace_id, data_source_id, name, connector_type,
            protocol, connector_version, capabilities, configuration_reference,
            status, correlation_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING *`,
        [
          ctx.tenantId,
          ctx.workspaceId,
          input.dataSourceId,
          input.name,
          input.connectorType,
          input.protocol              ?? null,
          input.connectorVersion      ?? '1.0',
          JSON.stringify(input.capabilities ?? {}),
          input.configurationReference ?? null,
          input.status                ?? 'draft',
          input.correlationId         ?? randomUUID(),
          input.createdBy             ?? null,
        ]
      );

      const connector = rowToConnector(result.rows[0]);

      // Correlation is read back from the persisted row rather than the input,
      // so the event carries the same correlation_id the connector was stored
      // with even when the caller supplied none and the column defaulted.
      await emitConnectorRegistered(client, ctx, {
        connectorId:   connector.id,
        sourceId:      connector.dataSourceId,
        connectorType: connector.connectorType,
        correlationId: connector.correlationId,
      });

      return connector;
    });
  }

  async findById(ctx: TenantContext, id: string): Promise<Connector> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        'SELECT * FROM data_acquisition.connectors WHERE id = $1',
        [id]
      );
      if (result.rows.length === 0) throw new NotFoundError('Connector', id);
      return rowToConnector(result.rows[0]);
    });
  }

  /**
   * Looks up a connector that must belong to the given data source.
   *
   * BUILD-31 §4.4 requires a connector to belong to the requested source and
   * §4.7 requires a lookup constrained by source. Enforcing ownership in the
   * WHERE clause means a connector addressed through the wrong source is not
   * found, rather than being fetched and then checked.
   */
  async findByIdForSource(
    ctx: TenantContext,
    dataSourceId: string,
    id: string
  ): Promise<Connector> {
    return withTenantTransaction(
      ctx,
      (client) => this.findByIdForSourceOn(client, ctx, dataSourceId, id)
    );
  }

  /**
   * findByIdForSource() on a caller-supplied PoolClient.
   * Does not open or control a transaction; callers composing multiple
   * operations must supply the client from one outer withTenantTransaction().
   */
  async findByIdForSourceOn(
    client: PoolClient,
    ctx: TenantContext,
    dataSourceId: string,
    id: string
  ): Promise<Connector> {
    const result = await client.query<Record<string, unknown>>(
      `SELECT * FROM data_acquisition.connectors
       WHERE id = $1 AND data_source_id = $2`,
      [id, dataSourceId]
    );
    if (result.rows.length === 0) throw new NotFoundError('Connector', id);
    return rowToConnector(result.rows[0]);
  }

  /**
   * Lists a source's connectors, bounded by BUILD-31 §4 pagination limits.
   *
   * `page` is optional so existing callers keep working; omitting it yields
   * the explicit DEFAULT_PAGE_SIZE rather than an unbounded scan.
   */
  async listByDataSource(
    ctx: TenantContext,
    dataSourceId: string,
    page: PageOptions = {}
  ): Promise<Connector[]> {
    const { limit, offset } = boundedPage(page);

    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `SELECT * FROM data_acquisition.connectors
         WHERE data_source_id = $1 AND deleted_at IS NULL
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [dataSourceId, limit, offset]
      );
      return result.rows.map(rowToConnector);
    });
  }

  /**
   * Sets the connector's status under an optimistic concurrency guard.
   *
   * This method deliberately encodes NO lifecycle policy. BUILD-31 defines a
   * state machine for collection runs (§4.6) but defines none for connectors,
   * so this repository does not decide which status may follow which — that
   * remains open for the connector lifecycle service to specify once frozen.
   *
   * What it does enforce is that the write is not lost. The status read here
   * becomes the expected value of the guarded UPDATE, making the pair a
   * compare-and-swap: if a concurrent transaction changes the status between
   * the read and the UPDATE, the guard matches zero rows and
   * runGuardedTransition raises InvalidStateTransitionError instead of
   * silently overwriting the other writer's value.
   *
   * @throws ValidationError             `next` is not a permitted status value
   * @throws NotFoundError               connector not visible to this tenant
   * @throws InvalidStateTransitionError status changed under us concurrently
   */
  async updateStatus(
    ctx: TenantContext,
    id: string,
    next: ConnectorStatus
  ): Promise<Connector> {
    if (!isConnectorStatus(next)) {
      throw new ValidationError('Unsupported connector status: ' + String(next));
    }

    return withTenantTransaction(ctx, async (client) => {
      const current = await client.query<{ status: string }>(
        'SELECT status FROM data_acquisition.connectors WHERE id = $1',
        [id]
      );

      if (current.rows.length === 0) {
        throw new NotFoundError('Connector', id);
      }

      const row = await runGuardedTransition(client, {
        table:       'data_acquisition.connectors',
        stateColumn: 'status',
        entity:      'Connector',
        id,
        // The observed value only — never a policy-derived list. This asserts
        // "nobody moved this row since I read it", not "this edge is legal".
        expected:    [current.rows[0].status],
        next,
        extraSet:    ['version = version + 1'],
      });

      return rowToConnector(row);
    });
  }

  /**
   * Records a health-check result.
   *
   * Health is an observation rather than a lifecycle transition, so this is
   * not routed through runGuardedTransition. The value is validated against
   * the permitted set first, per BUILD-31 §4.7, so an unknown value raises a
   * controlled error instead of a raw CHECK-constraint violation.
   */
  async updateHealth(
    ctx: TenantContext,
    id: string,
    healthStatus: ConnectorHealthStatus
  ): Promise<Connector> {
    if (!isConnectorHealthStatus(healthStatus)) {
      throw new ValidationError(
        'Unsupported connector health status: ' + String(healthStatus)
      );
    }

    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `UPDATE data_acquisition.connectors
         SET health_status = $2, last_health_check_at = now(), version = version + 1
         WHERE id = $1
         RETURNING *`,
        [id, healthStatus]
      );
      if (result.rows.length === 0) throw new NotFoundError('Connector', id);
      return rowToConnector(result.rows[0]);
    });
  }

  /**
   * (Re)generates a webhook connector's bearer token. The raw token
   * (`prefix.secret`) is returned exactly once — only its SHA-256 hash and
   * the non-secret prefix are persisted, the same generateApiKey()/
   * hashToken() shape @infinicus/authentication already uses for session
   * tokens and API keys. Calling this again on an already-tokened
   * connector rotates it: the old token stops working immediately, since
   * only one (prefix, hash) pair is stored per connector.
   *
   * @throws NotFoundError connector not visible to this tenant
   */
  async generateWebhookToken(ctx: TenantContext, connectorId: string): Promise<string> {
    const prefix = randomBytes(WEBHOOK_TOKEN_PREFIX_BYTES).toString('hex');
    const secret = randomBytes(WEBHOOK_TOKEN_SECRET_BYTES).toString('hex');
    const rawToken = `${prefix}.${secret}`;
    const hash = hashWebhookToken(rawToken);

    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `UPDATE data_acquisition.connectors
         SET webhook_token_prefix = $2, webhook_token_hash = $3, version = version + 1
         WHERE id = $1
         RETURNING id`,
        [connectorId, prefix, hash]
      );
      if (result.rows.length === 0) throw new NotFoundError('Connector', connectorId);
      return rawToken;
    });
  }

  /**
   * Resolves an inbound webhook's token prefix to its owning
   * connector/tenant/workspace via the SECURITY DEFINER
   * find_connector_for_webhook() function (0171_create_da_webhook_token_lookup.sql),
   * which deliberately bypasses RLS for this one read — there is no tenant
   * context yet, since the request carries only the token itself. Returns
   * null rather than throwing when the prefix is unknown, so the caller
   * can respond identically to "unknown token" and "wrong token" without
   * a branch (never confirm or deny that a prefix exists).
   *
   * Does NOT verify the token's secret half — callers must compare their
   * own hash of the full raw token against the returned webhookTokenHash
   * using webhookTokenHashesMatch(), then open a real withTenantTransaction
   * for everything after that point.
   */
  async findConnectorForWebhook(tokenPrefix: string): Promise<WebhookConnectorLookup | null> {
    return withTransaction(async (client) => {
      const result = await client.query<Record<string, unknown>>(
        'SELECT * FROM data_acquisition.find_connector_for_webhook($1)',
        [tokenPrefix]
      );
      if (result.rows.length === 0) return null;
      const row = result.rows[0];
      return {
        connectorId:      row.connector_id      as string,
        tenantId:         row.tenant_id         as string,
        workspaceId:      row.workspace_id      as string,
        businessId:       row.business_id       as string | null,
        dataSourceId:     row.data_source_id    as string,
        connectorStatus:  row.connector_status  as string,
        sourceStatus:     row.source_status     as string,
        webhookTokenHash: row.webhook_token_hash as string,
        createdBy:        row.created_by        as string | null,
      };
    });
  }
}
