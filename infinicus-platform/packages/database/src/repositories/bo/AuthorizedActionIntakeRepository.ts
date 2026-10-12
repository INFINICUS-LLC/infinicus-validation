// P0-5 Block 3e - Business Operations persistence for the AuthorizedActionPackage intake boundary (tables from migration 0180).
//
// BO-OWNED storage only. It records an immutable receipt (verbatim sealed document + digest), the single-use claim and an
// append-only attempt log. It never reads or writes any Approved-Business-Action table, never mutates inventory, emits no event
// and produces no execution evidence. "Claimed" means BO atomically took this package version for ONE execution attempt - nothing
// was executed.
//
// The judgement of whether a package may be received or claimed is NOT made here: the caller supplies a synchronous `evaluate`
// callback that is run INSIDE the transaction, under the per-package lock, with the database clock. The repository adds only the
// storage rules: dedupe, payload-collision refusal, receipt-before-claim, and exactly one claim per package version.

import type { PoolClient } from 'pg';
import type { TenantContext } from '../../client.js';
import { withTenantTransaction } from '../../client.js';
import { ConflictError } from './errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const S = 'business_operations';
const ENTITY = 'AuthorizedActionIntake';
/** Upper bound on a stored package document, matching the table constraint. */
export const MAX_RECEIPT_DOCUMENT_BYTES = 256 * 1024;

export type IntakeOutcome = 'CLAIMED' | 'REPLAYED' | 'REFUSED';

/** The caller's in-transaction verdict. `refusals` empty + `identityVerified` = the package may be claimed. */
export interface IntakeEvaluation {
  /** The authoritative status confirmed this exact package (id, version, digest). Only then is a receipt written. */
  identityVerified: boolean;
  /** Refusal codes. Non-empty = no claim (a receipt may still be written when the identity is verified). */
  refusalCodes: readonly string[];
  /** ABA database time (millisecond UTC) of the status answer the verdict relied on. */
  statusVerifiedAt: string;
}

export interface IntakeRequest {
  businessId: string;
  /** The sealed package exactly as received. */
  document: unknown;
  correlationId: string;
  /** Pure and synchronous: run under the lock with the database clock (millisecond UTC). */
  evaluate: (databaseNow: string) => IntakeEvaluation;
  /**
   * Runs ONLY when this call created the claim, on the SAME transaction client, after the claim and its attempt row are written. Whatever it
   * writes commits or rolls back with the claim (P0-6g: the durable recovery signal of the claim); a throw rolls the claim back too, so a claim
   * never exists without it. Never called for a replay or a refusal.
   */
  onClaimed?: (client: PoolClient, claim: { claimId: string; receiptId: string; claimedAt: string }) => Promise<void>;
}

export interface IntakeResult {
  outcome: IntakeOutcome;
  receiptId: string | null;
  claimId: string | null;
  claimedAt: string | null;
  refusalCodes: string[];
  /** Database time the evaluation ran at. */
  evaluatedAt: string;
}

export interface AuthorizedActionReceipt {
  id: string;
  tenantId: string;
  workspaceId: string;
  businessId: string;
  packageId: string;
  packageVersion: number;
  contractVersion: string;
  canonicalVersion: string;
  digestAlgorithm: string;
  digest: string;
  document: Record<string, unknown>;
  receivedAt: string;
  validatedAt: string;
  statusVerifiedAt: string;
  correlationId: string;
}

export interface AuthorizedActionClaim {
  id: string;
  receiptId: string;
  tenantId: string;
  workspaceId: string;
  businessId: string;
  packageId: string;
  packageVersion: number;
  digest: string;
  claimedAt: string;
  statusVerifiedAt: string;
  correlationId: string;
}

export interface IntakeAttemptInput {
  businessId: string;
  packageId: string | null;
  packageVersion: number | null;
  digest: string | null;
  outcome: IntakeOutcome;
  receiptId: string | null;
  refusalCodes: readonly string[];
  correlationId: string;
}

type Json = Record<string, unknown>;
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

function at(root: unknown, path: readonly string[]): unknown {
  let cursor: unknown = root;
  for (const key of path) {
    if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Json)[key];
  }
  return cursor;
}

/** The identity fields every stored document must carry. A malformed one is refused before the database is touched. */
function identityOf(document: unknown): { packageId: string; packageVersion: number; digest: string; contractVersion: string; canonicalVersion: string; digestAlgorithm: string; tenantId: string; workspaceId: string; businessId: string } {
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
  const version = at(document, ['identity', 'packageVersion']);
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) problems.push('identity.packageVersion must be an integer >= 1');
  const digest = at(document, ['integrity', 'digest']);
  if (typeof digest !== 'string' || !DIGEST.test(digest)) problems.push('integrity.digest must be sha256:<64 lowercase hex>');
  const out = {
    packageId: uuid('identity.packageId', ['identity', 'packageId']),
    packageVersion: typeof version === 'number' ? version : 0,
    digest: typeof digest === 'string' ? digest : '',
    contractVersion: text('contractVersion', ['contractVersion']),
    canonicalVersion: text('integrity.canonicalVersion', ['integrity', 'canonicalVersion']),
    digestAlgorithm: text('integrity.algorithm', ['integrity', 'algorithm']),
    tenantId: uuid('scope.tenantId', ['scope', 'tenantId']),
    workspaceId: uuid('scope.workspaceId', ['scope', 'workspaceId']),
    businessId: uuid('scope.businessId', ['scope', 'businessId']),
  };
  if (problems.length > 0) throw new ConflictError(ENTITY, `malformed package document: ${problems.join('; ')}`);
  return out;
}

function rowToReceipt(row: Json): AuthorizedActionReceipt {
  return {
    id: row.id as string, tenantId: row.tenant_id as string, workspaceId: row.workspace_id as string, businessId: row.business_id as string,
    packageId: row.package_id as string, packageVersion: row.package_version as number, contractVersion: row.contract_version as string,
    canonicalVersion: row.canonical_version as string, digestAlgorithm: row.digest_algorithm as string, digest: row.digest as string,
    document: row.package as Record<string, unknown>, receivedAt: iso(row.received_at), validatedAt: iso(row.validated_at),
    statusVerifiedAt: iso(row.status_verified_at), correlationId: row.correlation_id as string,
  };
}

function rowToClaim(row: Json): AuthorizedActionClaim {
  return {
    id: row.id as string, receiptId: row.receipt_id as string, tenantId: row.tenant_id as string, workspaceId: row.workspace_id as string,
    businessId: row.business_id as string, packageId: row.package_id as string, packageVersion: row.package_version as number,
    digest: row.digest as string, claimedAt: iso(row.claimed_at), statusVerifiedAt: iso(row.status_verified_at), correlationId: row.correlation_id as string,
  };
}

async function insertAttempt(client: PoolClient, ctx: TenantContext, a: IntakeAttemptInput): Promise<void> {
  await client.query(
    `INSERT INTO ${S}.authorized_action_intake_attempts
       (tenant_id, workspace_id, business_id, package_id, package_version, digest, outcome, receipt_id, refusal_codes, correlation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::text[],$10)`,
    [ctx.tenantId, ctx.workspaceId, a.businessId, a.packageId, a.packageVersion, a.digest, a.outcome, a.receiptId, [...a.refusalCodes], a.correlationId],
  );
}

export class AuthorizedActionIntakeRepository {
  /**
   * The atomic intake unit. In ONE tenant transaction, under a per-(package, version) advisory lock and with the database clock:
   * dedupe -> evaluate -> receipt (only when the identity is verified) -> claim (only when nothing refuses) -> attempt record.
   *  - exact replay (same digest, already claimed): returns the existing claim, writes nothing but an attempt row;
   *  - same package id + version, different digest: ConflictError (hard refusal; nothing is written);
   *  - concurrent callers serialize on the lock, so exactly one claim exists and every other caller sees REPLAYED.
   */
  async receiveAndClaim(ctx: TenantContext, request: IntakeRequest): Promise<IntakeResult> {
    if (!UUID.test(request.businessId)) throw new ConflictError(ENTITY, 'businessId must be a lowercase UUID');
    if (!UUID.test(request.correlationId)) throw new ConflictError(ENTITY, 'correlationId must be a lowercase UUID');
    if (JSON.stringify(request.document ?? null).length > MAX_RECEIPT_DOCUMENT_BYTES) throw new ConflictError(ENTITY, 'package document is too large');
    const id = identityOf(request.document);
    if (id.tenantId !== ctx.tenantId || id.workspaceId !== ctx.workspaceId || id.businessId !== request.businessId) {
      throw new ConflictError(ENTITY, 'the package scope does not match the caller context');
    }

    return withTenantTransaction(ctx, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`bo_authorized_action_intake:${id.packageId}:${id.packageVersion}`]);
      const clock = await client.query<{ now: string }>(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`);
      const now = clock.rows[0].now;
      const attempt = (over: Partial<IntakeAttemptInput> & Pick<IntakeAttemptInput, 'outcome'>): IntakeAttemptInput => ({
        businessId: request.businessId, packageId: id.packageId, packageVersion: id.packageVersion, digest: id.digest,
        receiptId: null, refusalCodes: [], correlationId: request.correlationId, ...over,
      });

      const existing = await client.query<Json>(`SELECT * FROM ${S}.authorized_action_receipts WHERE package_id = $1 AND package_version = $2`, [id.packageId, id.packageVersion]);
      const receiptRow = existing.rows[0] as Json | undefined;
      if (receiptRow && receiptRow.digest !== id.digest) {
        throw new ConflictError(ENTITY, 'a different package is already received for this package id and version');
      }
      if (receiptRow) {
        const claimed = await client.query<Json>(`SELECT * FROM ${S}.authorized_action_claims WHERE package_id = $1 AND package_version = $2`, [id.packageId, id.packageVersion]);
        if (claimed.rows[0]) {
          await insertAttempt(client, ctx, attempt({ outcome: 'REPLAYED', receiptId: receiptRow.id as string }));
          return { outcome: 'REPLAYED', receiptId: receiptRow.id as string, claimId: claimed.rows[0].id as string, claimedAt: iso(claimed.rows[0].claimed_at), refusalCodes: [], evaluatedAt: now };
        }
      }

      const verdict = request.evaluate(now);
      let receiptId = (receiptRow?.id as string | undefined) ?? null;
      if (!verdict.identityVerified) {
        const codes = verdict.refusalCodes.length > 0 ? [...verdict.refusalCodes] : ['IDENTITY_NOT_VERIFIED'];
        await insertAttempt(client, ctx, attempt({ outcome: 'REFUSED', refusalCodes: codes, receiptId }));
        return { outcome: 'REFUSED', receiptId, claimId: null, claimedAt: null, refusalCodes: codes, evaluatedAt: now };
      }

      if (receiptId === null) {
        const inserted = await client.query<Json>(
          `INSERT INTO ${S}.authorized_action_receipts
             (tenant_id, workspace_id, business_id, package_id, package_version, contract_version, canonical_version, digest_algorithm, digest,
              package, validated_at, status_verified_at, correlation_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13) RETURNING id`,
          [ctx.tenantId, ctx.workspaceId, request.businessId, id.packageId, id.packageVersion, id.contractVersion, id.canonicalVersion, id.digestAlgorithm,
            id.digest, JSON.stringify(request.document), now, verdict.statusVerifiedAt, request.correlationId],
        );
        receiptId = inserted.rows[0].id as string;
      }

      if (verdict.refusalCodes.length > 0) {
        await insertAttempt(client, ctx, attempt({ outcome: 'REFUSED', refusalCodes: [...verdict.refusalCodes], receiptId }));
        return { outcome: 'REFUSED', receiptId, claimId: null, claimedAt: null, refusalCodes: [...verdict.refusalCodes], evaluatedAt: now };
      }

      const claim = await client.query<Json>(
        `INSERT INTO ${S}.authorized_action_claims
           (tenant_id, workspace_id, business_id, receipt_id, package_id, package_version, digest, status_verified_at, correlation_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, claimed_at`,
        [ctx.tenantId, ctx.workspaceId, request.businessId, receiptId, id.packageId, id.packageVersion, id.digest, verdict.statusVerifiedAt, request.correlationId],
      );
      await insertAttempt(client, ctx, attempt({ outcome: 'CLAIMED', receiptId }));
      const claimId = claim.rows[0].id as string;
      const claimedAt = iso(claim.rows[0].claimed_at);
      if (request.onClaimed) await request.onClaimed(client, { claimId, receiptId, claimedAt });
      return { outcome: 'CLAIMED', receiptId, claimId, claimedAt, refusalCodes: [], evaluatedAt: now };
    });
  }

  /** Appends one attempt row in its own transaction (for refusals decided before the atomic unit, e.g. a malformed package). */
  async recordAttempt(ctx: TenantContext, attempt: IntakeAttemptInput): Promise<void> {
    if (!UUID.test(attempt.businessId)) throw new ConflictError(ENTITY, 'businessId must be a lowercase UUID');
    return withTenantTransaction(ctx, async (client) => insertAttempt(client, ctx, attempt));
  }

  async getReceipt(ctx: TenantContext, packageId: string, packageVersion: number): Promise<AuthorizedActionReceipt | null> {
    return withTenantTransaction(ctx, async (client) => {
      const r = await client.query<Json>(`SELECT * FROM ${S}.authorized_action_receipts WHERE package_id = $1 AND package_version = $2`, [packageId, packageVersion]);
      return r.rows[0] ? rowToReceipt(r.rows[0]) : null;
    });
  }

  async getClaim(ctx: TenantContext, packageId: string, packageVersion: number): Promise<AuthorizedActionClaim | null> {
    return withTenantTransaction(ctx, async (client) => {
      const r = await client.query<Json>(`SELECT * FROM ${S}.authorized_action_claims WHERE package_id = $1 AND package_version = $2`, [packageId, packageVersion]);
      return r.rows[0] ? rowToClaim(r.rows[0]) : null;
    });
  }
}
