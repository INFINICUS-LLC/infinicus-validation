// P0-6c - Business Operations persistence for authorized-action EXECUTION facts (tables from migration 0191).
//
// BO-OWNED storage only: it never reads or writes an Approved-Business-Action table and never judges anything. The engine
// (business-operations-runtime) decides; this repository stores, under the caller's transaction client, what the engine decided:
// one terminal execution row per claim and the append-only log of non-terminal attempts. Time is the DATABASE clock.
// The balance mutation itself is NOT here: the single BO operational writer (OperationalCommandExecutor) performs it.

import type { PoolClient } from 'pg';
import type { TenantContext } from '../../client.js';
import { withTenantTransaction } from '../../client.js';

const S = 'business_operations';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Json = Record<string, unknown>;
export type ExecutionOutcome = 'SUCCEEDED' | 'FAILED' | 'REFUSED';
export type MutationResult = 'APPLIED' | 'NO_CHANGE' | 'NOT_APPLICABLE';
export type AuthorityVerdictRecord = 'CURRENT' | 'REVOKED' | 'UNVERIFIABLE' | 'NOT_CHECKED';
export type AttemptOutcome = 'RETRYABLE_REFUSAL' | 'RETRYABLE_FAILURE';

/** A claim with BO's immutable copy of the sealed package, as the engine needs it. */
export interface ClaimForExecution {
  claimId: string;
  receiptId: string;
  tenantId: string;
  workspaceId: string;
  businessId: string;
  packageId: string;
  packageVersion: number;
  digest: string;
  claimedAt: string;
  correlationId: string;
  document: Record<string, unknown>;
}

/** Narrowing of the awaiting-claims list to one business and/or one action type. */
export interface ClaimAwaitingFilter {
  businessId?: string;
  actionType?: { code: string; schemaVersion: string };
}

/** A claim's identity and whether it already has a terminal execution: the recovery signal's read (no package body, no lock, no write). */
export interface ClaimState {
  claimId: string;
  tenantId: string;
  workspaceId: string;
  businessId: string;
  packageId: string;
  packageVersion: number;
  digest: string;
  /** The terminal execution row's outcome, or null while the claim has none. */
  terminalOutcome: ExecutionOutcome | null;
}

export interface ExecutionRecord {
  id: string;
  tenantId: string;
  workspaceId: string;
  claimId: string;
  receiptId: string;
  businessId: string;
  packageId: string;
  packageVersion: number;
  digest: string;
  actionType: { code: string; schemaVersion: string };
  target: { kind: string; id: string };
  outcome: ExecutionOutcome;
  reasonCode: string | null;
  detail: string | null;
  mutationResult: MutationResult;
  balanceId: string | null;
  beforeState: Json | null;
  requestedState: Json | null;
  afterState: Json | null;
  authorityVerdict: AuthorityVerdictRecord;
  statusVerifiedAt: string | null;
  attemptCount: number;
  claimedAt: string;
  executionStartedAt: string;
  executionCompletedAt: string;
  recordedAt: string;
  evidence: Json;
  evidenceDigest: string;
  correlationId: string;
}

export interface InsertExecutionInput {
  /** The execution id (the evidence document names it, so the engine assigns it before sealing). */
  id?: string;
  claim: ClaimForExecution;
  actionType: { code: string; schemaVersion: string };
  target: { kind: string; id: string };
  outcome: ExecutionOutcome;
  reasonCode: string | null;
  detail: string | null;
  mutationResult: MutationResult;
  balanceId: string | null;
  beforeState: Json | null;
  requestedState: Json | null;
  afterState: Json | null;
  preconditions: Json | null;
  authorityVerdict: AuthorityVerdictRecord;
  statusVerifiedAt: string | null;
  authorityVerifiedAt: string | null;
  statusAnswerDigest: string | null;
  providerComponent: string | null;
  attemptCount: number;
  executionStartedAt: string;
  evidence: Json;
  evidenceDigest: string;
  correlationId: string;
  causationId: string | null;
}

export interface InsertAttemptInput {
  claim: Pick<ClaimForExecution, 'claimId' | 'tenantId' | 'workspaceId' | 'businessId'>;
  attemptNumber: number;
  outcome: AttemptOutcome;
  reasonCode: string;
  detail: string | null;
  authorityVerdict: 'CURRENT' | 'REVOKED' | 'UNVERIFIABLE' | null;
  statusVerifiedAt: string | null;
  correlationId: string;
}

export interface AttemptSummary {
  attempts: number;
  lastAttemptedAt: string | null;
}

export interface ClaimAwaitingExecution {
  claimId: string;
  businessId: string;
  claimedAt: string;
  attempts: number;
  lastAttemptedAt: string | null;
}

/** One claim in a business that has no terminal execution row yet (read-only health view; carries no package body). */
export interface OpenClaimHealthRow {
  claimId: string;
  claimedAt: string;
  attempts: number;
  lastAttemptedAt: string | null;
  lastAttemptReasonCode: string | null;
  actionType: { code: string; schemaVersion: string } | null;
}

/** Terminal execution counts for a business, grouped by outcome and reason code. */
export interface TerminalHealthRow {
  outcome: ExecutionOutcome;
  reasonCode: string | null;
  total: number;
  /** Rows recorded within the window passed to the snapshot. */
  inWindow: number;
  latestRecordedAt: string;
}

/** Raw, unclassified facts for the execution-health view. Thresholds are application policy and are applied by the caller, not here. */
export interface ExecutionHealthSnapshot {
  /** The database clock when the snapshot was read. */
  databaseNow: string;
  openClaimTotal: number;
  /** Oldest first, bounded. */
  openClaims: OpenClaimHealthRow[];
  terminal: TerminalHealthRow[];
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const isoOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : iso(v));

function rowToExecution(r: Json): ExecutionRecord {
  return {
    id: r.id as string, tenantId: r.tenant_id as string, workspaceId: r.workspace_id as string, claimId: r.claim_id as string, receiptId: r.receipt_id as string,
    businessId: r.business_id as string, packageId: r.package_id as string, packageVersion: r.package_version as number, digest: r.digest as string,
    actionType: { code: r.action_type_code as string, schemaVersion: r.action_type_schema_version as string },
    target: { kind: r.target_kind as string, id: r.target_id as string },
    outcome: r.outcome as ExecutionOutcome, reasonCode: (r.reason_code as string | null) ?? null, detail: (r.detail as string | null) ?? null,
    mutationResult: r.mutation_result as MutationResult, balanceId: (r.balance_id as string | null) ?? null,
    beforeState: (r.before_state as Json | null) ?? null, requestedState: (r.requested_state as Json | null) ?? null, afterState: (r.after_state as Json | null) ?? null,
    authorityVerdict: r.authority_verdict as AuthorityVerdictRecord, statusVerifiedAt: isoOrNull(r.status_verified_at), attemptCount: r.attempt_count as number,
    claimedAt: iso(r.claimed_at), executionStartedAt: iso(r.execution_started_at), executionCompletedAt: iso(r.execution_completed_at), recordedAt: iso(r.recorded_at),
    evidence: r.evidence as Json, evidenceDigest: r.evidence_digest as string, correlationId: r.correlation_id as string,
  };
}

export class AuthorizedActionExecutionRepository {
  /** Serializes everything that can decide the fate of one claim (the engine's first statement in its transaction). */
  async lockClaim(client: PoolClient, claimId: string): Promise<void> {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`bo_authorized_action_execution:${claimId}`]);
  }

  /** Database time (millisecond UTC) at this instant: the only clock the engine judges with. */
  async databaseNow(client: PoolClient): Promise<string> {
    const r = await client.query<{ now: string }>(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`);
    return r.rows[0].now;
  }

  /** The transaction's start (millisecond UTC): the execution start time recorded in the evidence. */
  async transactionStart(client: PoolClient): Promise<string> {
    const r = await client.query<{ now: string }>(`SELECT to_char(date_trunc('milliseconds', transaction_timestamp()) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`);
    return r.rows[0].now;
  }

  async loadClaim(client: PoolClient, claimId: string): Promise<ClaimForExecution | null> {
    if (!UUID.test(claimId)) return null;
    const r = await client.query<Json>(
      `SELECT c.id AS claim_id, c.receipt_id, c.tenant_id, c.workspace_id, c.business_id, c.package_id, c.package_version, c.digest,
              to_char(date_trunc('milliseconds', c.claimed_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS claimed_at,
              c.correlation_id, r.package AS document
         FROM ${S}.authorized_action_claims c JOIN ${S}.authorized_action_receipts r ON r.id = c.receipt_id
        WHERE c.id = $1`,
      [claimId],
    );
    const x = r.rows[0];
    if (!x) return null;
    return {
      claimId: x.claim_id as string, receiptId: x.receipt_id as string, tenantId: x.tenant_id as string, workspaceId: x.workspace_id as string,
      businessId: x.business_id as string, packageId: x.package_id as string, packageVersion: x.package_version as number, digest: x.digest as string,
      claimedAt: x.claimed_at as string, correlationId: x.correlation_id as string, document: x.document as Record<string, unknown>,
    };
  }

  async getExecutionByClaim(client: PoolClient, claimId: string): Promise<ExecutionRecord | null> {
    const r = await client.query<Json>(`SELECT * FROM ${S}.authorized_action_executions WHERE claim_id = $1`, [claimId]);
    return r.rows[0] ? rowToExecution(r.rows[0]) : null;
  }

  async attemptSummary(client: PoolClient, claimId: string): Promise<AttemptSummary> {
    const r = await client.query<Json>(`SELECT count(*)::int AS n, max(attempted_at) AS last FROM ${S}.authorized_action_execution_attempts WHERE claim_id = $1`, [claimId]);
    return { attempts: r.rows[0].n as number, lastAttemptedAt: isoOrNull(r.rows[0].last) };
  }

  async insertAttempt(client: PoolClient, ctx: TenantContext, a: InsertAttemptInput): Promise<void> {
    await client.query(
      `INSERT INTO ${S}.authorized_action_execution_attempts
         (tenant_id, workspace_id, business_id, claim_id, attempt_number, outcome, reason_code, detail, authority_verdict, status_verified_at, correlation_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [ctx.tenantId, ctx.workspaceId, a.claim.businessId, a.claim.claimId, a.attemptNumber, a.outcome, a.reasonCode, a.detail, a.authorityVerdict, a.statusVerifiedAt, a.correlationId],
    );
  }

  async insertExecution(client: PoolClient, ctx: TenantContext, x: InsertExecutionInput): Promise<ExecutionRecord> {
    const c = x.claim;
    const r = await client.query<Json>(
      `INSERT INTO ${S}.authorized_action_executions
         (id, tenant_id, workspace_id, business_id, claim_id, receipt_id, package_id, package_version, digest, action_type_code, action_type_schema_version,
          target_kind, target_id, outcome, reason_code, detail, mutation_result, balance_id, before_state, requested_state, after_state, preconditions,
          authority_verdict, status_verified_at, authority_verified_at, status_answer_digest, provider_component, attempt_count,
          claimed_at, execution_started_at, execution_completed_at, evidence, evidence_digest, correlation_id, causation_id)
       VALUES (coalesce($34::uuid, gen_random_uuid()),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19::jsonb,$20::jsonb,$21::jsonb,
               $22,$23,$24,$25,$26,$27,$28,$29,clock_timestamp(),$30::jsonb,$31,$32,$33)
       RETURNING *`,
      [
        ctx.tenantId, ctx.workspaceId, c.businessId, c.claimId, c.receiptId, c.packageId, c.packageVersion, c.digest, x.actionType.code, x.actionType.schemaVersion,
        x.target.kind, x.target.id, x.outcome, x.reasonCode, x.detail, x.mutationResult, x.balanceId,
        x.beforeState === null ? null : JSON.stringify(x.beforeState), x.requestedState === null ? null : JSON.stringify(x.requestedState),
        x.afterState === null ? null : JSON.stringify(x.afterState), x.preconditions === null ? null : JSON.stringify(x.preconditions),
        x.authorityVerdict, x.statusVerifiedAt, x.authorityVerifiedAt, x.statusAnswerDigest, x.providerComponent, x.attemptCount,
        c.claimedAt, x.executionStartedAt, JSON.stringify(x.evidence), x.evidenceDigest, x.correlationId, x.causationId, x.id ?? null,
      ],
    );
    return rowToExecution(r.rows[0]);
  }

  /** Writes the platform audit row for an execution outcome on the SAME client (one record, no second source of truth). */
  async recordAudit(client: PoolClient, ctx: TenantContext, a: { businessId: string; action: string; entityId: string; correlationId: string; metadata: Json }): Promise<void> {
    await client.query(
      `INSERT INTO audit.audit_events
         (tenant_id, workspace_id, business_id, actor_type, actor_id, action, entity_type, entity_id, metadata, correlation_id)
       VALUES ($1,$2,$3,'system',$4,$5,'authorized_action_claim',$6,$7::jsonb,$8)`,
      [ctx.tenantId, ctx.workspaceId, a.businessId, ctx.userId, a.action, a.entityId, JSON.stringify(a.metadata), a.correlationId],
    );
  }

  async getByClaim(ctx: TenantContext, claimId: string): Promise<ExecutionRecord | null> {
    return withTenantTransaction(ctx, (client) => this.getExecutionByClaim(client, claimId));
  }

  /** A claim's identity and terminal state within the caller's scope (RLS). Null when the claim does not exist there. */
  async getClaimState(ctx: TenantContext, claimId: string): Promise<ClaimState | null> {
    if (!UUID.test(claimId)) return null;
    return withTenantTransaction(ctx, async (client) => {
      const r = await client.query<Json>(
        `SELECT c.id, c.tenant_id, c.workspace_id, c.business_id, c.package_id, c.package_version, c.digest, e.outcome
           FROM ${S}.authorized_action_claims c LEFT JOIN ${S}.authorized_action_executions e ON e.claim_id = c.id
          WHERE c.id = $1`,
        [claimId],
      );
      const x = r.rows[0];
      if (!x) return null;
      return {
        claimId: x.id as string, tenantId: x.tenant_id as string, workspaceId: x.workspace_id as string, businessId: x.business_id as string,
        packageId: x.package_id as string, packageVersion: x.package_version as number, digest: x.digest as string, terminalOutcome: (x.outcome as ExecutionOutcome | null) ?? null,
      };
    });
  }

  /** An execution fact by id, within the caller's scope (RLS). Null when it does not exist there. */
  async getById(ctx: TenantContext, executionId: string): Promise<ExecutionRecord | null> {
    if (!UUID.test(executionId)) return null;
    return withTenantTransaction(ctx, async (client) => {
      const r = await client.query<Json>(`SELECT * FROM ${S}.authorized_action_executions WHERE id = $1`, [executionId]);
      return r.rows[0] ? rowToExecution(r.rows[0]) : null;
    });
  }

  async getByPackage(ctx: TenantContext, packageId: string, packageVersion: number): Promise<ExecutionRecord | null> {
    return withTenantTransaction(ctx, async (client) => {
      const r = await client.query<Json>(`SELECT * FROM ${S}.authorized_action_executions WHERE package_id = $1 AND package_version = $2`, [packageId, packageVersion]);
      return r.rows[0] ? rowToExecution(r.rows[0]) : null;
    });
  }

  /**
   * Claims in this scope that have no terminal execution row yet (the recovery runner's work list), oldest first. The optional filter narrows
   * the list to ONE business and/or ONE action type (P0-6h operator recovery); without it the whole caller scope is listed, as before.
   */
  async claimsAwaitingExecution(ctx: TenantContext, limit: number, filter: ClaimAwaitingFilter = {}): Promise<ClaimAwaitingExecution[]> {
    const bounded = Math.max(1, Math.min(200, Math.trunc(limit)));
    if (filter.businessId !== undefined && !UUID.test(filter.businessId)) return [];
    return withTenantTransaction(ctx, async (client) => {
      const r = await client.query<Json>(
        `SELECT c.id, c.business_id,
                to_char(date_trunc('milliseconds', c.claimed_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS claimed_at,
                (SELECT count(*)::int FROM ${S}.authorized_action_execution_attempts a WHERE a.claim_id = c.id) AS attempts,
                (SELECT max(a.attempted_at) FROM ${S}.authorized_action_execution_attempts a WHERE a.claim_id = c.id) AS last_attempted_at
           FROM ${S}.authorized_action_claims c JOIN ${S}.authorized_action_receipts r ON r.id = c.receipt_id
          WHERE NOT EXISTS (SELECT 1 FROM ${S}.authorized_action_executions e WHERE e.claim_id = c.id)
            AND ($2::uuid IS NULL OR c.business_id = $2::uuid)
            AND ($3::text IS NULL OR (r.package #>> '{action,type,code}' = $3::text AND r.package #>> '{action,type,schemaVersion}' = $4::text))
          ORDER BY c.claimed_at ASC LIMIT $1`,
        [bounded, filter.businessId ?? null, filter.actionType?.code ?? null, filter.actionType?.schemaVersion ?? null],
      );
      return r.rows.map((x) => ({ claimId: x.id as string, businessId: x.business_id as string, claimedAt: x.claimed_at as string, attempts: x.attempts as number, lastAttemptedAt: isoOrNull(x.last_attempted_at) }));
    });
  }

  /**
   * Read-only facts about the authorized-action claims of ONE business (RLS-scoped to the caller): claims that have no terminal execution yet
   * (with their attempt state) and terminal outcomes grouped by reason. No lock, no write, no package body. The caller classifies; nothing about
   * "stranded" or "due" is decided here.
   */
  async executionHealthSnapshot(ctx: TenantContext, businessId: string, opts: { openLimit: number; windowSeconds: number }): Promise<ExecutionHealthSnapshot> {
    const limit = Math.max(1, Math.min(200, Math.trunc(opts.openLimit)));
    const windowSeconds = Math.max(1, Math.trunc(opts.windowSeconds));
    if (!UUID.test(businessId)) return { databaseNow: new Date().toISOString(), openClaimTotal: 0, openClaims: [], terminal: [] };
    return withTenantTransaction(ctx, async (client) => {
      const now = await client.query<Json>(`SELECT to_char(date_trunc('milliseconds', clock_timestamp()) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`);
      const open = await client.query<Json>(
        `SELECT c.id,
                to_char(date_trunc('milliseconds', c.claimed_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS claimed_at,
                (SELECT count(*)::int FROM ${S}.authorized_action_execution_attempts a WHERE a.claim_id = c.id) AS attempts,
                to_char(date_trunc('milliseconds', (SELECT max(a.attempted_at) FROM ${S}.authorized_action_execution_attempts a WHERE a.claim_id = c.id)) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_attempted_at,
                (SELECT a.reason_code FROM ${S}.authorized_action_execution_attempts a WHERE a.claim_id = c.id ORDER BY a.attempt_number DESC LIMIT 1) AS last_reason,
                r.package #>> '{action,type,code}' AS action_code, r.package #>> '{action,type,schemaVersion}' AS action_version,
                count(*) OVER ()::int AS total
           FROM ${S}.authorized_action_claims c JOIN ${S}.authorized_action_receipts r ON r.id = c.receipt_id
          WHERE c.business_id = $1 AND NOT EXISTS (SELECT 1 FROM ${S}.authorized_action_executions e WHERE e.claim_id = c.id)
          ORDER BY c.claimed_at ASC LIMIT $2`,
        [businessId, limit],
      );
      const term = await client.query<Json>(
        `SELECT outcome, reason_code, count(*)::int AS total,
                count(*) FILTER (WHERE recorded_at >= clock_timestamp() - make_interval(secs => $2))::int AS in_window,
                to_char(date_trunc('milliseconds', max(recorded_at)) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS latest
           FROM ${S}.authorized_action_executions WHERE business_id = $1
          GROUP BY outcome, reason_code ORDER BY outcome, reason_code NULLS FIRST`,
        [businessId, windowSeconds],
      );
      return {
        databaseNow: now.rows[0].now as string,
        openClaimTotal: open.rows.length > 0 ? (open.rows[0].total as number) : 0,
        openClaims: open.rows.map((x) => ({
          claimId: x.id as string, claimedAt: x.claimed_at as string, attempts: x.attempts as number, lastAttemptedAt: isoOrNull(x.last_attempted_at),
          lastAttemptReasonCode: (x.last_reason as string | null) ?? null,
          actionType: x.action_code ? { code: x.action_code as string, schemaVersion: x.action_version as string } : null,
        })),
        terminal: term.rows.map((x) => ({
          outcome: x.outcome as ExecutionOutcome, reasonCode: (x.reason_code as string | null) ?? null, total: x.total as number, inWindow: x.in_window as number, latestRecordedAt: x.latest as string,
        })),
      };
    });
  }

  /** Appends the audit row of an operator recovery request (a USER action, unlike the engine's own system rows), in its own transaction. */
  async recordOperatorAudit(ctx: TenantContext, a: { businessId: string; action: string; entityId: string; correlationId: string; metadata: Json }): Promise<void> {
    await withTenantTransaction(ctx, async (client) => {
      await client.query(
        `INSERT INTO audit.audit_events
           (tenant_id, workspace_id, business_id, actor_type, actor_id, action, entity_type, entity_id, metadata, correlation_id)
         VALUES ($1,$2,$3,'user',$4,$5,'authorized_action_recovery_request',$6,$7::jsonb,$8)`,
        [ctx.tenantId, ctx.workspaceId, a.businessId, ctx.userId, a.action, a.entityId, JSON.stringify(a.metadata), a.correlationId],
      );
    });
  }
}
