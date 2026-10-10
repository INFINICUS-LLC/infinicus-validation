// P0-5 Block 3b - persistence access for the ABA-owned AuthorizedActionPackage (tables from migration 0176).
//
// This repository STORES and READS sealed packages and records lifecycle facts. It deliberately does not:
//   - decide whether a package may be issued (no decision / authority / freshness checks: that is the issuer, Block 3d),
//   - build, seal or validate a package (the pure `aap/1` contract lives in @infinicus/handoff-contracts; the issuer
//     validates with it before calling this repository, so persistence has no dependency on the contract package),
//   - emit events, call Business Operations, or write a BO receipt.
//
// The database (0176) is the second line of defence: it rejects a document that disagrees with its columns, an
// unapproved decision, a broken supersession chain, a second terminal fact, and any backdated lifecycle fact.
// Every method runs in a tenant transaction, so RLS confines it to the caller's tenant and workspace.

import type { PoolClient } from 'pg';
import type { TenantContext } from '../../client.js';
import { withTenantTransaction } from '../../client.js';
import { ConflictError, NotFoundError, ValidationError } from './errors.js';

/** Persisted lifecycle facts. EXECUTED is not a state; EXECUTABLE is derived by the BO validator, never stored. */
export const PACKAGE_LIFECYCLE_STATES = ['ISSUED', 'REVOKED', 'SUPERSEDED', 'EXPIRED', 'CONSUMED'] as const;
export type PackageLifecycleState = (typeof PACKAGE_LIFECYCLE_STATES)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const MS_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** Upper bound on a stored package document, so a faulty caller cannot write an unbounded row. */
export const MAX_PACKAGE_DOCUMENT_BYTES = 256 * 1024;
/** Same bound as the revocation reason elsewhere in ABA: a reason is a sentence, not a document. */
export const MAX_LIFECYCLE_REASON_LENGTH = 1000;

export interface PackageHeader {
  id: string;
  tenantId: string;
  workspaceId: string;
  businessId: string;
  actionId: string;
  decisionId: string;
}

export interface EnsureHeaderInput {
  businessId: string;
  actionId: string;
  decisionId: string;
}

export interface PackageVersionRecord {
  id: string;
  packageId: string;
  packageVersion: number;
  supersedesPackageVersion: number | null;
  actionVersionId: string;
  digest: string;
  automationLevel: 2 | 3 | 4;
  authorizationMode: 'HUMAN_APPROVAL' | 'RULE_AUTHORIZED';
  issuerComponent: string;
  issuedAt: string;
  expiresAt: string | null;
  correlationId: string;
  causationId: string;
  /** The sealed document exactly as stored. */
  document: Record<string, unknown>;
}

export interface PackageLifecycleEvent {
  id: string;
  packageId: string;
  packageVersion: number;
  state: PackageLifecycleState;
  occurredAt: string;
  actorType: 'user' | 'service' | 'system' | null;
  actorId: string | null;
  reason: string | null;
  correlationId: string;
  causationId: string | null;
  supersededByPackageVersion: number | null;
  consumptionReceiptId: string | null;
  auditEventId: string | null;
}

/**
 * What ABA answers immediately before execution (owner ruling R-10). Shape-compatible with the contract's
 * `AuthoritativePackageStatus`; defined here so persistence needs no dependency on the contract package.
 */
export interface AuthoritativePackageStatus {
  packageId: string;
  packageVersion: number;
  /** Echoed so the asker can prove the answer is about the exact package it holds. */
  digest: string;
  lifecycle: PackageLifecycleState;
  /** Highest package version that exists for this authorized action. */
  latestPackageVersion: number;
  /** Database time at which ABA answered (millisecond UTC). */
  verifiedAt: string;
}

export interface RevokeInput {
  actorUserId: string;
  reason: string;
  correlationId: string;
  causationId?: string | null;
  auditEventId?: string | null;
}

export type RecordExpiryResult =
  | { recorded: true; event: PackageLifecycleEvent }
  | { recorded: false; reason: 'NOT_DUE' | 'NOT_APPLICABLE' | 'ALREADY_TERMINAL' };

export interface RecordExpiryInput {
  correlationId: string;
  causationId?: string | null;
}

const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value));

function requireUuid(label: string, value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new ValidationError('AuthorizedActionPackage', [`${label} must be a lowercase UUID`]);
  return value;
}

function requireVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new ValidationError('AuthorizedActionPackage', ['package version must be an integer >= 1']);
  }
  return value;
}

function requireReason(reason: unknown): string {
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (text.length === 0) throw new ValidationError('AuthorizedActionPackage', ['a reason is required']);
  if (text.length > MAX_LIFECYCLE_REASON_LENGTH) {
    throw new ValidationError('AuthorizedActionPackage', [`the reason must be at most ${MAX_LIFECYCLE_REASON_LENGTH} characters`]);
  }
  return text;
}

type Json = Record<string, unknown>;

function at(root: unknown, path: readonly string[]): unknown {
  let cursor: unknown = root;
  for (const key of path) {
    if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Json)[key];
  }
  return cursor;
}

/**
 * Reads the queryable columns FROM the sealed document (the document is the single source of truth; nothing is passed
 * twice). Any missing or malformed field is a ValidationError before the database is touched. The database re-checks
 * every one of these against the stored document.
 */
export function columnsFromDocument(document: unknown): {
  packageId: string; packageVersion: number; supersedesPackageVersion: number | null; actionVersionId: string;
  digest: string; automationLevel: 2 | 3 | 4; authorizationMode: 'HUMAN_APPROVAL' | 'RULE_AUTHORIZED';
  issuerComponent: string; issuedAt: string; expiresAt: string | null; correlationId: string; causationId: string;
  tenantId: string; workspaceId: string; businessId: string;
} {
  const problems: string[] = [];
  const uuid = (label: string, path: readonly string[]): string => {
    const v = at(document, path);
    if (typeof v !== 'string' || !UUID.test(v)) { problems.push(`${label} must be a lowercase UUID`); return ''; }
    return v;
  };
  const text = (label: string, path: readonly string[]): string => {
    const v = at(document, path);
    if (typeof v !== 'string' || v.trim().length === 0) { problems.push(`${label} is required`); return ''; }
    return v;
  };
  const instant = (label: string, v: unknown): string => {
    if (typeof v !== 'string' || !MS_UTC.test(v)) { problems.push(`${label} must be a millisecond UTC timestamp`); return ''; }
    return v;
  };

  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    throw new ValidationError('AuthorizedActionPackage', ['the package document must be an object']);
  }
  const packageId = uuid('identity.packageId', ['identity', 'packageId']);
  const packageVersionRaw = at(document, ['identity', 'packageVersion']);
  const packageVersion = typeof packageVersionRaw === 'number' && Number.isInteger(packageVersionRaw) && packageVersionRaw >= 1 ? packageVersionRaw : 0;
  if (packageVersion === 0) problems.push('identity.packageVersion must be an integer >= 1');

  const supersedes = at(document, ['identity', 'supersedes']);
  let supersedesPackageVersion: number | null = null;
  if (supersedes !== null) {
    const sv = at(document, ['identity', 'supersedes', 'packageVersion']);
    if (typeof sv !== 'number' || !Number.isInteger(sv) || sv < 1) problems.push('identity.supersedes.packageVersion must be an integer >= 1');
    else supersedesPackageVersion = sv;
  }

  const level = at(document, ['action', 'automationLevel', 'level']);
  if (level !== 2 && level !== 3 && level !== 4) problems.push('action.automationLevel.level must be 2, 3 or 4');
  const mode = at(document, ['authorization', 'mode']);
  if (mode !== 'HUMAN_APPROVAL' && mode !== 'RULE_AUTHORIZED') problems.push('authorization.mode must be HUMAN_APPROVAL or RULE_AUTHORIZED');

  const digest = at(document, ['integrity', 'digest']);
  if (typeof digest !== 'string' || !DIGEST.test(digest)) problems.push('integrity.digest must be sha256:<64 lowercase hex>');

  const issuedAt = instant('issuance.issuedAt', at(document, ['issuance', 'issuedAt']));
  const expiry = at(document, ['validity', 'expiresAt']);
  let expiresAt: string | null = null;
  const expiryState = at(expiry, ['state']);
  if (expiryState === 'VALUE') expiresAt = instant('validity.expiresAt.value', at(expiry, ['value'])) || null;
  else if (expiryState !== 'NOT_APPLICABLE') problems.push('validity.expiresAt.state must be VALUE or NOT_APPLICABLE (UNAVAILABLE can never be stored)');

  const out = {
    packageId, packageVersion, supersedesPackageVersion,
    actionVersionId: uuid('action.actionVersionId', ['action', 'actionVersionId']),
    digest: typeof digest === 'string' ? digest : '',
    automationLevel: level as 2 | 3 | 4,
    authorizationMode: mode as 'HUMAN_APPROVAL' | 'RULE_AUTHORIZED',
    issuerComponent: text('issuance.issuerComponent', ['issuance', 'issuerComponent']),
    issuedAt, expiresAt,
    correlationId: uuid('trace.correlationId', ['trace', 'correlationId']),
    causationId: uuid('trace.causationId', ['trace', 'causationId']),
    tenantId: uuid('scope.tenantId', ['scope', 'tenantId']),
    workspaceId: uuid('scope.workspaceId', ['scope', 'workspaceId']),
    businessId: uuid('scope.businessId', ['scope', 'businessId']),
  };
  if (problems.length > 0) throw new ValidationError('AuthorizedActionPackage', problems);
  return out;
}

function rowToHeader(row: Json): PackageHeader {
  return {
    id: row.id as string, tenantId: row.tenant_id as string, workspaceId: row.workspace_id as string,
    businessId: row.business_id as string, actionId: row.action_id as string, decisionId: row.decision_id as string,
  };
}

function rowToVersion(row: Json): PackageVersionRecord {
  return {
    id: row.id as string, packageId: row.package_id as string, packageVersion: row.package_version as number,
    supersedesPackageVersion: (row.supersedes_package_version as number | null) ?? null,
    actionVersionId: row.action_version_id as string, digest: row.digest as string,
    automationLevel: row.automation_level as 2 | 3 | 4,
    authorizationMode: row.authorization_mode as 'HUMAN_APPROVAL' | 'RULE_AUTHORIZED',
    issuerComponent: row.issuer_component as string, issuedAt: iso(row.issued_at),
    expiresAt: row.expires_at === null ? null : iso(row.expires_at),
    correlationId: row.correlation_id as string, causationId: row.causation_id as string,
    document: row.package as Record<string, unknown>,
  };
}

function rowToEvent(row: Json): PackageLifecycleEvent {
  return {
    id: row.id as string, packageId: row.package_id as string, packageVersion: row.package_version as number,
    state: row.state as PackageLifecycleState, occurredAt: iso(row.occurred_at),
    actorType: (row.actor_type as PackageLifecycleEvent['actorType']) ?? null, actorId: (row.actor_id as string | null) ?? null,
    reason: (row.reason as string | null) ?? null, correlationId: row.correlation_id as string,
    causationId: (row.causation_id as string | null) ?? null,
    supersededByPackageVersion: (row.superseded_by_package_version as number | null) ?? null,
    consumptionReceiptId: (row.consumption_receipt_id as string | null) ?? null,
    auditEventId: (row.audit_event_id as string | null) ?? null,
  };
}

const SCHEMA = 'approved_business_action';
const HEADERS = `${SCHEMA}.authorized_action_packages`;
const VERSIONS = `${SCHEMA}.authorized_action_package_versions`;
const EVENTS = `${SCHEMA}.authorized_action_package_lifecycle_events`;

/** Serializes writers of one package so lifecycle checks and inserts cannot interleave (released at commit). */
async function lockPackage(client: PoolClient, packageId: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`authorized_action_package:${packageId}`]);
}

async function loadVersionRow(client: PoolClient, packageId: string, packageVersion: number): Promise<Json | null> {
  const result = await client.query<Json>(`SELECT * FROM ${VERSIONS} WHERE package_id = $1 AND package_version = $2`, [packageId, packageVersion]);
  return result.rows[0] ?? null;
}

async function loadTerminal(client: PoolClient, packageId: string, packageVersion: number): Promise<Json | null> {
  const result = await client.query<Json>(
    `SELECT * FROM ${EVENTS} WHERE package_id = $1 AND package_version = $2 AND state <> 'ISSUED'`, [packageId, packageVersion]);
  return result.rows[0] ?? null;
}

export class AuthorizedActionPackageRepository {
  /**
   * Creates the stable package identity for one authorized action, or returns the existing one. The id is what the
   * issuer puts in `identity.packageId` before sealing. The same action can never have two identities; asking again
   * with a different decision is a conflict, never a silent re-pointing.
   */
  async ensureHeader(ctx: TenantContext, input: EnsureHeaderInput): Promise<PackageHeader> {
    requireUuid('businessId', input.businessId);
    requireUuid('actionId', input.actionId);
    requireUuid('decisionId', input.decisionId);
    return withTenantTransaction(ctx, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`authorized_action_package_header:${input.actionId}`]);
      const existing = await client.query<Json>(`SELECT * FROM ${HEADERS} WHERE action_id = $1`, [input.actionId]);
      if (existing.rows[0]) {
        const header = rowToHeader(existing.rows[0]);
        if (header.decisionId !== input.decisionId || header.businessId !== input.businessId) {
          throw new ConflictError('AuthorizedActionPackage', 'the authorized action already has a package identity for a different decision or business');
        }
        return header;
      }
      const inserted = await client.query<Json>(
        `INSERT INTO ${HEADERS} (tenant_id, workspace_id, business_id, action_id, decision_id) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [ctx.tenantId, ctx.workspaceId, input.businessId, input.actionId, input.decisionId],
      );
      return rowToHeader(inserted.rows[0]);
    });
  }

  async getHeaderByActionId(ctx: TenantContext, actionId: string): Promise<PackageHeader | null> {
    requireUuid('actionId', actionId);
    return withTenantTransaction(ctx, async (client) => {
      const r = await client.query<Json>(`SELECT * FROM ${HEADERS} WHERE action_id = $1`, [actionId]);
      return r.rows[0] ? rowToHeader(r.rows[0]) : null;
    });
  }

  /**
   * Stores an already-sealed, already-validated package. Idempotent: replaying the identical package returns the stored
   * row; a different document for the same (package, version) is a ConflictError. The package must belong to the
   * caller's tenant and workspace; the database re-verifies the decision, lineage, columns, expiry and supersession.
   */
  async insertVersion(ctx: TenantContext, document: unknown): Promise<PackageVersionRecord> {
    const size = JSON.stringify(document ?? null).length;
    if (size > MAX_PACKAGE_DOCUMENT_BYTES) {
      throw new ValidationError('AuthorizedActionPackage', [`the package document exceeds ${MAX_PACKAGE_DOCUMENT_BYTES} bytes`]);
    }
    const c = columnsFromDocument(document);
    if (c.tenantId !== ctx.tenantId || c.workspaceId !== ctx.workspaceId) {
      throw new ValidationError('AuthorizedActionPackage', ['the package scope does not match the caller context']);
    }
    try {
      return await withTenantTransaction(ctx, async (client) => {
        await lockPackage(client, c.packageId);
        // Replay check first and under the package lock: the database guards (correctly) refuse to supersede a version that
        // already has a terminal fact, so an identical replay must be recognised before the insert is attempted.
        const existing = await loadVersionRow(client, c.packageId, c.packageVersion);
        if (existing) {
          if (existing.digest === c.digest) return rowToVersion(existing);
          throw new ConflictError('AuthorizedActionPackage', 'a different package is already stored for this package version');
        }
        const inserted = await client.query<Json>(
          `INSERT INTO ${VERSIONS}
             (tenant_id, workspace_id, business_id, package_id, package_version, supersedes_package_version, action_version_id,
              contract_version, canonical_version, digest_algorithm, digest, automation_level, authorization_mode,
              issuer_component, issued_at, expires_at, correlation_id, causation_id, package)
           VALUES ($1,$2,$3,$4,$5,$6,$7, $8,$9,$10,$11,$12,$13, $14,$15,$16,$17,$18,$19::jsonb)
           RETURNING *`,
          [
            c.tenantId, c.workspaceId, c.businessId, c.packageId, c.packageVersion, c.supersedesPackageVersion, c.actionVersionId,
            at(document, ['contractVersion']), at(document, ['integrity', 'canonicalVersion']), at(document, ['integrity', 'algorithm']),
            c.digest, c.automationLevel, c.authorizationMode, c.issuerComponent, c.issuedAt, c.expiresAt,
            c.correlationId, c.causationId, JSON.stringify(document),
          ],
        );
        return rowToVersion(inserted.rows[0]);
      });
    } catch (error) {
      // 23505 = unique_violation: the digest is already used by another stored package.
      if ((error as { code?: string }).code === '23505') {
        throw new ConflictError('AuthorizedActionPackage', 'the package digest is already in use');
      }
      throw error;
    }
  }

  async getVersion(ctx: TenantContext, packageId: string, packageVersion: number): Promise<PackageVersionRecord | null> {
    requireUuid('packageId', packageId);
    requireVersion(packageVersion);
    return withTenantTransaction(ctx, async (client) => {
      const row = await loadVersionRow(client, packageId, packageVersion);
      return row ? rowToVersion(row) : null;
    });
  }

  async getLatestVersion(ctx: TenantContext, packageId: string): Promise<PackageVersionRecord | null> {
    requireUuid('packageId', packageId);
    return withTenantTransaction(ctx, async (client) => {
      const r = await client.query<Json>(`SELECT * FROM ${VERSIONS} WHERE package_id = $1 ORDER BY package_version DESC LIMIT 1`, [packageId]);
      return r.rows[0] ? rowToVersion(r.rows[0]) : null;
    });
  }

  async listLifecycle(ctx: TenantContext, packageId: string, packageVersion: number): Promise<PackageLifecycleEvent[]> {
    requireUuid('packageId', packageId);
    requireVersion(packageVersion);
    return withTenantTransaction(ctx, async (client) => {
      const r = await client.query<Json>(
        `SELECT * FROM ${EVENTS} WHERE package_id = $1 AND package_version = $2 ORDER BY occurred_at, created_at, id`, [packageId, packageVersion]);
      return r.rows.map(rowToEvent);
    });
  }

  /**
   * The authoritative pre-execution status, derived (never stored) from the recorded terminal fact and the DATABASE
   * clock: a recorded terminal fact wins; otherwise a package past its expiry is EXPIRED even if no one has recorded
   * that yet; otherwise it is ISSUED. Returns null when the version does not exist in the caller's scope.
   */
  async getAuthoritativeStatus(ctx: TenantContext, packageId: string, packageVersion: number): Promise<AuthoritativePackageStatus | null> {
    requireUuid('packageId', packageId);
    requireVersion(packageVersion);
    return withTenantTransaction(ctx, async (client) => {
      const r = await client.query<Json>(
        `SELECT v.package_id, v.package_version, v.digest,
                (v.expires_at IS NOT NULL AND v.expires_at <= clock_timestamp()) AS past_expiry,
                (SELECT e.state FROM ${EVENTS} e
                  WHERE e.package_id = v.package_id AND e.package_version = v.package_version AND e.state <> 'ISSUED') AS terminal,
                (SELECT max(x.package_version) FROM ${VERSIONS} x WHERE x.package_id = v.package_id) AS latest,
                to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS verified_at
           FROM ${VERSIONS} v WHERE v.package_id = $1 AND v.package_version = $2`,
        [packageId, packageVersion],
      );
      const row = r.rows[0];
      if (!row) return null;
      const lifecycle: PackageLifecycleState = (row.terminal as PackageLifecycleState | null) ?? (row.past_expiry ? 'EXPIRED' : 'ISSUED');
      return {
        packageId: row.package_id as string, packageVersion: row.package_version as number, digest: row.digest as string,
        lifecycle, latestPackageVersion: row.latest as number, verifiedAt: row.verified_at as string,
      };
    });
  }

  /**
   * Revokes an ISSUED package. Explicit, attributable and reasoned; the sealed document is never touched. A package that
   * already has a terminal fact cannot be revoked (revoke-after-consume is a BO stop instruction, not a state change).
   */
  async revoke(ctx: TenantContext, packageId: string, packageVersion: number, input: RevokeInput): Promise<PackageLifecycleEvent> {
    requireUuid('packageId', packageId);
    requireVersion(packageVersion);
    requireUuid('correlationId', input.correlationId);
    if (typeof input.actorUserId !== 'string' || input.actorUserId.trim().length === 0) {
      throw new ValidationError('AuthorizedActionPackage', ['an actor is required to revoke']);
    }
    const reason = requireReason(input.reason);
    if (input.causationId != null) requireUuid('causationId', input.causationId);
    if (input.auditEventId != null) requireUuid('auditEventId', input.auditEventId);
    return withTenantTransaction(ctx, async (client) => {
      await lockPackage(client, packageId);
      const version = await loadVersionRow(client, packageId, packageVersion);
      if (!version) throw new NotFoundError('AuthorizedActionPackage', `${packageId}@${packageVersion}`);
      const terminal = await loadTerminal(client, packageId, packageVersion);
      if (terminal) throw new ConflictError('AuthorizedActionPackage', `the package version already has terminal state ${String(terminal.state)}`);
      const r = await client.query<Json>(
        `INSERT INTO ${EVENTS}
           (tenant_id, workspace_id, business_id, package_id, package_version, state, actor_type, actor_id, reason, correlation_id, causation_id, audit_event_id)
         VALUES ($1,$2,$3,$4,$5,'REVOKED','user',$6,$7,$8,$9,$10) RETURNING *`,
        [ctx.tenantId, ctx.workspaceId, version.business_id, packageId, packageVersion, input.actorUserId, reason,
          input.correlationId, input.causationId ?? null, input.auditEventId ?? null],
      );
      return rowToEvent(r.rows[0]);
    });
  }

  /**
   * Records EXPIRED once a package is past its stored expiry on the database clock. Idempotent and concurrency-safe
   * (same pattern as P0-4 `approval.expired`; no scheduler exists, so a caller detects it): a second call, or a call for a
   * package that is not yet due, records nothing.
   */
  async recordExpiryIfDue(ctx: TenantContext, packageId: string, packageVersion: number, input: RecordExpiryInput): Promise<RecordExpiryResult> {
    requireUuid('packageId', packageId);
    requireVersion(packageVersion);
    requireUuid('correlationId', input.correlationId);
    if (input.causationId != null) requireUuid('causationId', input.causationId);
    return withTenantTransaction(ctx, async (client) => {
      await lockPackage(client, packageId);
      const version = await loadVersionRow(client, packageId, packageVersion);
      if (!version) throw new NotFoundError('AuthorizedActionPackage', `${packageId}@${packageVersion}`);
      if (version.expires_at === null) return { recorded: false, reason: 'NOT_APPLICABLE' } as const;
      if (await loadTerminal(client, packageId, packageVersion)) return { recorded: false, reason: 'ALREADY_TERMINAL' } as const;
      const due = await client.query<{ due: boolean }>('SELECT ($1::timestamptz <= clock_timestamp()) AS due', [version.expires_at]);
      if (!due.rows[0].due) return { recorded: false, reason: 'NOT_DUE' } as const;
      const r = await client.query<Json>(
        `INSERT INTO ${EVENTS}
           (tenant_id, workspace_id, business_id, package_id, package_version, state, actor_type, actor_id, reason, correlation_id, causation_id)
         VALUES ($1,$2,$3,$4,$5,'EXPIRED','system','aba.package-expiry','package passed its stored expiry',$6,$7) RETURNING *`,
        [ctx.tenantId, ctx.workspaceId, version.business_id, packageId, packageVersion, input.correlationId, input.causationId ?? null],
      );
      return { recorded: true, event: rowToEvent(r.rows[0]) } as const;
    });
  }
}
