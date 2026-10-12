/**
 * Business Operations execution of a CLAIMED authorized-action package (P0-6c; planning decisions 4, 7, 8, 9, 12, 14).
 *
 * A claim is not authority. For one claim, in ONE tenant transaction, the engine:
 *   1. takes the per-claim advisory lock and returns the stored outcome if the claim already has one (replay is idempotent);
 *   2. re-verifies BO's immutable copy of the sealed package (structure + digest) and reads the target and values from it;
 *   3. checks the activation gate, then LOCKS the target balance row (FOR UPDATE);
 *   4. ONLY THEN asks ABA's authoritative status provider (so lock waits cannot age the answer) and judges the answer against the
 *      DATABASE clock: it must be about this exact id/version/digest, no older than `executionStatusMaxAgeMs`, lifecycle ISSUED or
 *      CONSUMED-by-THIS-claim (validateForExecutionAfterClaim), current version, in window, not expired, in scope, supported, and the
 *      approver authority CURRENT;
 *   5. evaluates the runtime preconditions and the compare-and-set baseline (ruling O-4);
 *   6. mutates through the single BO writer, or records a no-op (O-12), and writes the terminal execution row + audit in the same
 *      transaction. A crash rolls everything back, so there is no durable "started but unknown" state.
 *
 * Outcomes: SUCCEEDED (APPLIED or NO_CHANGE), REFUSED (a deterministic business refusal; nothing mutated), FAILED (the authorized
 * operation failed deterministically or retries were exhausted). "Could not find out yet" conditions (status unavailable/stale, authority
 * unverifiable, operational errors) are recorded as attempts and retried up to EXECUTION_MAX_ATTEMPTS (O-3); a terminal row is never re-driven.
 *
 * Accepted residual race (planning section 7): authority verified CURRENT and then revoked before commit cannot be told apart from a
 * revocation just after commit; the evidence records `statusVerifiedAt`, so the exposure is provable and bounded by executionStatusMaxAgeMs plus
 * commit time.
 *
 * ABA is reached only through the injected shared status-provider port; this module reads and writes no ABA table.
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { AuthorizedActionExecutionRepository, withTenantTransaction } from '@infinicus/database';
import type { AuthorityVerdictRecord, ClaimForExecution, ExecutionRecord, InsertExecutionInput, TenantContext } from '@infinicus/database';
import { canonicalActionTypeRegistry, validateAuthorizedActionPackage, validateForExecutionAfterClaim } from '@infinicus/handoff-contracts';
import type {
  ActionCapabilityRegistry, ActionTypeRegistry, AuthoritativePackageStatusProvider, AuthoritativeStatusAnswer, AuthorizedActionPackageV1, ExecutionCapabilityGate, JsonValue,
} from '@infinicus/handoff-contracts';
import { OutboxExecutionEventPublisher, type ExecutionEventPublisher } from './ExecutionEventPublisher.js';
import { PRODUCTION_BO_CAPABILITIES } from '../authorized-action/boActionCapabilities.js';
import {
  EXECUTION_AUDIT_ACTIONS, EXECUTION_BACKOFF_MS, EXECUTION_CLAIM_RECOVERY_MS, EXECUTION_MAX_ATTEMPTS, EXECUTOR_COMPONENT, STATUS_PROVIDER_COMPONENT,
  type ExecutionReasonCode,
} from './constants.js';
import { sealExecutionEvidence, type ReorderValues } from './executionEvidence.js';
import { InventoryReorderPolicyExecutionAdapter, type LockedBalance, type ParsedReorderPlan } from './InventoryReorderPolicyExecutionAdapter.js';
import { evaluatePreconditions } from './preconditions.js';
import { Decimal } from '../inventory-policy/decimal.js';
import { sha256HexOfText, canonicalize } from '@infinicus/handoff-contracts';

const MS_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DETERMINISTIC_SQLSTATE = /^(22|23)/; // data exception / integrity constraint violation
const SQLSTATE_RAISE_EXCEPTION = 'P0001';

export interface ExecutionServiceDependencies {
  /** ABA-owned authoritative status provider. Required: nothing defaults. */
  statusProvider: AuthoritativePackageStatusProvider;
  /** Maximum age of the status/authority answer at judgement (ruling O-2: the composition root supplies 5000). Required: no hidden default. */
  executionStatusMaxAgeMs: number;
  /** The governed activation control (P0-6e). Required: a closed or throwing gate refuses the execution (fail closed). */
  gate: ExecutionCapabilityGate;
  /** BO's own capability registry. Defaults to the production registry, which supports NOTHING until P0-6e. */
  capabilities?: ActionCapabilityRegistry;
  actionTypes?: ActionTypeRegistry;
  repository?: AuthorizedActionExecutionRepository;
  adapter?: InventoryReorderPolicyExecutionAdapter;
  /** Publishes `operations.action.executed@1` on the execution transaction. Defaults to the BUILD-33 outbox; there is no way to run without one. */
  eventPublisher?: ExecutionEventPublisher;
  maxAttempts?: number;
  backoffMs?: readonly number[];
  claimRecoveryMs?: number;
  clock?: () => Date;
}

export type ExecutionResult =
  | { state: 'TERMINAL'; execution: ExecutionRecord; replayed: boolean }
  | { state: 'RETRY'; attemptNumber: number; reasonCode: string; retryAfterMs: number };

type Fields = Omit<InsertExecutionInput, 'claim' | 'actionType' | 'target' | 'attemptCount' | 'executionStartedAt' | 'evidence' | 'evidenceDigest' | 'correlationId' | 'causationId'>;
type Decision =
  | { kind: 'TERMINAL'; fields: Fields; evidence: { baselineSource: 'BO_EVALUATION_EVIDENCE' | null; judgedAt: string | null; balanceVersionBefore: number | null; balanceVersionAfter: number | null; evaluationRefs: JsonValue; preconditions: JsonValue } }
  | { kind: 'RETRY'; reasonCode: string; detail: string; verdict: 'CURRENT' | 'REVOKED' | 'UNVERIFIABLE' | null; statusVerifiedAt: string | null; operational: boolean };

const refusedFields = (reason: string, detail: string, extra: Partial<Fields> = {}): Fields => ({
  outcome: 'REFUSED', reasonCode: reason, detail: detail.slice(0, 1000), mutationResult: 'NOT_APPLICABLE', balanceId: null, beforeState: null, requestedState: null, afterState: null,
  preconditions: null, authorityVerdict: 'NOT_CHECKED', statusVerifiedAt: null, authorityVerifiedAt: null, statusAnswerDigest: null, providerComponent: null, ...extra,
});
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const snap = (v: { reorderPoint: Decimal; reorderQuantity: Decimal }): ReorderValues => ({ reorderPoint: v.reorderPoint.toString(), reorderQuantity: v.reorderQuantity.toString() });

export class AuthorizedActionExecutionService {
  private readonly repo: AuthorizedActionExecutionRepository;
  private readonly adapter: InventoryReorderPolicyExecutionAdapter;
  private readonly publisher: ExecutionEventPublisher;
  private readonly capabilities: ActionCapabilityRegistry;
  private readonly actionTypes: ActionTypeRegistry;
  private readonly maxAttempts: number;
  private readonly backoffMs: readonly number[];
  private readonly claimRecoveryMs: number;
  private readonly clock: () => Date;

  constructor(private readonly deps: ExecutionServiceDependencies) {
    if (typeof deps.executionStatusMaxAgeMs !== 'number' || !Number.isFinite(deps.executionStatusMaxAgeMs) || deps.executionStatusMaxAgeMs < 0) {
      throw new Error('executionStatusMaxAgeMs must be a non-negative number');
    }
    this.repo = deps.repository ?? new AuthorizedActionExecutionRepository();
    this.adapter = deps.adapter ?? new InventoryReorderPolicyExecutionAdapter();
    this.publisher = deps.eventPublisher ?? new OutboxExecutionEventPublisher();
    this.capabilities = deps.capabilities ?? PRODUCTION_BO_CAPABILITIES;
    this.actionTypes = deps.actionTypes ?? canonicalActionTypeRegistry();
    this.maxAttempts = deps.maxAttempts ?? EXECUTION_MAX_ATTEMPTS;
    this.backoffMs = deps.backoffMs ?? EXECUTION_BACKOFF_MS;
    this.claimRecoveryMs = deps.claimRecoveryMs ?? EXECUTION_CLAIM_RECOVERY_MS;
    this.clock = deps.clock ?? (() => new Date());
    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1 || this.backoffMs.length === 0) throw new Error('invalid retry policy');
  }

  /** One execution attempt for a claim, now. Idempotent: a claim with a terminal outcome returns it unchanged. */
  async executeClaim(ctx: TenantContext, claimId: string): Promise<ExecutionResult> {
    try {
      return await withTenantTransaction(ctx, (client) => this.attempt(client, ctx, claimId));
    } catch (error) {
      if (error instanceof ClaimNotFoundError) throw error;
      // The transaction rolled back (deadlock, serialization failure, connection loss, ...): record it outside, bounded by the retry policy.
      return this.recordOperationalFailure(ctx, claimId, error);
    }
  }

  /**
   * Re-drives claims that have no outcome: a claim never attempted is recovered `claimRecoveryMs` after it was claimed (ruling O-3: 60 s);
   * a claim with attempts waits the backoff for its attempt count. Terminal claims are never selected. Returns the claims it attempted.
   * The optional `businessId` / `actionType` narrow the list (P0-6h operator recovery drives one business and one action type; the worker never calls this).
   */
  async runDue(ctx: TenantContext, options: { limit: number; businessId?: string; actionType?: { code: string; schemaVersion: string } }): Promise<{ claimId: string; result: ExecutionResult }[]> {
    const now = this.clock().getTime();
    const waiting = await this.repo.claimsAwaitingExecution(ctx, options.limit, { ...(options.businessId ? { businessId: options.businessId } : {}), ...(options.actionType ? { actionType: options.actionType } : {}) });
    const out: { claimId: string; result: ExecutionResult }[] = [];
    for (const w of waiting) {
      const dueAt = w.attempts === 0
        ? Date.parse(w.claimedAt) + this.claimRecoveryMs
        : Date.parse(w.lastAttemptedAt as string) + this.backoffFor(w.attempts);
      if (dueAt > now) continue;
      out.push({ claimId: w.claimId, result: await this.executeClaim(ctx, w.claimId) });
    }
    return out;
  }

  private backoffFor(attemptsSoFar: number): number {
    return this.backoffMs[Math.min(Math.max(attemptsSoFar, 1), this.backoffMs.length) - 1];
  }

  // ------------------------------------------------------------------------------------------------------------------------------

  private async attempt(client: PoolClient, ctx: TenantContext, claimId: string): Promise<ExecutionResult> {
    const repo = this.repo;
    await repo.lockClaim(client, claimId);
    const claim = await repo.loadClaim(client, claimId);
    if (!claim || claim.tenantId !== ctx.tenantId || claim.workspaceId !== ctx.workspaceId) throw new ClaimNotFoundError(claimId);
    const existing = await repo.getExecutionByClaim(client, claimId);
    if (existing) return { state: 'TERMINAL', execution: existing, replayed: true };

    const startedAt = await repo.transactionStart(client);
    const summary = await repo.attemptSummary(client, claimId);
    const attemptNumber = summary.attempts + 1;

    const decision = await this.decide(client, ctx, claim);
    if (decision.kind === 'RETRY') {
      if (attemptNumber >= this.maxAttempts) {
        return this.terminal(client, ctx, claim, startedAt, attemptNumber, this.exhausted(decision), null);
      }
      await repo.insertAttempt(client, ctx, {
        claim, attemptNumber, outcome: decision.operational ? 'RETRYABLE_FAILURE' : 'RETRYABLE_REFUSAL', reasonCode: decision.reasonCode, detail: decision.detail.slice(0, 1000),
        authorityVerdict: decision.verdict, statusVerifiedAt: decision.statusVerifiedAt, correlationId: claim.correlationId,
      });
      await repo.recordAudit(client, ctx, { businessId: claim.businessId, action: EXECUTION_AUDIT_ACTIONS.attemptDeferred, entityId: claim.claimId, correlationId: claim.correlationId, metadata: { packageId: claim.packageId, packageVersion: claim.packageVersion, attemptNumber, reasonCode: decision.reasonCode } });
      return { state: 'RETRY', attemptNumber, reasonCode: decision.reasonCode, retryAfterMs: this.backoffFor(attemptNumber) };
    }
    return this.terminal(client, ctx, claim, startedAt, attemptNumber, decision, null);
  }

  private exhausted(last: Extract<Decision, { kind: 'RETRY' }>): Extract<Decision, { kind: 'TERMINAL' }> {
    const fields = refusedFields('RETRIES_EXHAUSTED', `the last attempt could not be completed (${last.reasonCode}): ${last.detail}`, {
      outcome: last.operational ? 'FAILED' : 'REFUSED', authorityVerdict: (last.verdict ?? 'NOT_CHECKED') as AuthorityVerdictRecord, statusVerifiedAt: last.statusVerifiedAt,
    });
    return { kind: 'TERMINAL', fields, evidence: { baselineSource: null, judgedAt: null, balanceVersionBefore: null, balanceVersionAfter: null, evaluationRefs: [], preconditions: [] } };
  }

  private async terminal(
    client: PoolClient, ctx: TenantContext, claim: ClaimForExecution, startedAt: string, attemptNumber: number,
    decision: Extract<Decision, { kind: 'TERMINAL' }>, causationId: string | null,
  ): Promise<ExecutionResult> {
    const doc = claim.document as unknown as AuthorizedActionPackageV1;
    const f = decision.fields;
    const executionId = randomUUID();
    const target = { kind: String(doc.action?.target?.kind ?? ''), id: String(doc.action?.target?.id ?? '') };
    const actionType = { code: String(doc.action?.type?.code ?? ''), schemaVersion: String(doc.action?.type?.schemaVersion ?? '') };
    const balanceAfter = f.afterState as ReorderValues | null;
    const sealed = sealExecutionEvidence({
      executionId,
      claim: { claimId: claim.claimId, receiptId: claim.receiptId, claimedAt: claim.claimedAt, packageId: claim.packageId, packageVersion: claim.packageVersion, digest: claim.digest, correlationId: claim.correlationId },
      scope: { tenantId: claim.tenantId, workspaceId: claim.workspaceId, businessId: claim.businessId }, actionType, target, executionStartedAt: startedAt,
      outcome: f.outcome, reasonCode: f.reasonCode, detail: f.detail, attemptCount: attemptNumber,
      authority: { verdict: f.authorityVerdict, statusVerifiedAt: f.statusVerifiedAt, authorityVerifiedAt: f.authorityVerifiedAt, statusAnswerDigest: f.statusAnswerDigest, provider: f.providerComponent, judgedAt: decision.evidence.judgedAt },
      mutation: {
        result: f.mutationResult, balanceId: f.balanceId, balanceVersionBefore: decision.evidence.balanceVersionBefore, balanceVersionAfter: decision.evidence.balanceVersionAfter,
        before: f.beforeState as ReorderValues | null, requested: f.requestedState as ReorderValues | null, after: balanceAfter, baselineSource: decision.evidence.baselineSource,
      },
      preconditions: decision.evidence.preconditions,
      boundaries: {
        executionWindow: (doc.action?.executionWindow ?? null) as unknown as JsonValue, budget: (doc.action?.budget ?? null) as unknown as JsonValue,
        rollback: (doc.action?.rollback ?? null) as unknown as JsonValue, monitoring: (doc.action?.monitoring ?? null) as unknown as JsonValue,
      },
      lineage: { actionId: doc.action?.actionId ?? null, decisionId: doc.lineage?.decision?.decisionId ?? null, decisionVersionId: doc.lineage?.decision?.decisionVersionId ?? null, evaluationRefs: decision.evidence.evaluationRefs, causationId },
      executor: { type: 'system', id: EXECUTOR_COMPONENT },
    });
    const execution = await this.repo.insertExecution(client, ctx, {
      ...f, claim, actionType, target, attemptCount: attemptNumber, executionStartedAt: startedAt, evidence: sealed.document, evidenceDigest: sealed.digest,
      correlationId: claim.correlationId, causationId, id: executionId,
    });
    await this.repo.recordAudit(client, ctx, {
      businessId: claim.businessId, entityId: claim.claimId, correlationId: claim.correlationId,
      action: f.outcome === 'SUCCEEDED' ? EXECUTION_AUDIT_ACTIONS.executed : f.outcome === 'FAILED' ? EXECUTION_AUDIT_ACTIONS.failed : EXECUTION_AUDIT_ACTIONS.refused,
      metadata: { executionId, packageId: claim.packageId, packageVersion: claim.packageVersion, digest: claim.digest, outcome: f.outcome, reasonCode: f.reasonCode, mutationResult: f.mutationResult, evidenceDigest: sealed.digest, statusVerifiedAt: f.statusVerifiedAt },
    });
    // The announcement is part of the fact: same transaction, so a committed execution always has its event and a rollback leaves none.
    await this.publisher.publish(client, ctx, execution);
    return { state: 'TERMINAL', execution, replayed: false };
  }

  /** The judgement pipeline. Reads and locks; mutates only at the very end, behind a savepoint. Never writes terminal rows itself. */
  private async decide(client: PoolClient, ctx: TenantContext, claim: ClaimForExecution): Promise<Decision> {
    const repo = this.repo;
    const refuse = (reason: ExecutionReasonCode, detail: string, extra: Partial<Fields> = {}): Decision => ({
      kind: 'TERMINAL', fields: refusedFields(reason, detail, extra),
      evidence: { baselineSource: null, judgedAt: null, balanceVersionBefore: null, balanceVersionAfter: null, evaluationRefs: [], preconditions: [] },
    });

    // 2. BO's immutable copy must still be a valid sealed package (structure + digest) and be the claimed one.
    const doc = claim.document;
    const nowEarly = await repo.databaseNow(client);
    const structural = validateAuthorizedActionPackage(doc, { actionTypes: this.actionTypes, now: nowEarly });
    const idOk = isObject(doc.identity) && doc.identity.packageId === claim.packageId && doc.identity.packageVersion === claim.packageVersion
      && isObject(doc.integrity) && doc.integrity.digest === claim.digest;
    if (!idOk || (!structural.valid && !structural.errors.every((e) => e.code === 'PACKAGE_EXPIRED' || e.code === 'EXECUTION_WINDOW_NOT_OPEN'))) {
      return refuse('RECEIPT_INVALID', `the stored package failed re-verification: ${structural.errors.map((e) => e.code).join(', ') || 'identity mismatch'}`);
    }
    const pkg = doc as unknown as AuthorizedActionPackageV1;

    // Unsupported action types are refused before anything else is read: BO cannot execute them whatever ABA authorized.
    if (!this.capabilities.supports(pkg.action.type.code, pkg.action.type.schemaVersion)) {
      return refuse('ACTION_TYPE_UNSUPPORTED_BY_EXECUTOR', `${pkg.action.type.code}@${pkg.action.type.schemaVersion} is not executable by this executor`);
    }
    const plan = this.adapter.parse(pkg);
    if ('code' in plan) return refuse(plan.code, plan.detail);

    // 3. The activation gate (fail closed), then the target balance lock.
    const scope = { tenantId: claim.tenantId, workspaceId: claim.workspaceId, businessId: claim.businessId };
    const open = await Promise.resolve().then(() => this.deps.gate.isEnabled(scope, { code: pkg.action.type.code, schemaVersion: pkg.action.type.schemaVersion })).then((v) => v === true, () => false);
    if (!open) return refuse('CAPABILITY_DISABLED', 'the authorized-action pipeline is not enabled for this business and action type');

    const balances = await this.adapter.lockTarget(client, claim.businessId, plan.itemId);
    if (balances.length === 0) return refuse('NO_BALANCE', 'the target inventory item has no balance in this business (none is ever created)');
    if (balances.length > 1) return refuse('TARGET_AMBIGUOUS', 'the target inventory item has several balances; the action does not name a warehouse');
    const balance = balances[0];

    // 4. Authority and status are requested only now, with the locks held.
    const answer: AuthoritativeStatusAnswer | null = await Promise.resolve()
      .then(() => this.deps.statusProvider.getStatus({ packageId: claim.packageId, packageVersion: claim.packageVersion, digest: claim.digest, scope }))
      .catch(() => null); // an unreachable provider is "no answer", never a reason to proceed
    if (!isObject(answer) || !isObject(answer.status) || !isObject(answer.authority)) {
      return { kind: 'RETRY', reasonCode: 'STATUS_UNAVAILABLE', detail: 'the authoritative status could not be obtained', verdict: null, statusVerifiedAt: null, operational: false };
    }
    const now = await repo.databaseNow(client);
    const statusVerifiedAt = typeof answer.status.verifiedAt === 'string' && MS_UTC.test(answer.status.verifiedAt) ? answer.status.verifiedAt : null;
    const verdictText = answer.authority.state;
    const verdictKnown = verdictText === 'CURRENT' || verdictText === 'REVOKED' || verdictText === 'UNVERIFIABLE' ? verdictText : null;

    const validation = validateForExecutionAfterClaim(doc, {
      actionTypes: this.actionTypes, capabilities: this.capabilities, now, scope, status: answer.status, statusMaxAgeMs: this.deps.executionStatusMaxAgeMs, consumptionReceiptId: claim.receiptId,
    });
    const codes = [...new Set(validation.errors.map((e) => e.code))];
    if (codes.length > 0) {
      if (codes.every((c) => c === 'STATUS_UNVERIFIED')) {
        return { kind: 'RETRY', reasonCode: 'STATUS_UNVERIFIED', detail: 'the status answer was not about this package or not fresh enough', verdict: verdictKnown, statusVerifiedAt, operational: false };
      }
      const first = codes.find((c) => c !== 'STATUS_UNVERIFIED') as string;
      return refuse(first, `the package is not executable: ${codes.join(', ')}`, { authorityVerdict: (verdictKnown ?? 'NOT_CHECKED') as AuthorityVerdictRecord, statusVerifiedAt });
    }
    const authorityVerifiedAt = typeof answer.authority.verifiedAt === 'string' && MS_UTC.test(answer.authority.verifiedAt) ? answer.authority.verifiedAt : null;
    const nowMs = Date.parse(now);
    const authorityFresh = authorityVerifiedAt !== null && Date.parse(authorityVerifiedAt) <= nowMs && nowMs - Date.parse(authorityVerifiedAt) <= this.deps.executionStatusMaxAgeMs;
    if (!authorityFresh || verdictKnown === null || verdictKnown === 'UNVERIFIABLE') {
      return { kind: 'RETRY', reasonCode: 'AUTHORITY_UNVERIFIABLE', detail: 'the approver authority could not be verified', verdict: verdictKnown === 'REVOKED' ? 'REVOKED' : verdictKnown, statusVerifiedAt, operational: false };
    }
    const proof = { authorityVerdict: verdictKnown as AuthorityVerdictRecord, statusVerifiedAt, authorityVerifiedAt, statusAnswerDigest: `sha256:${sha256HexOfText(canonicalize(answer as unknown as JsonValue))}`, providerComponent: STATUS_PROVIDER_COMPONENT };
    if (verdictKnown === 'REVOKED') return refuse('AUTHORITY_REVOKED', 'the approver authority has been revoked since the decision', proof);

    // 5. Runtime preconditions, then the baseline.
    const pre = pkg.action.preconditions;
    const evaluated = evaluatePreconditions(pre.state === 'VALUE' ? pre.value : [], { stock_available: balance.quantityAvailable });
    const preJson = evaluated.results as unknown as JsonValue;
    const keep = { judgedAt: now, preconditions: preJson, evaluationRefs: [] as JsonValue, baselineSource: null as 'BO_EVALUATION_EVIDENCE' | null, balanceVersionBefore: balance.version, balanceVersionAfter: null as number | null };
    const refuseWith = (reason: ExecutionReasonCode, detail: string, ev: Partial<typeof keep> = {}): Decision => ({
      kind: 'TERMINAL', fields: refusedFields(reason, detail, { ...proof, balanceId: balance.id, beforeState: snap(balance) as never, requestedState: snap(plan.requested) as never, preconditions: preJson as never }),
      evidence: { ...keep, ...ev },
    });
    if (evaluated.unsupported) return refuseWith('UNSUPPORTED_PRECONDITION', `unsupported precondition: ${evaluated.results.filter((r) => r.problem).map((r) => `${r.code}/${r.problem}`).join(', ')}`);
    if (evaluated.failed) return refuseWith('PRECONDITION_FAILED', `precondition not met: ${evaluated.results.filter((r) => r.passed === false).map((r) => r.code).join(', ')}`);

    const baseline = await this.adapter.resolveBaseline(ctx, pkg, plan);
    if (!baseline.ok) return refuseWith(baseline.code, baseline.detail);
    const evidenceBase = { evaluationRefs: baseline.evaluationRefs as unknown as JsonValue, baselineSource: 'BO_EVALUATION_EVIDENCE' as const };
    if (baseline.balanceId !== balance.id || baseline.reorderPoint.cmp(balance.reorderPoint) !== 0 || baseline.reorderQuantity.cmp(balance.reorderQuantity) !== 0) {
      return refuseWith('BASELINE_CHANGED', 'the balance no longer holds the baseline the evaluation judged; the newer state is not overwritten', evidenceBase);
    }

    // 6. The mutation (or the recorded no-op, ruling O-12), behind a savepoint so a deterministic rejection leaves the transaction usable.
    const successBase = { ...proof, balanceId: balance.id, beforeState: snap(balance) as never, requestedState: snap(plan.requested) as never, preconditions: preJson as never, outcome: 'SUCCEEDED' as const, reasonCode: null, detail: null };
    if (plan.requested.reorderPoint.cmp(balance.reorderPoint) === 0 && plan.requested.reorderQuantity.cmp(balance.reorderQuantity) === 0) {
      return { kind: 'TERMINAL', fields: { ...successBase, mutationResult: 'NO_CHANGE', afterState: null }, evidence: { ...keep, ...evidenceBase } };
    }
    await client.query('SAVEPOINT bo_execution_mutation');
    try {
      const applied = await this.adapter.apply(client, ctx, { pkg, plan, balance, correlationId: claim.correlationId, actorId: EXECUTOR_COMPONENT, occurredAt: now });
      await client.query('RELEASE SAVEPOINT bo_execution_mutation');
      return {
        kind: 'TERMINAL',
        fields: { ...successBase, mutationResult: 'APPLIED', afterState: { reorderPoint: applied.after.reorderPoint, reorderQuantity: applied.after.reorderQuantity } as never },
        evidence: { ...keep, ...evidenceBase, balanceVersionAfter: applied.after.version },
      };
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT bo_execution_mutation');
      await client.query('RELEASE SAVEPOINT bo_execution_mutation');
      const code = (error as { code?: string }).code;
      const name = error instanceof Error ? error.name : '';
      if (name === 'ReorderBaselineChangedError') return refuseWith('BASELINE_CHANGED', 'the balance changed while the action was being applied; nothing was changed', evidenceBase);
      if (name === 'OperationalMappingError' || (typeof code === 'string' && (DETERMINISTIC_SQLSTATE.test(code) || code === SQLSTATE_RAISE_EXCEPTION))) {
        return {
          kind: 'TERMINAL',
          fields: refusedFields('MUTATION_REJECTED', error instanceof Error ? error.message : 'the mutation was rejected', { ...proof, outcome: 'FAILED', balanceId: balance.id, beforeState: snap(balance) as never, requestedState: snap(plan.requested) as never, preconditions: preJson as never }),
          evidence: { ...keep, ...evidenceBase },
        };
      }
      throw error; // transient database condition: the caller records it as a retryable failure
    }
  }

  /** The transaction rolled back for an operational reason: append an attempt, or - when attempts are exhausted - a terminal FAILED row. */
  private async recordOperationalFailure(ctx: TenantContext, claimId: string, error: unknown): Promise<ExecutionResult> {
    const detail = (error instanceof Error ? `${error.name}: ${error.message}` : 'operational error').slice(0, 500);
    return withTenantTransaction(ctx, async (client) => {
      await this.repo.lockClaim(client, claimId);
      const claim = await this.repo.loadClaim(client, claimId);
      if (!claim) throw new ClaimNotFoundError(claimId);
      const existing = await this.repo.getExecutionByClaim(client, claimId);
      if (existing) return { state: 'TERMINAL', execution: existing, replayed: true } as const;
      const startedAt = await this.repo.transactionStart(client);
      const attemptNumber = (await this.repo.attemptSummary(client, claimId)).attempts + 1;
      const last = { kind: 'RETRY', reasonCode: 'OPERATIONAL_ERROR', detail, verdict: null, statusVerifiedAt: null, operational: true } as const;
      if (attemptNumber >= this.maxAttempts) return this.terminal(client, ctx, claim, startedAt, attemptNumber, this.exhausted(last), null);
      await this.repo.insertAttempt(client, ctx, { claim, attemptNumber, outcome: 'RETRYABLE_FAILURE', reasonCode: 'OPERATIONAL_ERROR', detail, authorityVerdict: null, statusVerifiedAt: null, correlationId: claim.correlationId });
      return { state: 'RETRY', attemptNumber, reasonCode: 'OPERATIONAL_ERROR', retryAfterMs: this.backoffFor(attemptNumber) } as const;
    });
  }
}

export class ClaimNotFoundError extends Error {
  constructor(readonly claimId: string) {
    super(`authorized-action claim not found in this scope: ${claimId}`);
    this.name = 'ClaimNotFoundError';
  }
}

export type { LockedBalance, ParsedReorderPlan };
