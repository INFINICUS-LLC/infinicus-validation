/**
 * Live-database fixtures for the P0-5 Block 3d issuer tests. Test-only.
 *
 * Upstream rows (assignment, review, recommendation, decision, audit event, approved action) are written directly by an
 * admin pool with FK/trigger checks of the UPSTREAM tables bypassed (as the 3a-3c fixtures do). Everything the issuer
 * depends on in ABA's own new tables (action type, Level 2 policy, capture, owner, boundaries) is created through the real
 * repositories, so their database guards are exercised too.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- fixtures build arbitrary JSON documents */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  ActionTypeRegistryRepository, AuthorizedActionBoundaryRepository, AuthorizedActionCaptureRepository, AutomationLevelPolicyRepository,
  type TenantContext,
} from '@infinicus/database';
import { INVENTORY_REORDER_POLICY_UPDATE_V1 } from '@infinicus/handoff-contracts';
import type { ActionTypeContract } from '@infinicus/handoff-contracts';

export const S = 'approved_business_action';
export const HOUR = 3_600_000;
export const iso = (d: Date): string => d.toISOString();
export const G = <V>(value: V) => ({ state: 'VALUE' as const, value });
export const NA = (code = 'NOT_NEEDED', statement = 'not applicable here') => ({ state: 'NOT_APPLICABLE' as const, reason: { code, statement } });

export interface World { tenantId: string; workspaceId: string }

export async function makeWorld(admin: Pool): Promise<World> {
  const w = { tenantId: randomUUID(), workspaceId: randomUUID() };
  const slug = `t${w.tenantId.slice(0, 8)}`;
  await admin.query('INSERT INTO tenancy.tenants (id, name, slug) VALUES ($1,$2,$3)', [w.tenantId, slug, slug]);
  await admin.query('INSERT INTO tenancy.workspaces (id, tenant_id, name, slug) VALUES ($1,$2,$3,$4)', [w.workspaceId, w.tenantId, slug, slug]);
  return w;
}

async function makeUser(admin: Pool): Promise<string> {
  const id = randomUUID();
  await admin.query('INSERT INTO identity.users (id, email) VALUES ($1, $2)', [id, `u-${id}@example.test`]);
  return id;
}

async function makeMembership(admin: Pool, w: World, userId: string): Promise<string> {
  const id = randomUUID();
  await admin.query('INSERT INTO tenancy.memberships (id, tenant_id, workspace_id, user_id, status) VALUES ($1,$2,$3,$4,$5)', [id, w.tenantId, w.workspaceId, userId, 'active']);
  return id;
}

export interface FixtureOptions {
  decisionStatus?: 'approved' | 'approved_with_modifications';
  roleCode?: string;
  riskClass?: string | null;
  isTimeSensitive?: boolean | null;
  validUntil?: Date | null;
  /** Creates a published Twin snapshot for the review (true), plus a newer published one when 'stale'. */
  twin?: false | 'fresh' | 'stale';
  /** Decision time. Defaults to a minute ago so issuance is strictly later. */
  decidedAt?: Date;
  omitCapture?: boolean;
  omitOwner?: boolean;
  omitBoundaries?: boolean;
  omitAuditEvent?: boolean;
  /** Registration of the canonical type in the workspace: ACTIVE (default), 'draft' (never activated), 'retired', or 'none'. */
  registration?: 'active' | 'draft' | 'retired' | 'none';
  /** Overrides applied to the workspace copy of the canonical contract (a divergence). */
  registryDivergence?: (c: any) => void;
  /** Automation levels with an ENABLED policy (default [2]). */
  enabledLevels?: 2[];
  /** The Level 2 policy specification (default: covers the canonical type). */
  policySpecification?: Record<string, unknown> | null;
  /** The canonical contract to register in the workspace (default: the platform's inventory contract). */
  contract?: ActionTypeContract;
  revokeAuthorityAfterDecision?: boolean;
  noGrantProvenance?: boolean;
  /** Authority granted AFTER the decision (no authority at decision time). */
  grantAfterDecision?: boolean;
  window?: any;
  preconditions?: any;
  budget?: any;
  rollback?: any;
  monitoring?: any;
  simulationRun?: any;
  /** Overrides for the capture input. */
  capture?: (c: any) => void;
  modified?: boolean;
  /** Replace the approval audit permission field. */
  permissionUsed?: string | null;
  /** Free-text description of the approved action version (must never reach a package). */
  actionDescription?: string;
}

export interface IssuableFixture {
  ctx: TenantContext;
  world: World;
  businessId: string;
  actionId: string;
  decisionId: string;
  decisionVersionId: string;
  reviewPackageId: string;
  reviewVersionId: string;
  assignmentId: string;
  assignmentVersionId: string;
  grantScopeId: string;
  approvalAuditEventId: string;
  recommendationId: string;
  recommendationVersionId: string;
  approverUserId: string;
  ownerUserId: string;
  twinSnapshotId: string | null;
  decidedAt: Date;
  captureId: string | null;
  definitionId: string | null;
}

const types = new ActionTypeRegistryRepository();
const policies = new AutomationLevelPolicyRepository();
const captures = new AuthorizedActionCaptureRepository();
const boundaries = new AuthorizedActionBoundaryRepository();

export async function makeIssuable(admin: Pool, world: World, o: FixtureOptions = {}): Promise<IssuableFixture> {
  const contract = o.contract ?? INVENTORY_REORDER_POLICY_UPDATE_V1;
  const approverUserId = await makeUser(admin);
  const ownerUserId = await makeUser(admin);
  const ownerMembershipId = await makeMembership(admin, world, ownerUserId);
  const ctx: TenantContext = { tenantId: world.tenantId, workspaceId: world.workspaceId, userId: approverUserId };
  const decidedAt = o.decidedAt ?? new Date(Date.now() - 60_000);
  const before = new Date(decidedAt.getTime() - 60_000);
  const decisionStatus = o.decisionStatus ?? (o.modified ? 'approved_with_modifications' : 'approved');
  const f = {
    businessId: randomUUID(), actionId: randomUUID(), decisionId: randomUUID(), decisionVersionId: randomUUID(),
    reviewPackageId: randomUUID(), reviewVersionId: randomUUID(), assignmentId: randomUUID(), assignmentVersionId: randomUUID(),
    grantScopeId: randomUUID(), approvalAuditEventId: randomUUID(), recommendationId: randomUUID(), recommendationVersionId: randomUUID(),
    actionVersionId: randomUUID(),
  };
  const code = randomUUID().slice(0, 12);

  let twinSnapshotId: string | null = null;
  const c = await admin.connect();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL session_replication_role = 'replica'");
    await c.query('INSERT INTO platform.businesses (id, tenant_id, workspace_id, legal_name, business_code) VALUES ($1,$2,$3,$4,$5)', [f.businessId, world.tenantId, world.workspaceId, code, code]);
    const scopeIds = [world.tenantId, world.workspaceId, f.businessId];

    // approver assignment + the version in force at the decision + canonical provenance
    await c.query(`INSERT INTO ${S}.approver_assignments (id, tenant_id, workspace_id, business_id, user_id, assignment_code, status, latest_version) VALUES ($1,$2,$3,$4,$5,$6,$7,1)`,
      [f.assignmentId, ...scopeIds, approverUserId, `approver-${code}`, o.revokeAuthorityAfterDecision ? 'revoked' : 'active']);
    await c.query(`INSERT INTO ${S}.approver_assignment_versions (id, tenant_id, workspace_id, business_id, assignment_id, version_number, role_code, created_at) VALUES ($1,$2,$3,$4,$5,1,$6,$7)`,
      [f.assignmentVersionId, ...scopeIds, f.assignmentId, o.roleCode ?? 'business-owner', before]);
    const grant = (at: Date) => ({
      action: 'grant', source: 'manual-admin', businessId: f.businessId, assignmentId: f.assignmentId, assignmentCode: `approver-${code}`,
      granteeUserId: approverUserId, state: 'active', actor: { type: 'user', id: ownerUserId, authority: 'aba:admin' }, at: iso(at), correlationId: null, proof: null, reason: null,
    });
    if (!o.noGrantProvenance) {
      await c.query(`INSERT INTO ${S}.approval_authority_scopes (id, tenant_id, workspace_id, business_id, assignment_version_id, scope_type, scope_value, created_at) VALUES ($1,$2,$3,$4,$5,'provenance',$6,$7)`,
        [f.grantScopeId, ...scopeIds, f.assignmentVersionId, JSON.stringify(grant(before)), o.grantAfterDecision ? new Date(decidedAt.getTime() + 1000) : before]);
    }
    if (o.revokeAuthorityAfterDecision) {
      await c.query(`INSERT INTO ${S}.approval_authority_scopes (tenant_id, workspace_id, business_id, assignment_version_id, scope_type, scope_value, created_at) VALUES ($1,$2,$3,$4,'provenance',$5,$6)`,
        [...scopeIds, f.assignmentVersionId, JSON.stringify({ ...grant(decidedAt), action: 'revoke', state: 'revoked', reason: 'left the company' }), new Date(decidedAt.getTime() + 5000)]);
    }

    // recommendation lineage
    await c.query(`INSERT INTO ai_decision_intelligence.decision_recommendations (id, tenant_id, workspace_id, business_id, case_id, recommendation_code) VALUES ($1,$2,$3,$4,$5,$6)`,
      [f.recommendationId, ...scopeIds, randomUUID(), `rec-${code}`]);
    await c.query(`INSERT INTO ai_decision_intelligence.decision_recommendation_versions (id, tenant_id, workspace_id, business_id, recommendation_id, version_number, summary) VALUES ($1,$2,$3,$4,$5,1,'fixture')`,
      [f.recommendationVersionId, ...scopeIds, f.recommendationId]);

    // Twin snapshot (published) and, for 'stale', a newer published one
    if (o.twin) {
      const instanceId = randomUUID();
      twinSnapshotId = randomUUID();
      await c.query(`INSERT INTO business_digital_twin.digital_twin_snapshots (id, tenant_id, workspace_id, business_id, instance_id, snapshot_code, status, effective_at) VALUES ($1,$2,$3,$4,$5,$6,'published',$7)`,
        [twinSnapshotId, ...scopeIds, instanceId, `snap-${code}`, new Date(decidedAt.getTime() - HOUR)]);
      if (o.twin === 'stale') {
        await c.query(`INSERT INTO business_digital_twin.digital_twin_snapshots (id, tenant_id, workspace_id, business_id, instance_id, snapshot_code, status, effective_at) VALUES ($1,$2,$3,$4,$5,$6,'published',$7)`,
          [randomUUID(), ...scopeIds, instanceId, `snap2-${code}`, new Date(Date.now() - 1000)]);
      }
    }

    // review package + the version the decision was made on
    await c.query(`INSERT INTO ${S}.action_review_packages (id, tenant_id, workspace_id, business_id, intake_package_id, review_code) VALUES ($1,$2,$3,$4,$5,$6)`,
      [f.reviewPackageId, ...scopeIds, randomUUID(), `review-${code}`]);
    const validUntil = o.validUntil === undefined ? new Date(Date.now() + 24 * HOUR) : o.validUntil;
    await c.query(
      `INSERT INTO ${S}.action_review_package_versions (id, tenant_id, workspace_id, business_id, review_package_id, version_number, summary,
          source_recommendation_version_id, risk_class, is_time_sensitive, valid_until, twin_snapshot_id) VALUES ($1,$2,$3,$4,$5,1,'fixture',$6,$7,$8,$9,$10)`,
      [f.reviewVersionId, ...scopeIds, f.reviewPackageId, f.recommendationVersionId,
        o.riskClass === undefined ? 'medium' : o.riskClass, o.isTimeSensitive === undefined ? true : o.isTimeSensitive, validUntil, twinSnapshotId]);

    // decision (+ version) and approved action (+ version)
    await c.query(`INSERT INTO ${S}.approval_decisions (id, tenant_id, workspace_id, business_id, review_package_id, approver_assignment_id, decision_code, status, latest_version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1)`,
      [f.decisionId, ...scopeIds, f.reviewPackageId, f.assignmentId, `d-${code}`, decisionStatus]);
    await c.query(`INSERT INTO ${S}.approval_decision_versions (id, tenant_id, workspace_id, business_id, decision_id, version_number, summary, status) VALUES ($1,$2,$3,$4,$5,1,'fixture',$6)`,
      [f.decisionVersionId, ...scopeIds, f.decisionId, decisionStatus]);
    await c.query(`INSERT INTO ${S}.approved_actions (id, tenant_id, workspace_id, business_id, decision_id, action_code, source_recommendation_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [f.actionId, ...scopeIds, f.decisionId, `a-${code}`, f.recommendationId]);
    await c.query(`INSERT INTO ${S}.approved_action_versions (id, tenant_id, workspace_id, business_id, action_id, version_number, description) VALUES ($1,$2,$3,$4,$5,1,$6)`,
      [f.actionVersionId, ...scopeIds, f.actionId, o.actionDescription ?? 'fixture']);

    // the approval audit event (approval-audit/1), exactly as buildApprovalAuditDetail writes it
    if (!o.omitAuditEvent) {
      const detail = {
        schema: 'approval-audit/1', eventType: `approval.${decisionStatus}`, approvalType: decisionStatus === 'approved' ? 'approve' : 'approve_with_modifications',
        decisionId: f.decisionId, decisionVersionId: f.decisionVersionId, reviewPackageId: f.reviewPackageId, businessId: f.businessId,
        approver: { userId: approverUserId, assignmentId: f.assignmentId, assignmentCode: `approver-${code}`, roleCode: o.roleCode ?? 'business-owner' },
        priorState: 'draft', newState: decisionStatus, reason: null, reasonCodes: [],
        permissionUsed: o.permissionUsed === undefined ? 'aba:approve' : o.permissionUsed, correlationId: null,
        facts: {
          reviewVersionId: f.reviewVersionId, sourceRecommendationVersionId: f.recommendationVersionId,
          riskClass: o.riskClass === undefined ? 'medium' : o.riskClass, isTimeSensitive: o.isTimeSensitive === undefined ? true : o.isTimeSensitive,
          validUntil: validUntil ? validUntil.toISOString() : null, twinSnapshotId,
        },
        actionId: null, modifiedParameters: null, simulationRunId: null, modelVersion: null,
        unavailable: ['actionId', 'modifiedParameters', 'simulationRunId', 'modelVersion'],
      };
      await c.query(`INSERT INTO ${S}.approval_audit_events (id, tenant_id, workspace_id, business_id, decision_id, event_type, detail, occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [f.approvalAuditEventId, ...scopeIds, f.decisionId, `approval.${decisionStatus}`, JSON.stringify(detail), decidedAt]);
    }
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }

  // ---- ABA governance state, through the real repositories ------------------------------------------------------------
  let definitionId: string | null = null;
  const workspaceCopy: any = JSON.parse(JSON.stringify(contract));
  o.registryDivergence?.(workspaceCopy);
  if (o.registration !== 'none') {
    const def = await types.define(ctx, {
      code: workspaceCopy.code, schemaVersion: workspaceCopy.schemaVersion, targetKinds: workspaceCopy.targetKinds, parameters: workspaceCopy.parameters,
      governanceImpact: workspaceCopy.governanceImpact, applicability: workspaceCopy.applicability, definedByUserId: approverUserId, correlationId: randomUUID(),
    });
    definitionId = def.id;
    if (o.registration !== 'draft') await types.activate(ctx, def.id, { actorUserId: approverUserId, correlationId: randomUUID() });
  }

  for (const level of o.enabledLevels ?? [2]) {
    const { policy, version } = await policies.createPolicy(ctx, {
      policyCode: `l${level}_${randomUUID().replace(/-/g, '').slice(0, 10)}`, automationLevel: level, description: 'fixture policy',
      specification: (o.policySpecification === undefined
        ? { [`actionTypes`]: [{ code: contract.code, schemaVersion: contract.schemaVersion }] }
        : (o.policySpecification ?? {})),
      createdByUserId: approverUserId, correlationId: randomUUID(),
    } as any);
    void policy;
    await policies.enable(ctx, version.id, { actorUserId: approverUserId, reason: 'fixture', correlationId: randomUUID() });
  }

  let captureId: string | null = null;
  if (!o.omitCapture) {
    const proposed = { reorderPoint: 10, reorderQuantity: 50 };
    const base: any = {
      businessId: f.businessId, actionId: f.actionId, decisionId: f.decisionId, decisionVersionId: f.decisionVersionId, decisionStatus,
      actionType: { code: contract.code, schemaVersion: contract.schemaVersion }, target: { kind: contract.targetKinds[0], id: 'sku-123' },
      proposed: G({ source: { layer: 'ADI', recordType: 'decision_recommendation_version', recordId: f.recommendationVersionId }, parameters: proposed }),
      modification: NA('PLAIN_APPROVAL', 'Approved as proposed.'), modificationEvaluation: NA('NO_MODIFICATION', 'No modification to evaluate.'),
      finalParameters: proposed, capturedByUserId: approverUserId, correlationId: randomUUID(),
    };
    if (o.modified) {
      const modifiedAt = new Date(decidedAt.getTime() - 1000);
      base.modification = G({
        reason: 'Raise the safety stock.', modifiedByUserId: approverUserId, modifiedAt: iso(modifiedAt),
        changes: [{ parameter: 'reorderPoint', operation: 'SET', before: 10, after: 15 }, { parameter: 'reorderQuantity', operation: 'SET', before: 50, after: 60 }],
      });
      base.modificationEvaluation = G({
        basis: 'DECLARED_IMPACT',
        evidence: ['CONSTRAINTS', 'RESOURCE_REQUIREMENTS', 'EXPECTED_OUTCOME', 'COST'].map((dimension) => ({
          dimension, evaluatedAt: iso(new Date(modifiedAt.getTime() + 500)), result: 'PASSED', evidenceRef: { kind: 'simulation_run', id: 'run-1' },
        })),
      });
      base.finalParameters = { reorderPoint: 15, reorderQuantity: 60 };
    }
    o.capture?.(base);
    captureId = (await captures.recordCapture(ctx, base)).id;
  }
  if (!o.omitOwner) {
    await captures.assignOwner(ctx, {
      businessId: f.businessId, actionId: f.actionId, owner: { userId: ownerUserId, membershipId: ownerMembershipId },
      roleCode: 'operations_lead', assignedByUserId: approverUserId, dueAt: G(iso(new Date(Date.now() + 7 * 24 * HOUR))),
      escalationPolicy: G({ ref: 'policy:default-escalation' }), correlationId: randomUUID(),
    });
  }
  if (!o.omitBoundaries && captureId) {
    await boundaries.recordBoundaries(ctx, {
      businessId: f.businessId, actionId: f.actionId, captureId,
      executionWindow: o.window ?? G({ startsAt: iso(new Date(Date.now() + HOUR)), endsAt: iso(new Date(Date.now() + 8 * HOUR)) }),
      preconditions: o.preconditions ?? G([{ code: 'stock_available', operator: 'gte', operand: 1 }]),
      budget: o.budget ?? G({ amount: '250.00', currency: 'USD' }),
      rollback: o.rollback ?? G({ instructions: 'Restore the previous reorder policy.' }),
      monitoring: o.monitoring ?? G({ metrics: [{ metricCode: 'stockouts', target: 0, unit: 'count' }] }),
      simulationRun: o.simulationRun ?? G(randomUUID()),
      authoredByUserId: approverUserId, correlationId: randomUUID(),
    } as any);
  }

  if (o.registration === 'retired' && definitionId) await types.retire(ctx, definitionId, { actorUserId: approverUserId, reason: 'superseded', correlationId: randomUUID() });

  return {
    ctx, world, businessId: f.businessId, actionId: f.actionId, decisionId: f.decisionId, decisionVersionId: f.decisionVersionId,
    reviewPackageId: f.reviewPackageId, reviewVersionId: f.reviewVersionId, assignmentId: f.assignmentId, assignmentVersionId: f.assignmentVersionId,
    grantScopeId: f.grantScopeId, approvalAuditEventId: f.approvalAuditEventId, recommendationId: f.recommendationId,
    recommendationVersionId: f.recommendationVersionId, approverUserId, ownerUserId, twinSnapshotId, decidedAt, captureId, definitionId,
  };
}
