/**
 * ABA-owned implementations of the shared execution-boundary ports (P0-6a). UNWIRED: nothing in the platform constructs or calls them yet
 * (P0-6b wires the notification and consumer; P0-6c the BO executor). Business Operations depends on the PORT TYPES in handoff-contracts
 * only and never imports this file or any ABA repository.
 *
 *   - AbaPackageStatusProvider        : one authoritative, never-cached read - package lifecycle (database clock) AND whether the approver
 *                                       authority behind it is still current, judged by the same rule the issuer uses (executionAuthority.ts).
 *   - AbaAuthorizedActionPackageSource: the sealed document for an exact id/version/scope (the event carries a reference, not the body).
 *   - AbaPackageConsumptionRecorder   : ABA's CONSUMED mirror of a BO claim (R-5); BO's claim stays canonical.
 *
 * A request that is malformed, unknown, outside the requested scope or about a different digest returns null (BO refuses; nothing about other
 * scopes is disclosed). Infrastructure failures reject: BO treats a rejection like null and refuses. None of these ports grants, issues,
 * revokes, supersedes or executes anything.
 */
import { randomUUID } from 'node:crypto';
import {
  AuthorizedActionIssuanceRepository, AuthorizedActionPackageRepository, AutomationLevelPolicyRepository, withSharedTenantTransaction,
} from '@infinicus/database';
import type { PackageVersionRecord, TenantContext } from '@infinicus/database';
import { isWellFormedDigest } from '@infinicus/handoff-contracts';
import type {
  AuthoritativePackageStatusProvider, AuthoritativeStatusAnswer, AuthoritativeStatusRequest, AuthorizedActionPackageSource,
  AuthorizedActionPackageSourceDocument, PackageConsumptionRecorder, PackageScope, RecordConsumedRequest, RecordConsumedResult,
} from '@infinicus/handoff-contracts';
import { evaluateExecutionAuthority, policyCoversActionType } from './executionAuthority.js';
import { POLICY_ACTION_TYPES_KEY } from './packageIssuancePolicy.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LEVEL_2 = 2 as const;

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function validScope(scope: unknown): scope is PackageScope {
  return isObject(scope) && [scope.tenantId, scope.workspaceId, scope.businessId].every((id) => typeof id === 'string' && UUID.test(id));
}

function validIdentity(r: { packageId: unknown; packageVersion: unknown; scope: unknown }): boolean {
  return typeof r.packageId === 'string' && UUID.test(r.packageId)
    && typeof r.packageVersion === 'number' && Number.isSafeInteger(r.packageVersion) && r.packageVersion >= 1
    && validScope(r.scope);
}

/** The tenant context ABA reads under. Row-level security scopes it to the requested tenant and workspace; the actor is the ABA system actor. */
function abaContext(scope: PackageScope, actorUserId: string): TenantContext {
  return { tenantId: scope.tenantId, workspaceId: scope.workspaceId, userId: actorUserId };
}

function requireActor(actorUserId: unknown): string {
  if (typeof actorUserId !== 'string' || !UUID.test(actorUserId)) throw new Error('an ABA system actor user id (lowercase UUID) is required');
  return actorUserId;
}

/** The version exists, belongs to exactly the requested business (its sealed document says so) and carries the asserted digest (when given). */
function inScope(record: PackageVersionRecord | null, scope: PackageScope, digest: string | null): record is PackageVersionRecord {
  if (!record) return false;
  const docScope = isObject(record.document) ? record.document.scope : undefined;
  if (!validScope(docScope) || docScope.tenantId !== scope.tenantId || docScope.workspaceId !== scope.workspaceId || docScope.businessId !== scope.businessId) return false;
  return digest === null || record.digest === digest;
}

export interface AbaPackageStatusProviderDependencies {
  packages: Pick<AuthorizedActionPackageRepository, 'getVersion' | 'getAuthoritativeStatus'>;
  issuance: Pick<AuthorizedActionIssuanceRepository, 'loadSources'>;
  policies: Pick<AutomationLevelPolicyRepository, 'getEffectivePolicy' | 'getVersion'>;
  /** The ABA system actor recorded in the tenant context of these reads. Required: no default identity is invented. */
  actorUserId: string;
}

export class AbaPackageStatusProvider implements AuthoritativePackageStatusProvider {
  private readonly deps: AbaPackageStatusProviderDependencies;
  private readonly actorUserId: string;

  constructor(deps: Partial<AbaPackageStatusProviderDependencies> & { actorUserId: string }) {
    this.actorUserId = requireActor(deps.actorUserId);
    this.deps = {
      packages: deps.packages ?? new AuthorizedActionPackageRepository(),
      issuance: deps.issuance ?? new AuthorizedActionIssuanceRepository(),
      policies: deps.policies ?? new AutomationLevelPolicyRepository(),
      actorUserId: this.actorUserId,
    };
  }

  async getStatus(request: AuthoritativeStatusRequest): Promise<AuthoritativeStatusAnswer | null> {
    if (!isObject(request) || !validIdentity(request) || !isWellFormedDigest(request.digest)) return null;
    const ctx = abaContext(request.scope, this.actorUserId);
    const d = this.deps;

    return withSharedTenantTransaction(ctx, async () => {
      const record = await d.packages.getVersion(ctx, request.packageId, request.packageVersion);
      if (!inScope(record, request.scope, request.digest)) return null;

      // Authority facts first, the lifecycle status LAST: its database-clock `verifiedAt` is then not earlier than any fact it vouches for.
      const doc = record.document as { action?: { actionId?: unknown; type?: { code?: unknown; schemaVersion?: unknown } } };
      const actionId = doc.action?.actionId;
      const code = doc.action?.type?.code;
      const schemaVersion = doc.action?.type?.schemaVersion;
      let authority: { state: 'CURRENT' | 'REVOKED' | 'UNVERIFIABLE' } = { state: 'UNVERIFIABLE' };
      if (typeof actionId === 'string' && UUID.test(actionId) && typeof code === 'string' && typeof schemaVersion === 'string') {
        const sources = await d.issuance.loadSources(ctx, actionId);
        if (sources) {
          const effective = await d.policies.getEffectivePolicy(ctx, LEVEL_2);
          const policyVersion = effective ? await d.policies.getVersion(ctx, effective.policyVersionId) : null;
          authority = evaluateExecutionAuthority({
            decisionStatus: sources.decision.status,
            approvalAudit: sources.approvalAudit.events,
            assignment: sources.assignment,
            level2PolicyCoversActionType: effective && policyVersion
              ? policyCoversActionType(policyVersion.specification, POLICY_ACTION_TYPES_KEY, code, schemaVersion)
              : null,
          });
        }
      }

      const status = await d.packages.getAuthoritativeStatus(ctx, request.packageId, request.packageVersion);
      if (!status || status.digest !== request.digest) return null;
      return {
        status: {
          packageId: status.packageId, packageVersion: status.packageVersion, digest: status.digest, lifecycle: status.lifecycle,
          latestPackageVersion: status.latestPackageVersion, verifiedAt: status.verifiedAt, consumptionReceiptId: status.consumptionReceiptId,
        },
        authority: { state: authority.state, verifiedAt: status.verifiedAt },
      };
    });
  }
}

export class AbaAuthorizedActionPackageSource implements AuthorizedActionPackageSource {
  private readonly actorUserId: string;

  constructor(deps: { actorUserId: string; packages?: Pick<AuthorizedActionPackageRepository, 'getVersion'> }) {
    this.actorUserId = requireActor(deps.actorUserId);
    this.packages = deps.packages ?? new AuthorizedActionPackageRepository();
  }
  private readonly packages: Pick<AuthorizedActionPackageRepository, 'getVersion'>;

  async get(request: { packageId: string; packageVersion: number; scope: PackageScope }): Promise<AuthorizedActionPackageSourceDocument | null> {
    if (!isObject(request) || !validIdentity(request)) return null;
    const ctx = abaContext(request.scope, this.actorUserId);
    const record = await this.packages.getVersion(ctx, request.packageId, request.packageVersion);
    if (!inScope(record, request.scope, null)) return null;
    return { document: record.document, digest: record.digest };
  }
}

export class AbaPackageConsumptionRecorder implements PackageConsumptionRecorder {
  private readonly actorUserId: string;
  private readonly packages: Pick<AuthorizedActionPackageRepository, 'getVersion' | 'recordConsumed'>;

  constructor(deps: { actorUserId: string; packages?: Pick<AuthorizedActionPackageRepository, 'getVersion' | 'recordConsumed'> }) {
    this.actorUserId = requireActor(deps.actorUserId);
    this.packages = deps.packages ?? new AuthorizedActionPackageRepository();
  }

  async recordConsumed(request: RecordConsumedRequest): Promise<RecordConsumedResult> {
    if (!isObject(request) || !validIdentity(request) || !isWellFormedDigest(request.digest) || typeof request.receiptId !== 'string' || !UUID.test(request.receiptId)) {
      return { outcome: 'NOT_RECORDABLE', reason: 'NOT_FOUND' };
    }
    const ctx = abaContext(request.scope, this.actorUserId);
    const record = await this.packages.getVersion(ctx, request.packageId, request.packageVersion);
    if (!inScope(record, request.scope, null)) return { outcome: 'NOT_RECORDABLE', reason: 'NOT_FOUND' };
    if (record.digest !== request.digest) return { outcome: 'NOT_RECORDABLE', reason: 'DIGEST_MISMATCH' };
    return this.packages.recordConsumed(ctx, {
      packageId: request.packageId, packageVersion: request.packageVersion, digest: request.digest, receiptId: request.receiptId,
      correlationId: randomUUID(), causationId: request.receiptId,
    });
  }
}
