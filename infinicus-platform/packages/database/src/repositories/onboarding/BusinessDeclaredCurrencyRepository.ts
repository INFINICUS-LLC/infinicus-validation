// Business Administration - the governed, business-scoped DECLARED CURRENCY (migration 0185: platform.business_currency_declarations).
//
// Ownership: Business Administration owns the WRITE (BusinessDeclaredCurrencyRepository, used by the Business Administration service).
// Everything else (the Business Operations evaluator, ABA) may only READ through BusinessDeclaredCurrencyReader, which has no write
// method. A business with no declaration is UNDECLARED: the reader never consults tenancy.tenants.default_currency,
// business_operations.business_profile_extensions.default_currency or any other default, and never returns a currency it was not
// explicitly given. The table is an append-only version chain; a change appends a new version and rewrites nothing.

import type { PoolClient } from 'pg';
import { withTenantTransaction, type TenantContext } from '../../client.js';
import { BusinessNotFoundError, ConflictError } from './errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Canonical currency representation (the Block C / 0183 convention): exactly three uppercase ASCII letters, never normalised. */
export const DECLARED_CURRENCY_PATTERN = /^[A-Z]{3}$/;
export const DECLARED_CURRENCY_REASON_MAX_LENGTH = 1000;
const ENTITY = 'BusinessDeclaredCurrency';

export class DeclaredCurrencyValidationError extends Error {
  constructor(reasons: readonly string[]) {
    super(`${ENTITY} invalid: ${reasons.join(', ')}`);
    this.name = 'ValidationError';
  }
}
export class DeclaredCurrencyConflictError extends ConflictError {}

export interface DeclaredCurrencyRecord {
  declarationId: string;
  businessId: string;
  version: number;
  currency: string;
  priorCurrency: string | null;
  supersedesVersion: number | null;
  provenance: 'EXPLICIT_DECLARATION';
  declaredByUserId: string;
  permissionUsed: string;
  reason: string | null;
  correlationId: string;
  /** Database time, millisecond UTC. */
  declaredAt: string;
}

/** UNDECLARED carries no currency by construction - there is nothing to mistake for a value. */
export type DeclaredCurrencyState =
  | { status: 'UNDECLARED'; businessId: string }
  | { status: 'DECLARED'; businessId: string; current: DeclaredCurrencyRecord };

const COLUMNS = `id, business_id, version, declared_currency, prior_declared_currency, supersedes_version, provenance, declared_by_user_id,
  permission_used, reason, correlation_id, to_char(declared_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS declared_at_iso`;

function rowToRecord(row: Record<string, unknown>): DeclaredCurrencyRecord {
  return {
    declarationId: row.id as string,
    businessId: row.business_id as string,
    version: row.version as number,
    currency: row.declared_currency as string,
    priorCurrency: (row.prior_declared_currency as string | null) ?? null,
    supersedesVersion: (row.supersedes_version as number | null) ?? null,
    provenance: row.provenance as 'EXPLICIT_DECLARATION',
    declaredByUserId: row.declared_by_user_id as string,
    permissionUsed: row.permission_used as string,
    reason: (row.reason as string | null) ?? null,
    correlationId: row.correlation_id as string,
    declaredAt: row.declared_at_iso as string,
  };
}

function requireBusinessId(businessId: string): void {
  if (!UUID.test(businessId)) throw new DeclaredCurrencyValidationError(['businessId must be a lowercase UUID']);
}

/** READ-ONLY governed boundary. This is the only class Business Operations and ABA may use; it has no mutation method. */
export class BusinessDeclaredCurrencyReader {
  /** The current declaration of a business in the caller's tenant + workspace, or UNDECLARED. Never a default. */
  async getCurrent(ctx: TenantContext, businessId: string): Promise<DeclaredCurrencyState> {
    requireBusinessId(businessId);
    return withTenantTransaction(ctx, async (client) => {
      const r = await client.query<Record<string, unknown>>(
        `SELECT ${COLUMNS} FROM platform.business_currency_declarations
          WHERE tenant_id = $1 AND workspace_id = $2 AND business_id = $3 ORDER BY version DESC LIMIT 1`,
        [ctx.tenantId, ctx.workspaceId, businessId],
      );
      return r.rows.length === 0 ? { status: 'UNDECLARED', businessId } : { status: 'DECLARED', businessId, current: rowToRecord(r.rows[0]) };
    });
  }

  /** Full declaration history, oldest first. */
  async history(ctx: TenantContext, businessId: string): Promise<DeclaredCurrencyRecord[]> {
    requireBusinessId(businessId);
    return withTenantTransaction(ctx, async (client) => {
      const r = await client.query<Record<string, unknown>>(
        `SELECT ${COLUMNS} FROM platform.business_currency_declarations
          WHERE tenant_id = $1 AND workspace_id = $2 AND business_id = $3 ORDER BY version ASC`,
        [ctx.tenantId, ctx.workspaceId, businessId],
      );
      return r.rows.map(rowToRecord);
    });
  }
}

export interface DeclareCurrencyInput {
  businessId: string;
  /** Canonical three-uppercase-letter code. Never normalised: 'usd' is refused. */
  currency: string;
  /** The version the caller believes is current; null means "the business is UNDECLARED". A mismatch is a conflict. */
  expectedVersion: number | null;
  /** Required for a change (a declaration that replaces an existing one); optional for the first declaration. */
  reason?: string;
  permissionUsed: string;
  correlationId: string;
  /** The original edge correlation id (any string), kept in the audit metadata. */
  requestCorrelationId?: string;
}

export type DeclareCurrencyOutcome = 'DECLARED' | 'CHANGED' | 'UNCHANGED';
export interface DeclareCurrencyResult {
  outcome: DeclareCurrencyOutcome;
  record: DeclaredCurrencyRecord;
  /** The record this declaration replaced (CHANGED only). */
  previous: DeclaredCurrencyRecord | null;
}

export const DECLARED_CURRENCY_AUDIT_ENTITY = 'BusinessDeclaredCurrency';
export const DECLARED_CURRENCY_AUDIT_DECLARED = 'business_admin.declared_currency.declared';
export const DECLARED_CURRENCY_AUDIT_CHANGED = 'business_admin.declared_currency.changed';

/**
 * Business Administration's WRITE path. The declaration and its audit row are written on ONE transaction client, so they commit or roll
 * back together: if the audit write fails, the declaration is undone. An exact replay writes neither.
 */
export class BusinessDeclaredCurrencyRepository {
  constructor(private readonly audit: Pick<BusinessAdministrationAuditRepository, 'recordWith'> = new BusinessAdministrationAuditRepository()) {}

  async declare(ctx: TenantContext, input: DeclareCurrencyInput): Promise<DeclareCurrencyResult> {
    const problems: string[] = [];
    if (!UUID.test(input.businessId)) problems.push('businessId must be a lowercase UUID');
    if (typeof input.currency !== 'string' || !DECLARED_CURRENCY_PATTERN.test(input.currency)) problems.push('currency must be exactly three uppercase letters (e.g. USD)');
    if (input.expectedVersion !== null && !(Number.isInteger(input.expectedVersion) && input.expectedVersion >= 1)) problems.push('expectedVersion must be null or a positive integer');
    if (input.reason !== undefined && (input.reason.trim().length === 0 || input.reason.length > DECLARED_CURRENCY_REASON_MAX_LENGTH)) problems.push(`reason must be 1-${DECLARED_CURRENCY_REASON_MAX_LENGTH} characters`);
    if (typeof input.permissionUsed !== 'string' || input.permissionUsed.trim().length === 0) problems.push('permissionUsed is required');
    if (!UUID.test(input.correlationId)) problems.push('correlationId must be a lowercase UUID');
    if (problems.length > 0) throw new DeclaredCurrencyValidationError(problems);

    return withTenantTransaction(ctx, async (client) => {
      // Lock the business row (tenant/workspace-scoped by RLS and the filter) so concurrent declarations serialise; unknown or
      // foreign business -> not found. The UNIQUE (business_id, version) constraint is the backstop.
      const biz = await client.query(
        `SELECT id FROM platform.businesses WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL FOR UPDATE`,
        [input.businessId, ctx.workspaceId],
      );
      if (biz.rows.length === 0) throw new BusinessNotFoundError('Business', input.businessId);

      const latest = await client.query<Record<string, unknown>>(
        `SELECT ${COLUMNS} FROM platform.business_currency_declarations
          WHERE tenant_id = $1 AND workspace_id = $2 AND business_id = $3 ORDER BY version DESC LIMIT 1`,
        [ctx.tenantId, ctx.workspaceId, input.businessId],
      );
      const current = latest.rows.length === 0 ? null : rowToRecord(latest.rows[0]);

      if (current === null) {
        if (input.expectedVersion !== null) {
          throw new DeclaredCurrencyConflictError(ENTITY, `expected version ${input.expectedVersion} but the business has no declared currency (UNDECLARED)`);
        }
      } else {
        // Exact replay of what is already declared: no new version, nothing written.
        if (current.currency === input.currency) return { outcome: 'UNCHANGED', record: current, previous: null };
        if (input.expectedVersion !== current.version) {
          throw new DeclaredCurrencyConflictError(ENTITY, `the declared currency is ${current.currency} at version ${current.version}; expected version ${input.expectedVersion ?? 'none'}`);
        }
        if (input.reason === undefined) throw new DeclaredCurrencyValidationError(['a reason is required to change an existing declaration']);
      }

      try {
        const inserted = await client.query<Record<string, unknown>>(
          `INSERT INTO platform.business_currency_declarations
             (tenant_id, workspace_id, business_id, version, declared_currency, supersedes_version, prior_declared_currency, provenance,
              declared_by_user_id, permission_used, reason, correlation_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'EXPLICIT_DECLARATION',$8,$9,$10,$11)
           RETURNING ${COLUMNS}`,
          [ctx.tenantId, ctx.workspaceId, input.businessId, current === null ? 1 : current.version + 1, input.currency,
            current === null ? null : current.version, current === null ? null : current.currency, ctx.userId, input.permissionUsed,
            input.reason ?? null, input.correlationId],
        );
        const record = rowToRecord(inserted.rows[0]);
        const outcome: DeclareCurrencyOutcome = current === null ? 'DECLARED' : 'CHANGED';
        await this.audit.recordWith(client, ctx, {
          action: outcome === 'DECLARED' ? DECLARED_CURRENCY_AUDIT_DECLARED : DECLARED_CURRENCY_AUDIT_CHANGED,
          entityType: DECLARED_CURRENCY_AUDIT_ENTITY,
          entityId: record.declarationId,
          businessId: input.businessId,
          correlationId: input.correlationId,
          metadata: {
            permissionUsed: input.permissionUsed,
            outcome,
            priorState: current === null ? 'UNDECLARED' : 'DECLARED',
            priorCurrency: current?.currency ?? null,
            priorVersion: current?.version ?? null,
            newCurrency: record.currency,
            newVersion: record.version,
            reason: input.reason ?? null,
            requestCorrelationId: (input.requestCorrelationId ?? input.correlationId).slice(0, 200),
          },
        });
        return { outcome, record, previous: current };
      } catch (err) {
        if (typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505'
          && (err as { constraint?: unknown }).constraint === 'business_currency_declarations_version_unique') {
          throw new DeclaredCurrencyConflictError(ENTITY, 'a concurrent declaration was recorded for this business');
        }
        throw err;
      }
    });
  }
}

/** Business Administration's append-only audit record (audit.audit_events, exists since 0006). */
export interface BusinessAdminAuditInput {
  /** Dotted verb, e.g. `business_admin.declared_currency.declared`. */
  action: string;
  entityType: string;
  entityId: string;
  businessId: string;
  correlationId: string;
  metadata: Record<string, unknown>;
}

export class BusinessAdministrationAuditRepository {
  /** Appends ONE audit row for the authenticated actor (`ctx.userId`) on the CALLER's transaction client, so it commits or rolls back with the caller's change. */
  async recordWith(client: PoolClient, ctx: TenantContext, input: BusinessAdminAuditInput): Promise<string> {
    if (!/^business_admin\.[a-z_]+\.[a-z_]+$/.test(input.action)) throw new DeclaredCurrencyValidationError(['audit action must look like business_admin.<object>.<verb>']);
    if (typeof input.metadata.permissionUsed !== 'string' || input.metadata.permissionUsed.length === 0) throw new DeclaredCurrencyValidationError(['audit metadata.permissionUsed is required']);
    const r = await client.query<{ id: string }>(
      `INSERT INTO audit.audit_events
         (tenant_id, workspace_id, business_id, actor_type, actor_id, action, entity_type, entity_id, metadata, correlation_id)
       VALUES ($1,$2,$3,'user',$4,$5,$6,$7,$8::jsonb,$9) RETURNING id`,
      [ctx.tenantId, ctx.workspaceId, input.businessId, ctx.userId, input.action, input.entityType, input.entityId, JSON.stringify(input.metadata), input.correlationId],
    );
    return r.rows[0].id;
  }
}
