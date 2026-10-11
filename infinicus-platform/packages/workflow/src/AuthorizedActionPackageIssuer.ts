/**
 * ABA AuthorizedActionPackage issuer (P0-5 Block 3d) - the ONE component allowed to seal and persist a package.
 *
 * It accepts identifiers only (tenant context + authorized action id [+ an optional trace correlation id]). It loads every
 * authoritative fact server-side, judges them with the pure policy in packageIssuancePolicy.ts, seals through the Block 2
 * contract, validates the sealed package, and - in ONE shared tenant transaction - writes the issuance audit and persists
 * the package version. Any failure rolls the whole issuance back; a refusal is audited afterwards in its own transaction so
 * the reason is preserved.
 *
 * It does NOT emit ACTION_AUTHORIZED, call Business Operations, expose a consumption path, or touch P0-1..P0-4 approval
 * behaviour. Idempotent: the same authoritative inputs return the existing package; changed inputs issue the next version,
 * which atomically supersedes the previous one (never an overwrite).
 */

import { randomUUID } from 'node:crypto';
import {
  AuthorizedActionBoundaryRepository, AuthorizedActionCaptureRepository, AuthorizedActionIssuanceRepository,
  AuthorizedActionPackageRepository, ActionTypeRegistryRepository, AutomationLevelPolicyRepository, DigitalTwinSnapshotRepository,
  PACKAGE_ISSUANCE_REFUSED_EVENT, PACKAGE_ISSUED_EVENT, toAccountableOwnerShape, withSharedTenantTransaction,
} from '@infinicus/database';
import type { PackageVersionRecord, TenantContext } from '@infinicus/database';
import {
  AuthorizedActionPackageInvalidError, canonicalActionTypeRegistry, sealAuthorizedActionPackage, validateAuthorizedActionPackage,
} from '@infinicus/handoff-contracts';
import type { ActionTypeRegistry, AuthorizedActionPackageV1 } from '@infinicus/handoff-contracts';
import {
  ISSUANCE_ENABLEMENT, authoritativeInputsKey, evaluateIssuance, notApplicableCodeProblems,
} from './packageIssuancePolicy.js';
import type { IssuanceFacts, IssuanceRefusal, IssuanceRefusalCode } from './packageIssuancePolicy.js';
import type { TwinFreshness } from './approvalGate.js';

const LEVEL_2 = 2 as const;

/** The only input an issuance request carries. Authorization facts and parameters are never accepted from the caller. */
export interface IssuePackageRequest {
  actionId: string;
  /** Optional trace id only; it carries no authority. A fresh one is generated when absent. */
  correlationId?: string;
}

export interface IssuePackageResult {
  /** ISSUED = a new package version was written; REPLAYED = the identical authoritative inputs returned the existing package. */
  outcome: 'ISSUED' | 'REPLAYED';
  package: AuthorizedActionPackageV1;
  record: PackageVersionRecord;
  /** The issuance audit event (null on replay: nothing new was issued). */
  issuanceAuditEventId: string | null;
}

export class PackageIssuanceRefusedError extends Error {
  /** False when the refusal itself could not be audited (e.g. the action does not exist, so no business can be attributed). */
  refusalAudited = false;
  constructor(readonly refusals: readonly IssuanceRefusal[], readonly scope: { businessId: string; decisionId: string } | null = null, options?: { cause?: unknown }) {
    super(`package issuance refused (${refusals.map((r) => r.code).join(', ')}): ${refusals.map((r) => r.message).join('; ')}`, options);
    this.name = 'PackageIssuanceRefusedError';
  }
  get codes(): IssuanceRefusalCode[] { return this.refusals.map((r) => r.code); }
}

export interface IssuerDependencies {
  issuance: AuthorizedActionIssuanceRepository;
  packages: AuthorizedActionPackageRepository;
  captures: AuthorizedActionCaptureRepository;
  boundaries: AuthorizedActionBoundaryRepository;
  actionTypes: ActionTypeRegistryRepository;
  policies: AutomationLevelPolicyRepository;
  twin: Pick<DigitalTwinSnapshotRepository, 'assessFreshness'>;
  /** The canonical platform vocabulary (shared-contract truth). Tests may inject extra canonical types. */
  canonicalTypes: ActionTypeRegistry;
}

const defaults = (): IssuerDependencies => ({
  issuance: new AuthorizedActionIssuanceRepository(),
  packages: new AuthorizedActionPackageRepository(),
  captures: new AuthorizedActionCaptureRepository(),
  boundaries: new AuthorizedActionBoundaryRepository(),
  actionTypes: new ActionTypeRegistryRepository(),
  policies: new AutomationLevelPolicyRepository(),
  twin: new DigitalTwinSnapshotRepository(),
  canonicalTypes: canonicalActionTypeRegistry(),
});

export class AuthorizedActionPackageIssuer {
  private readonly deps: IssuerDependencies;

  constructor(deps: Partial<IssuerDependencies> = {}) {
    this.deps = { ...defaults(), ...deps };
  }

  async issue(ctx: TenantContext, request: IssuePackageRequest): Promise<IssuePackageResult> {
    const correlationId = request.correlationId ?? randomUUID();
    try {
      return await withSharedTenantTransaction(ctx, () => this.issueInTransaction(ctx, request.actionId, correlationId));
    } catch (error) {
      const refusal = error instanceof PackageIssuanceRefusedError
        ? error
        : new PackageIssuanceRefusedError(
          [{ code: 'PERSISTENCE_FAILED', message: error instanceof Error ? error.message : 'issuance failed' }],
          null,
          { cause: error },
        );
      await this.auditRefusal(ctx, request.actionId, correlationId, refusal);
      throw refusal;
    }
  }

  /** The refusal is audited AFTER the issuance transaction rolled back, in its own transaction, so its reason survives. */
  private async auditRefusal(ctx: TenantContext, actionId: string, correlationId: string, refusal: PackageIssuanceRefusedError): Promise<void> {
    if (!refusal.scope) return; // no attributable business (unknown action): nothing to attach an audit row to
    try {
      await this.deps.issuance.recordAudit(ctx, {
        businessId: refusal.scope.businessId,
        decisionId: refusal.scope.decisionId,
        eventType: PACKAGE_ISSUANCE_REFUSED_EVENT,
        detail: { actionId, correlationId, refusals: refusal.refusals.map((r) => ({ code: r.code, message: r.message })) },
      });
      refusal.refusalAudited = true;
    } catch {
      refusal.refusalAudited = false;
    }
  }

  private async issueInTransaction(ctx: TenantContext, actionId: string, correlationId: string): Promise<IssuePackageResult> {
    const d = this.deps;
    await d.issuance.lockAction(ctx, actionId);
    const sources = await d.issuance.loadSources(ctx, actionId);
    if (!sources) throw new PackageIssuanceRefusedError([{ code: 'ACTION_NOT_FOUND', message: 'the authorized action does not exist in this scope' }]);
    const scope = { businessId: sources.action.businessId, decisionId: sources.decision.decisionId };
    const refused = (refusals: IssuanceRefusal[], cause?: unknown): PackageIssuanceRefusedError => new PackageIssuanceRefusedError(refusals, scope, { cause });

    try {
      const header = await d.packages.ensureHeader(ctx, { businessId: scope.businessId, actionId, decisionId: scope.decisionId });
      const latest = await d.packages.getLatestVersion(ctx, header.id);

      const capture = await d.captures.getCaptureByActionId(ctx, actionId);
      const owner = await d.captures.getCurrentOwner(ctx, actionId);
      const boundaries = await d.boundaries.getCurrent(ctx, actionId);
      const registered = capture ? await d.actionTypes.get(ctx, capture.actionType.code, capture.actionType.schemaVersion) : null;
      const effective = await d.policies.getEffectivePolicy(ctx, LEVEL_2);
      const policyVersion = effective ? await d.policies.getVersion(ctx, effective.policyVersionId) : null;
      let twin: TwinFreshness | null = null;
      if (sources.review?.twinSnapshotId) twin = await d.twin.assessFreshness(ctx, scope.businessId, sources.review.twinSnapshotId);

      const facts: IssuanceFacts = {
        tenantId: ctx.tenantId, workspaceId: ctx.workspaceId, sources, capture, owner,
        ownerShape: owner ? toAccountableOwnerShape(owner) : null,
        boundaries, registered,
        level2Policy: effective && policyVersion ? { effective, specification: policyVersion.specification } : null,
        twin, canonicalTypes: d.canonicalTypes, packageId: header.id,
        packageVersion: latest ? latest.packageVersion + 1 : 1,
        supersedes: latest ? { packageId: header.id, packageVersion: latest.packageVersion } : null,
        correlationId,
      };

      const evaluation = evaluateIssuance(facts);
      if (!evaluation.ok) throw refused(evaluation.refusals);

      const validation = { actionTypes: d.canonicalTypes, enablement: ISSUANCE_ENABLEMENT };
      let existing: AuthorizedActionPackageV1 | null = null;
      if (latest) {
        // A tampered stored package is never replayed, and never silently superseded.
        const stored = validateAuthorizedActionPackage(latest.document, validation);
        if (!stored.valid) {
          throw refused([{ code: 'STORED_PACKAGE_INVALID', message: `the stored package v${latest.packageVersion} fails validation: ${stored.errors.map((e) => `${e.code}@${e.path}`).join(', ')}` }]);
        }
        existing = latest.document as unknown as AuthorizedActionPackageV1;
      }

      if (latest && existing && authoritativeInputsKey(evaluation.candidate) === authoritativeInputsKey(existing)) {
        const status = await d.packages.getAuthoritativeStatus(ctx, header.id, latest.packageVersion);
        if (status?.lifecycle !== 'ISSUED') {
          throw refused([{ code: 'EXISTING_PACKAGE_NOT_REPLAYABLE', message: `the identical package v${latest.packageVersion} is ${status?.lifecycle ?? 'unknown'}; it is not re-issued` }]);
        }
        return { outcome: 'REPLAYED', package: existing, record: latest, issuanceAuditEventId: null };
      }

      if (latest) {
        const lifecycle = await d.packages.listLifecycle(ctx, header.id, latest.packageVersion);
        const terminal = lifecycle.find((e) => e.state !== 'ISSUED');
        if (terminal) throw refused([{ code: 'SUPERSESSION_BLOCKED', message: `package v${latest.packageVersion} is ${terminal.state}; it cannot be superseded` }]);
      }

      let sealed: AuthorizedActionPackageV1;
      try {
        sealed = sealAuthorizedActionPackage(evaluation.candidate, { ...validation, now: sources.now });
      } catch (error) {
        if (error instanceof AuthorizedActionPackageInvalidError) {
          throw refused(error.errors.map((e) => ({ code: 'PACKAGE_INVALID' as const, message: `${e.code} at ${e.path}: ${e.message}` })));
        }
        throw error;
      }
      const reasonProblems = notApplicableCodeProblems(sealed);
      if (reasonProblems.length > 0) throw refused(reasonProblems.map((message) => ({ code: 'NOT_APPLICABLE_REASON_CODE_INVALID' as const, message })));

      // Audit first, then the package: either failing rolls BOTH back (one shared transaction).
      let auditId: string;
      try {
        auditId = await d.issuance.recordAudit(ctx, {
          businessId: scope.businessId, decisionId: scope.decisionId, eventType: PACKAGE_ISSUED_EVENT,
          detail: {
            actionId, decisionId: scope.decisionId, approvalAuditEventId: evaluation.approvalAuditEventId,
            packageId: sealed.identity.packageId, packageVersion: sealed.identity.packageVersion, digest: sealed.integrity.digest,
            supersedes: sealed.identity.supersedes, automationLevel: sealed.action.automationLevel,
            actionType: sealed.action.type, simulationRunId: sealed.lineage.simulationRunId,
            modification: sealed.lineage.modification, issuerComponent: sealed.issuance.issuerComponent, correlationId,
          },
        });
      } catch (error) {
        throw refused([{ code: 'AUDIT_FAILED', message: error instanceof Error ? error.message : 'issuance audit failed' }], error);
      }
      let record: PackageVersionRecord;
      try {
        record = await d.packages.insertVersion(ctx, sealed);
      } catch (error) {
        throw refused([{ code: 'PERSISTENCE_FAILED', message: error instanceof Error ? error.message : 'package persistence failed' }], error);
      }
      return { outcome: 'ISSUED', package: sealed, record, issuanceAuditEventId: auditId };
    } catch (error) {
      if (error instanceof PackageIssuanceRefusedError) throw error;
      throw refused([{ code: 'PERSISTENCE_FAILED', message: error instanceof Error ? error.message : 'issuance failed' }], error);
    }
  }
}
