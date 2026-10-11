// P0-5 Block 3c-2 - persistence access for the automation-level policy store (tables from migration 0178).
//
// ABA owns the governed, versioned policy that a package cites as `action.automationLevel.policy` (R-3) and the fact of
// which recognized levels may currently be issued. This block permits enabling LEVEL 2 only; Levels 3 and 4 can be defined
// but the database refuses to enable them until the rule-authorization sources exist and the owner authorises it.
//
// This repository STORES and READS. It seeds no policy (nothing can be issued until a Level 2 policy is created and
// enabled), does not decide issuance, emits no events and is not yet called from any route or service.

import type { TenantContext } from '../../client.js';
import { withTenantTransaction } from '../../client.js';
import { ConflictError, NotFoundError, ValidationError } from './errors.js';
import { canonical, iso, lock, mapGuardError, requireText, requireUuid } from './governanceSupport.js';

const ENTITY = 'AutomationLevelPolicy';

export type AutomationLevel = 2 | 3 | 4;

export interface CreatePolicyInput {
  policyCode: string;
  automationLevel: AutomationLevel;
  description: string;
  specification?: Readonly<Record<string, unknown>>;
  createdByUserId: string;
  correlationId: string;
}

export interface AddVersionInput {
  description: string;
  specification?: Readonly<Record<string, unknown>>;
  createdByUserId: string;
  correlationId: string;
}

export interface AutomationLevelPolicy {
  id: string;
  tenantId: string;
  workspaceId: string;
  policyCode: string;
  automationLevel: AutomationLevel;
  createdByUserId: string;
  createdAt: string;
}

export interface AutomationLevelPolicyVersion {
  /** The `policyVersionId` a package cites. */
  id: string;
  policyId: string;
  automationLevel: AutomationLevel;
  versionNumber: number;
  supersedesVersion: number | null;
  description: string;
  specification: Record<string, unknown>;
  createdByUserId: string;
  createdAt: string;
}

export interface EnablementChange {
  actorUserId: string;
  reason: string;
  correlationId: string;
}

/** The governed reference a package carries in `action.automationLevel.policy`. */
export interface EffectivePolicy {
  automationLevel: AutomationLevel;
  policyId: string;
  policyVersionId: string;
  policyCode: string;
  versionNumber: number;
}

/** Which recognized levels the current governed policy permits. Shape-compatible with the contract's `PackageEnablementPolicy`. */
export interface AutomationEnablement {
  automationLevels: AutomationLevel[];
  effective: EffectivePolicy[];
}

type Json = Record<string, unknown>;

const POLICIES = 'approved_business_action.automation_level_policies';
const VERSIONS = 'approved_business_action.automation_level_policy_versions';
const EVENTS = 'approved_business_action.automation_level_policy_enablement_events';

function rowToPolicy(row: Json): AutomationLevelPolicy {
  return {
    id: row.id as string, tenantId: row.tenant_id as string, workspaceId: row.workspace_id as string,
    policyCode: row.policy_code as string, automationLevel: row.automation_level as AutomationLevel,
    createdByUserId: row.created_by_user_id as string, createdAt: iso(row.created_at),
  };
}

function rowToVersion(row: Json): AutomationLevelPolicyVersion {
  return {
    id: row.id as string, policyId: row.policy_id as string, automationLevel: row.automation_level as AutomationLevel,
    versionNumber: row.version_number as number, supersedesVersion: (row.supersedes_version as number | null) ?? null,
    description: row.description as string, specification: row.specification as Record<string, unknown>,
    createdByUserId: row.created_by_user_id as string, createdAt: iso(row.created_at),
  };
}

/** The versions whose most recent enablement event is ENABLED, joined with their policy. */
const ENABLED_VERSIONS = `
  SELECT pv.id AS policy_version_id, pv.policy_id, pv.version_number, pv.automation_level, p.policy_code
    FROM ${VERSIONS} pv JOIN ${POLICIES} p ON p.id = pv.policy_id
   WHERE (SELECT e.state FROM ${EVENTS} e WHERE e.policy_version_id = pv.id ORDER BY e.occurred_at DESC, e.created_at DESC, e.id DESC LIMIT 1) = 'ENABLED'`;

function rowToEffective(row: Json): EffectivePolicy {
  return {
    automationLevel: row.automation_level as AutomationLevel, policyId: row.policy_id as string,
    policyVersionId: row.policy_version_id as string, policyCode: row.policy_code as string, versionNumber: row.version_number as number,
  };
}

function requireLevel(level: unknown): AutomationLevel {
  if (level !== 2 && level !== 3 && level !== 4) throw new ValidationError(ENTITY, ['automationLevel must be 2, 3 or 4 (Levels 0 and 1 do not authorize execution)']);
  return level;
}

export class AutomationLevelPolicyRepository {
  /**
   * Creates a policy and its version 1 atomically. Idempotent: the same code, level and first version returns the stored
   * pair; a different policy under an existing code is a ConflictError. The policy is NOT enabled.
   */
  async createPolicy(ctx: TenantContext, input: CreatePolicyInput): Promise<{ policy: AutomationLevelPolicy; version: AutomationLevelPolicyVersion }> {
    requireText(ENTITY, 'policyCode', input.policyCode, 100);
    requireLevel(input.automationLevel);
    requireText(ENTITY, 'description', input.description, 2000);
    requireUuid(ENTITY, 'createdByUserId', input.createdByUserId);
    requireUuid(ENTITY, 'correlationId', input.correlationId);
    const specification = input.specification ?? {};
    try {
      return await withTenantTransaction(ctx, async (client) => {
        await lock(client, `automation_policy:${ctx.tenantId}:${ctx.workspaceId}:${input.policyCode}`);
        const existing = await client.query<Json>(`SELECT * FROM ${POLICIES} WHERE policy_code = $1`, [input.policyCode]);
        if (existing.rows[0]) {
          const policy = rowToPolicy(existing.rows[0]);
          const v1 = await client.query<Json>(`SELECT * FROM ${VERSIONS} WHERE policy_id = $1 AND version_number = 1`, [policy.id]);
          const version = rowToVersion(v1.rows[0]);
          if (policy.automationLevel === input.automationLevel && version.description === input.description
              && canonical(version.specification) === canonical(specification)) return { policy, version };
          throw new ConflictError(ENTITY, `policy ${input.policyCode} already exists with a different level or first version`);
        }
        const p = await client.query<Json>(
          `INSERT INTO ${POLICIES} (tenant_id, workspace_id, policy_code, automation_level, created_by_user_id, correlation_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
          [ctx.tenantId, ctx.workspaceId, input.policyCode, input.automationLevel, input.createdByUserId, input.correlationId]);
        const policy = rowToPolicy(p.rows[0]);
        const v = await client.query<Json>(
          `INSERT INTO ${VERSIONS} (tenant_id, workspace_id, policy_id, automation_level, version_number, supersedes_version, description, specification, created_by_user_id, correlation_id)
           VALUES ($1,$2,$3,$4,1,NULL,$5,$6::jsonb,$7,$8) RETURNING *`,
          [ctx.tenantId, ctx.workspaceId, policy.id, policy.automationLevel, input.description, JSON.stringify(specification), input.createdByUserId, input.correlationId]);
        return { policy, version: rowToVersion(v.rows[0]) };
      });
    } catch (error) {
      return mapGuardError(ENTITY, error);
    }
  }

  /** Adds the next version of a policy (a changed policy is a new version, never an edit). Idempotent for an identical latest version. */
  async addVersion(ctx: TenantContext, policyId: string, input: AddVersionInput): Promise<AutomationLevelPolicyVersion> {
    requireUuid(ENTITY, 'policyId', policyId);
    requireText(ENTITY, 'description', input.description, 2000);
    requireUuid(ENTITY, 'createdByUserId', input.createdByUserId);
    requireUuid(ENTITY, 'correlationId', input.correlationId);
    const specification = input.specification ?? {};
    try {
      return await withTenantTransaction(ctx, async (client) => {
        await lock(client, `automation_policy_versions:${policyId}`);
        const policy = await client.query<Json>(`SELECT * FROM ${POLICIES} WHERE id = $1`, [policyId]);
        if (!policy.rows[0]) throw new NotFoundError(ENTITY, policyId);
        const latest = await client.query<Json>(`SELECT * FROM ${VERSIONS} WHERE policy_id = $1 ORDER BY version_number DESC LIMIT 1`, [policyId]);
        const current = rowToVersion(latest.rows[0]);
        if (current.description === input.description && canonical(current.specification) === canonical(specification)) return current;
        const inserted = await client.query<Json>(
          `INSERT INTO ${VERSIONS} (tenant_id, workspace_id, policy_id, automation_level, version_number, supersedes_version, description, specification, created_by_user_id, correlation_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10) RETURNING *`,
          [ctx.tenantId, ctx.workspaceId, policyId, policy.rows[0].automation_level, current.versionNumber + 1, current.versionNumber,
            input.description, JSON.stringify(specification), input.createdByUserId, input.correlationId]);
        return rowToVersion(inserted.rows[0]);
      });
    } catch (error) {
      return mapGuardError(ENTITY, error);
    }
  }

  /**
   * Enables a policy version for issuance at its level. The database permits Level 2 only, only the latest version of a
   * policy, and only one enabled version per level in the scope (disable the other first). Idempotent when already enabled.
   */
  async enable(ctx: TenantContext, policyVersionId: string, change: EnablementChange): Promise<EffectivePolicy> {
    return this.changeEnablement(ctx, policyVersionId, change, 'ENABLED');
  }

  /** Disables an enabled policy version. Idempotent when it is not enabled. */
  async disable(ctx: TenantContext, policyVersionId: string, change: EnablementChange): Promise<void> {
    await this.changeEnablement(ctx, policyVersionId, change, 'DISABLED');
  }

  private async changeEnablement(ctx: TenantContext, policyVersionId: string, change: EnablementChange, target: 'ENABLED' | 'DISABLED'): Promise<EffectivePolicy> {
    requireUuid(ENTITY, 'policyVersionId', policyVersionId);
    requireUuid(ENTITY, 'actorUserId', change.actorUserId);
    requireUuid(ENTITY, 'correlationId', change.correlationId);
    requireText(ENTITY, 'reason', change.reason, 1000);
    try {
      return await withTenantTransaction(ctx, async (client) => {
        const v = await client.query<Json>(
          `SELECT pv.*, p.policy_code FROM ${VERSIONS} pv JOIN ${POLICIES} p ON p.id = pv.policy_id WHERE pv.id = $1`, [policyVersionId]);
        if (!v.rows[0]) throw new NotFoundError(ENTITY, policyVersionId);
        await lock(client, `automation_policy_enablement:${ctx.tenantId}:${ctx.workspaceId}:${String(v.rows[0].automation_level)}`);
        const enabled = await client.query<Json>(`${ENABLED_VERSIONS} AND pv.id = $1`, [policyVersionId]);
        const isEnabled = enabled.rows.length > 0;
        const effective: EffectivePolicy = {
          automationLevel: v.rows[0].automation_level as AutomationLevel, policyId: v.rows[0].policy_id as string,
          policyVersionId, policyCode: v.rows[0].policy_code as string, versionNumber: v.rows[0].version_number as number,
        };
        if ((target === 'ENABLED') === isEnabled) return effective;
        await client.query(
          `INSERT INTO ${EVENTS} (tenant_id, workspace_id, policy_version_id, state, actor_user_id, reason, correlation_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [ctx.tenantId, ctx.workspaceId, policyVersionId, target, change.actorUserId, change.reason, change.correlationId]);
        return effective;
      });
    } catch (error) {
      return mapGuardError(ENTITY, error);
    }
  }

  /** The governed enablement: which recognized levels may currently be issued, and under which policy version. */
  async getEnablement(ctx: TenantContext): Promise<AutomationEnablement> {
    return withTenantTransaction(ctx, async (client) => {
      const r = await client.query<Json>(`${ENABLED_VERSIONS} ORDER BY pv.automation_level, pv.policy_id`);
      const effective = r.rows.map(rowToEffective);
      return { automationLevels: [...new Set(effective.map((e) => e.automationLevel))].sort() as AutomationLevel[], effective };
    });
  }

  /** The enabled policy version for a level, or null when that level is not enabled (it cannot be issued). */
  async getEffectivePolicy(ctx: TenantContext, level: AutomationLevel): Promise<EffectivePolicy | null> {
    requireLevel(level);
    const enablement = await this.getEnablement(ctx);
    return enablement.effective.find((e) => e.automationLevel === level) ?? null;
  }

  async getVersion(ctx: TenantContext, policyVersionId: string): Promise<AutomationLevelPolicyVersion | null> {
    requireUuid(ENTITY, 'policyVersionId', policyVersionId);
    return withTenantTransaction(ctx, async (client) => {
      const r = await client.query<Json>(`SELECT * FROM ${VERSIONS} WHERE id = $1`, [policyVersionId]);
      return r.rows[0] ? rowToVersion(r.rows[0]) : null;
    });
  }

  async getPolicyByCode(ctx: TenantContext, policyCode: string): Promise<AutomationLevelPolicy | null> {
    requireText(ENTITY, 'policyCode', policyCode, 100);
    return withTenantTransaction(ctx, async (client) => {
      const r = await client.query<Json>(`SELECT * FROM ${POLICIES} WHERE policy_code = $1`, [policyCode]);
      return r.rows[0] ? rowToPolicy(r.rows[0]) : null;
    });
  }

  async listVersions(ctx: TenantContext, policyId: string): Promise<AutomationLevelPolicyVersion[]> {
    requireUuid(ENTITY, 'policyId', policyId);
    return withTenantTransaction(ctx, async (client) => {
      const r = await client.query<Json>(`SELECT * FROM ${VERSIONS} WHERE policy_id = $1 ORDER BY version_number`, [policyId]);
      return r.rows.map(rowToVersion);
    });
  }
}
