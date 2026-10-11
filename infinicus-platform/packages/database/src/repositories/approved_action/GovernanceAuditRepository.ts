// P0-5 ABA authoring - the platform audit record for ABA governance mutations (no migration: audit.audit_events exists since 0006).
//
// Every ABA governance change (action-type registration, policy versions and enablement, capture, owner, boundaries) is recorded as ONE
// append-only `audit.audit_events` row: actor, permission used, tenant / workspace / business (where one applies), target object,
// database time, correlation id and the reason. It is DELIBERATELY not written to approval_audit_events (approval, refusal, expiry and
// issuance audit) nor to approval_authority_scopes (authority grant / revoke provenance): the three records keep their separate meanings.
// Joins the caller's shared tenant transaction, so a mutation and its audit commit or roll back together.

import type { TenantContext } from '../../client.js';
import { withTenantTransaction } from '../../client.js';
import { ValidationError } from './errors.js';
import { UUID_PATTERN } from './governanceSupport.js';

const ENTITY = 'GovernanceAudit';

export interface GovernanceAuditInput {
  /** Dotted verb, e.g. `aba.capture.recorded`. */
  action: string;
  entityType: string;
  entityId: string | null;
  /** The business the change belongs to; null for workspace-level governance (action types, policies). */
  businessId: string | null;
  correlationId: string;
  /** The permission the request was authorized under, and any reason / request detail. Never secrets. */
  metadata: Record<string, unknown>;
}

export class GovernanceAuditRepository {
  /** Appends one governance audit row for the authenticated actor (`ctx.userId`) and returns its id. */
  async record(ctx: TenantContext, input: GovernanceAuditInput): Promise<string> {
    if (!/^aba\.[a-z_]+\.[a-z_]+$/.test(input.action)) throw new ValidationError(ENTITY, ['action must look like aba.<object>.<verb>']);
    if (!UUID_PATTERN.test(input.correlationId)) throw new ValidationError(ENTITY, ['correlationId must be a lowercase UUID']);
    if (input.businessId !== null && !UUID_PATTERN.test(input.businessId)) throw new ValidationError(ENTITY, ['businessId must be a lowercase UUID']);
    if (input.entityId !== null && !UUID_PATTERN.test(input.entityId)) throw new ValidationError(ENTITY, ['entityId must be a lowercase UUID']);
    if (typeof input.metadata.permissionUsed !== 'string' || input.metadata.permissionUsed.length === 0) {
      throw new ValidationError(ENTITY, ['metadata.permissionUsed is required']);
    }
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<{ id: string }>(
        `INSERT INTO audit.audit_events
           (tenant_id, workspace_id, business_id, actor_type, actor_id, action, entity_type, entity_id, metadata, correlation_id)
         VALUES ($1,$2,$3,'user',$4,$5,$6,$7,$8::jsonb,$9) RETURNING id`,
        [ctx.tenantId, ctx.workspaceId, input.businessId, ctx.userId, input.action, input.entityType, input.entityId, JSON.stringify(input.metadata), input.correlationId],
      );
      return result.rows[0].id;
    });
  }

  /** Database time (millisecond UTC) - the only clock authoring stamps use. */
  async databaseNow(ctx: TenantContext): Promise<string> {
    return withTenantTransaction(ctx, async (client) => {
      const r = await client.query<{ now: string }>(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`);
      return r.rows[0].now;
    });
  }
}
