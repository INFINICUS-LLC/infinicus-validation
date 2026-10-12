// P0-6e - persistence of the GOVERNED ACTIVATION record (migration 0195): "may this supported action type execute for this business?".
//
// Append-only and version-chained. NO ROW, or a latest DISABLED row, is CLOSED: `isEnabled` answers true only for a latest ENABLED row, and any
// read problem is the caller's closed gate. Recording the state a business is already in changes nothing (idempotent). The record authorizes
// nothing by itself - ABA authorization, the BO claim, the fresh authority check and the execution boundaries are all still required.

import type { PoolClient } from 'pg';
import type { TenantContext } from '../../client.js';
import { withTenantTransaction } from '../../client.js';

const S = 'business_operations';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Json = Record<string, unknown>;

export type ActivationState = 'ENABLED' | 'DISABLED';

export interface ExecutionCapabilityActivation {
  id: string;
  tenantId: string;
  workspaceId: string;
  businessId: string;
  actionType: { code: string; schemaVersion: string };
  version: number;
  state: ActivationState;
  actorUserId: string;
  permissionCode: string;
  reason: string;
  recordedAt: string;
}

export interface RecordActivationInput {
  businessId: string;
  actionType: { code: string; schemaVersion: string };
  state: ActivationState;
  /** The permission the actor was authorized under (recorded as the governing fact). */
  permissionCode: string;
  reason: string;
  correlationId: string;
}

export class ExecutionCapabilityActivationInvalidError extends Error {
  constructor(reason: string) {
    super(`ExecutionCapabilityActivation invalid: ${reason}`);
    this.name = 'ExecutionCapabilityActivationInvalidError';
  }
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

function rowToActivation(r: Json): ExecutionCapabilityActivation {
  return {
    id: r.id as string, tenantId: r.tenant_id as string, workspaceId: r.workspace_id as string, businessId: r.business_id as string,
    actionType: { code: r.action_type_code as string, schemaVersion: r.action_type_schema_version as string },
    version: r.version as number, state: r.state as ActivationState, actorUserId: r.actor_user_id as string,
    permissionCode: r.permission_code as string, reason: r.reason as string, recordedAt: iso(r.recorded_at),
  };
}

export class ExecutionCapabilityActivationRepository {
  /** The latest activation fact for the business and action type, or null when none was ever recorded (CLOSED). */
  async getCurrent(ctx: TenantContext, businessId: string, actionType: { code: string; schemaVersion: string }): Promise<ExecutionCapabilityActivation | null> {
    return withTenantTransaction(ctx, (client) => this.latest(client, businessId, actionType));
  }

  /** True only for a latest ENABLED row in the caller's scope. Every other case - no row, DISABLED, malformed id - is false. */
  async isEnabled(ctx: TenantContext, businessId: string, actionType: { code: string; schemaVersion: string }): Promise<boolean> {
    if (!UUID.test(businessId)) return false;
    const current = await this.getCurrent(ctx, businessId, actionType);
    return current?.state === 'ENABLED';
  }

  async history(ctx: TenantContext, businessId: string, actionType: { code: string; schemaVersion: string }): Promise<ExecutionCapabilityActivation[]> {
    return withTenantTransaction(ctx, async (client) => {
      const r = await client.query<Json>(
        `SELECT * FROM ${S}.execution_capability_activations WHERE business_id = $1 AND action_type_code = $2 AND action_type_schema_version = $3 ORDER BY version`,
        [businessId, actionType.code, actionType.schemaVersion],
      );
      return r.rows.map(rowToActivation);
    });
  }

  /**
   * Appends the next version on the CALLER'S transaction (so the audit row can share it). Recording the state the business is already in
   * returns the existing latest row with `changed: false` and writes nothing. Concurrent callers are serialized per (business, action type).
   */
  async recordOnClient(client: PoolClient, ctx: TenantContext, input: RecordActivationInput): Promise<{ activation: ExecutionCapabilityActivation; changed: boolean }> {
    if (!UUID.test(input.businessId)) throw new ExecutionCapabilityActivationInvalidError('businessId must be a lowercase UUID');
    if (!UUID.test(ctx.userId)) throw new ExecutionCapabilityActivationInvalidError('the actor must be a user id (lowercase UUID)');
    if (input.state !== 'ENABLED' && input.state !== 'DISABLED') throw new ExecutionCapabilityActivationInvalidError('state must be ENABLED or DISABLED');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`execution_capability_activations:${input.businessId}:${input.actionType.code}@${input.actionType.schemaVersion}`]);
    const current = await this.latest(client, input.businessId, input.actionType);
    if (current && current.state === input.state) return { activation: current, changed: false };
    const r = await client.query<Json>(
      `INSERT INTO ${S}.execution_capability_activations
         (tenant_id, workspace_id, business_id, action_type_code, action_type_schema_version, version, state, actor_user_id, permission_code, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [ctx.tenantId, ctx.workspaceId, input.businessId, input.actionType.code, input.actionType.schemaVersion, (current?.version ?? 0) + 1, input.state, ctx.userId, input.permissionCode, input.reason],
    );
    return { activation: rowToActivation(r.rows[0]), changed: true };
  }

  /** Platform audit row on the SAME client as the activation it describes (one record, no second source of truth). */
  async recordAudit(client: PoolClient, ctx: TenantContext, a: { businessId: string; action: string; entityId: string; correlationId: string; metadata: Json }): Promise<void> {
    await client.query(
      `INSERT INTO audit.audit_events
         (tenant_id, workspace_id, business_id, actor_type, actor_id, action, entity_type, entity_id, metadata, correlation_id)
       VALUES ($1,$2,$3,'user',$4,$5,'execution_capability_activation',$6,$7::jsonb,$8)`,
      [ctx.tenantId, ctx.workspaceId, a.businessId, ctx.userId, a.action, a.entityId, JSON.stringify(a.metadata), a.correlationId],
    );
  }

  private async latest(client: PoolClient, businessId: string, actionType: { code: string; schemaVersion: string }): Promise<ExecutionCapabilityActivation | null> {
    const r = await client.query<Json>(
      `SELECT * FROM ${S}.execution_capability_activations WHERE business_id = $1 AND action_type_code = $2 AND action_type_schema_version = $3 ORDER BY version DESC LIMIT 1`,
      [businessId, actionType.code, actionType.schemaVersion],
    );
    return r.rows[0] ? rowToActivation(r.rows[0]) : null;
  }
}
