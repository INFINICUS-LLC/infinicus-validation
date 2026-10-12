/**
 * Business Operations intake of an AuthorizedActionPackage (P0-5 Block 3e).
 *
 * Ends at VALIDATED + RECEIVED + SINGLE-USE CLAIMED. It does NOT execute the action, change inventory, produce execution evidence,
 * announce an outcome (its only write besides the claim is the claim's own internal recovery signal, P0-6g), or reach Approved Business Action in any way other than the injected authoritative status provider (the
 * architecture boundary). CONSUMED means only: BO atomically claimed this package version for one execution attempt.
 *
 * Order (owner ruling, no distributed lock): static validation -> authoritative status (provider) -> ONE transaction { per-package
 * lock, database clock, dedupe, assess against that clock, receipt, atomic claim, attempt record } -> commit.
 *
 * Race (status check -> claim): the status answer is judged AGAINST THE DATABASE CLOCK INSIDE THE TRANSACTION, after the lock, so a
 * slow path ages the answer out and fails closed. The remaining window is therefore bounded by `statusMaxAgeMs`; a revoke inside that
 * window can only leave a claim on a package that ABA has since revoked. That is harmless by construction: a claim is not execution,
 * and the later execution step must obtain a fresh authoritative status again before changing anything (a claim is never authority).
 */
import { randomUUID } from 'node:crypto';
import { AuthorizedActionIntakeRepository } from '@infinicus/database';
import type { TenantContext } from '@infinicus/database';
import { canonicalActionTypeRegistry, validateAuthorizedActionPackage } from '@infinicus/handoff-contracts';
import type {
  ActionCapabilityRegistry, ActionTypeRegistry, AuthoritativePackageStatusProvider, AuthoritativeStatusAnswer, PackageEnablementPolicy,
} from '@infinicus/handoff-contracts';
import { PRODUCTION_BO_CAPABILITIES } from './boActionCapabilities.js';
import { assessIntake } from './authorizedActionIntakePolicy.js';
import { OutboxClaimRecoveryScheduler } from './ClaimRecoveryScheduler.js';
import type { ClaimRecoveryScheduler } from './ClaimRecoveryScheduler.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The BO scope an intake runs under. Taken from BO's own authenticated context, never from the package. */
export interface BoIntakeContext extends TenantContext {
  businessId: string;
}

export interface AuthorizedActionIntakeRequest {
  /** The sealed package exactly as delivered. */
  package: unknown;
  /** Optional trace id only; it carries no authority. */
  correlationId?: string;
}

export interface AuthorizedActionIntakeResult {
  /** CLAIMED = a new single-use claim was written. REPLAYED = the identical package was already claimed (idempotent). */
  outcome: 'CLAIMED' | 'REPLAYED';
  receiptId: string;
  claimId: string;
  claimedAt: string;
}

export class PackageIntakeRefusedError extends Error {
  constructor(readonly codes: readonly string[], readonly receiptId: string | null = null) {
    super(`authorized-action package refused (${codes.join(', ')})`);
    this.name = 'PackageIntakeRefusedError';
  }
}

export interface AuthorizedActionIntakeDependencies {
  /** ABA-owned authoritative status provider. Required: there is no production transport yet, so nothing defaults. */
  statusProvider: AuthoritativePackageStatusProvider;
  /** Maximum age of a status/authority answer, judged at claim time. Required: no default is invented. */
  statusMaxAgeMs: number;
  repository?: AuthorizedActionIntakeRepository;
  /** BO's own capability registry. Defaults to the production registry, which supports NOTHING yet. */
  capabilities?: ActionCapabilityRegistry;
  /** The shared canonical action vocabulary (platform contract truth). */
  actionTypes?: ActionTypeRegistry;
  enablement?: PackageEnablementPolicy;
  /**
   * Writes the claim's durable recovery signal in the claim's own transaction (P0-6g). Defaults to the BUILD-33 outbox: there is no way to
   * create a claim without one.
   */
  recovery?: ClaimRecoveryScheduler;
}

const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Best-effort identity of a delivery, only for the attempt log; never trusted for any decision. */
function loggedIdentity(document: unknown): { packageId: string | null; packageVersion: number | null; digest: string | null } {
  const identity = isRec(document) && isRec(document.identity) ? document.identity : {};
  const integrity = isRec(document) && isRec(document.integrity) ? document.integrity : {};
  return {
    packageId: typeof identity.packageId === 'string' && UUID.test(identity.packageId) ? identity.packageId : null,
    packageVersion: typeof identity.packageVersion === 'number' && Number.isInteger(identity.packageVersion) && identity.packageVersion >= 1 ? identity.packageVersion : null,
    digest: typeof integrity.digest === 'string' && /^sha256:[0-9a-f]{64}$/.test(integrity.digest) ? integrity.digest : null,
  };
}

export class AuthorizedActionIntakeService {
  private readonly repository: AuthorizedActionIntakeRepository;
  private readonly capabilities: ActionCapabilityRegistry;
  private readonly actionTypes: ActionTypeRegistry;
  private readonly recovery: ClaimRecoveryScheduler;

  constructor(private readonly deps: AuthorizedActionIntakeDependencies) {
    if (typeof deps.statusMaxAgeMs !== 'number' || !Number.isFinite(deps.statusMaxAgeMs) || deps.statusMaxAgeMs < 0) {
      throw new Error('statusMaxAgeMs must be a non-negative number');
    }
    this.repository = deps.repository ?? new AuthorizedActionIntakeRepository();
    this.capabilities = deps.capabilities ?? PRODUCTION_BO_CAPABILITIES;
    this.actionTypes = deps.actionTypes ?? canonicalActionTypeRegistry();
    this.recovery = deps.recovery ?? new OutboxClaimRecoveryScheduler();
  }

  async intake(ctx: BoIntakeContext, request: AuthorizedActionIntakeRequest): Promise<AuthorizedActionIntakeResult> {
    const correlationId = request.correlationId && UUID.test(request.correlationId) ? request.correlationId : randomUUID();
    const scope = { tenantId: ctx.tenantId, workspaceId: ctx.workspaceId, businessId: ctx.businessId };
    const logged = loggedIdentity(request.package);
    const refuse = async (codes: string[], receiptId: string | null = null): Promise<never> => {
      await this.repository.recordAttempt(ctx, {
        businessId: ctx.businessId, ...logged, outcome: 'REFUSED', receiptId, refusalCodes: codes, correlationId,
      });
      throw new PackageIntakeRefusedError(codes, receiptId);
    };

    // 1. Static validation of the sealed contract and the scope BO runs in (cheap, no provider call, no persistence).
    const validation = { actionTypes: this.actionTypes, ...(this.deps.enablement ? { enablement: this.deps.enablement } : {}) };
    const structural = validateAuthorizedActionPackage(request.package, validation);
    if (!structural.valid) return refuse([...new Set(structural.errors.map((e) => e.code))]);
    const doc = request.package as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (doc.scope.tenantId !== scope.tenantId || doc.scope.workspaceId !== scope.workspaceId || doc.scope.businessId !== scope.businessId) {
      return refuse(['SCOPE_MISMATCH']);
    }

    // 2. Authoritative status through the injected ABA-owned provider. Skipped for an exact replay BO has already claimed.
    const claimed = await this.repository.getClaim(ctx, doc.identity.packageId, doc.identity.packageVersion);
    let answer: AuthoritativeStatusAnswer | null = null;
    if (!claimed) {
      try {
        answer = await this.deps.statusProvider.getStatus({
          packageId: doc.identity.packageId, packageVersion: doc.identity.packageVersion, digest: doc.integrity.digest, scope,
        });
      } catch {
        answer = null;
      }
      if (!answer) return refuse(['STATUS_UNAVAILABLE']);
    }

    // 3. ONE transaction: lock, database clock, dedupe, assess, receipt, atomic claim, attempt record.
    let result;
    try {
      result = await this.repository.receiveAndClaim(ctx, {
        businessId: ctx.businessId, document: request.package, correlationId,
        onClaimed: async (client, claim) => {
          await this.recovery.schedule(client, ctx, {
            claimId: claim.claimId, claimedAt: claim.claimedAt, packageId: doc.identity.packageId, packageVersion: doc.identity.packageVersion, digest: doc.integrity.digest,
            scope, actionType: { code: doc.action.type.code, schemaVersion: doc.action.type.schemaVersion }, correlationId,
          });
        },
        evaluate: (now) => {
          const a = assessIntake({
            document: request.package, scope, actionTypes: this.actionTypes, capabilities: this.capabilities,
            ...(this.deps.enablement ? { enablement: this.deps.enablement } : {}),
            answer, now, statusMaxAgeMs: this.deps.statusMaxAgeMs,
          });
          return { identityVerified: a.identityVerified, refusalCodes: a.refusalCodes, statusVerifiedAt: a.statusVerifiedAt };
        },
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'ConflictError') return refuse(['PAYLOAD_COLLISION']);
      throw error;
    }

    if (result.outcome === 'REFUSED') throw new PackageIntakeRefusedError(result.refusalCodes, result.receiptId);
    return { outcome: result.outcome, receiptId: result.receiptId as string, claimId: result.claimId as string, claimedAt: result.claimedAt as string };
  }
}
