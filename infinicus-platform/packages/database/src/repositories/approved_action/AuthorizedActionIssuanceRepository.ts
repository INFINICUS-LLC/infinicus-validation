// P0-5 Block 3d - the authoritative-source reader and issuance-audit writer for the ABA package issuer.
//
// This repository READS the upstream approval facts the issuer needs (the authorized action, its decision, the approval
// audit event, the approver's assignment version and authority provenance as of the decision, and the persisted review
// version with its recommendation lineage) and WRITES the issuance / refusal audit event. It decides NOTHING: every
// issuance judgement (authority validity, risk tier, freshness, canonical action type, enablement) belongs to the issuer in
// @infinicus/workflow, which calls this repository inside ONE shared tenant transaction (see withSharedTenantTransaction).
//
// It accepts identifiers only and returns persisted facts; nothing it returns is caller-supplied. It does not read Business
// Operations, emit events, or write a package (AuthorizedActionPackageRepository does that).

import type { TenantContext } from '../../client.js';
import { withTenantTransaction } from '../../client.js';
import { ValidationError } from './errors.js';
import { UUID_PATTERN, iso, lock } from './governanceSupport.js';

const ENTITY = 'AuthorizedActionIssuance';
const S = 'approved_business_action';

/** Audit event types written by the issuer. They are NOT approval decisions and carry their own schema. */
export const PACKAGE_ISSUED_EVENT = 'package.issued';
export const PACKAGE_ISSUANCE_REFUSED_EVENT = 'package.issuance_refused';
export const ISSUANCE_AUDIT_SCHEMA = 'package-issuance-audit/1';

const APPROVAL_DECIDED_EVENTS = ['approval.approved', 'approval.approved_with_modifications'] as const;

export interface IssuanceAction {
  actionId: string;
  businessId: string;
  actionCode: string;
  status: string;
  sourceRecommendationId: string | null;
  /** Latest approved_action_versions row; the package pins this version. */
  actionVersionId: string | null;
}

export interface IssuanceDecision {
  decisionId: string;
  status: string;
  reviewPackageId: string;
  approverAssignmentId: string;
  /** Latest approval_decision_versions row. */
  decisionVersionId: string | null;
}

export interface IssuanceApprovalAudit {
  /** Every approval.approved / approval.approved_with_modifications row for the decision (a decision must have exactly one). */
  events: { id: string; eventType: string; occurredAt: string; detail: Record<string, unknown> }[];
}

export interface IssuanceAssignment {
  assignmentId: string;
  userId: string;
  assignmentCode: string;
  status: string;
  /** The assignment version in force at the decision instant (latest version created at or before it), or null. */
  versionAtDecision: { id: string; versionNumber: number; roleCode: string } | null;
  /** Append-only provenance entries (grant / revoke), oldest first, with their canonical scope ids and database time. */
  provenance: { scopeId: string; createdAt: string; entry: Record<string, unknown> }[];
}

export interface IssuanceReview {
  reviewVersionId: string;
  reviewPackageId: string;
  versionNumber: number;
  sourceRecommendationVersionId: string | null;
  riskClass: string | null;
  isTimeSensitive: boolean | null;
  validUntil: string | null;
  twinSnapshotId: string | null;
  /** From the recommendation version row the review version points at (null when it does not exist). */
  recommendation: { recommendationId: string; recommendationVersionId: string; businessId: string } | null;
}

export interface IssuanceSources {
  action: IssuanceAction;
  decision: IssuanceDecision;
  approvalAudit: IssuanceApprovalAudit;
  assignment: IssuanceAssignment | null;
  /** Null when the audit event names no review version, or that version does not exist for the decision's review. */
  review: IssuanceReview | null;
  /** Database time (millisecond UTC), read AFTER the sources so it is not earlier than any fact above. */
  now: string;
}

export interface IssuanceAuditInput {
  businessId: string;
  decisionId: string | null;
  eventType: typeof PACKAGE_ISSUED_EVENT | typeof PACKAGE_ISSUANCE_REFUSED_EVENT;
  detail: Record<string, unknown>;
}

type Json = Record<string, unknown>;

function requireUuid(label: string, value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new ValidationError(ENTITY, [`${label} must be a lowercase UUID`]);
  return value;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

export class AuthorizedActionIssuanceRepository {
  /**
   * Serializes issuers of one authorized action. Same key as `ensureHeader`, so it is re-entrant inside one transaction and
   * guarantees the whole issuance (read, decide, write) is one critical section per action.
   */
  async lockAction(ctx: TenantContext, actionId: string): Promise<void> {
    requireUuid('actionId', actionId);
    return withTenantTransaction(ctx, async (client) => {
      await lock(client, `authorized_action_package_header:${actionId}`);
    });
  }

  /** Loads every persisted fact the issuer judges. Null when the action does not exist in the caller's scope. */
  async loadSources(ctx: TenantContext, actionId: string): Promise<IssuanceSources | null> {
    requireUuid('actionId', actionId);
    return withTenantTransaction(ctx, async (client) => {
      const a = await client.query<Json>(
        `SELECT a.id, a.business_id, a.action_code, a.status, a.source_recommendation_id, a.decision_id,
                d.status AS decision_status, d.review_package_id, d.approver_assignment_id,
                (SELECT v.id FROM ${S}.approved_action_versions v WHERE v.action_id = a.id ORDER BY v.version_number DESC LIMIT 1) AS action_version_id,
                (SELECT v.id FROM ${S}.approval_decision_versions v WHERE v.decision_id = d.id ORDER BY v.version_number DESC LIMIT 1) AS decision_version_id
           FROM ${S}.approved_actions a JOIN ${S}.approval_decisions d ON d.id = a.decision_id
          WHERE a.id = $1`,
        [actionId],
      );
      if (a.rows.length === 0) return null;
      const row = a.rows[0];
      const decisionId = row.decision_id as string;

      const events = await client.query<Json>(
        `SELECT id, event_type, occurred_at, detail FROM ${S}.approval_audit_events
          WHERE decision_id = $1 AND event_type = ANY($2::text[]) ORDER BY occurred_at, created_at, id`,
        [decisionId, APPROVAL_DECIDED_EVENTS],
      );
      const approvalEvents = events.rows.map((e) => ({
        id: e.id as string, eventType: e.event_type as string, occurredAt: iso(e.occurred_at), detail: asRecord(e.detail),
      }));

      let assignment: IssuanceAssignment | null = null;
      const assignmentRow = await client.query<Json>(
        `SELECT id, user_id, assignment_code, status FROM ${S}.approver_assignments WHERE id = $1`, [row.approver_assignment_id],
      );
      if (assignmentRow.rows.length > 0) {
        const ar = assignmentRow.rows[0];
        const decidedAt = approvalEvents.length === 1 ? approvalEvents[0].occurredAt : null;
        const version = decidedAt === null ? null : (await client.query<Json>(
          `SELECT id, version_number, role_code FROM ${S}.approver_assignment_versions
            WHERE assignment_id = $1 AND created_at <= $2::timestamptz ORDER BY version_number DESC LIMIT 1`,
          [ar.id, decidedAt],
        )).rows[0];
        const provenance = await client.query<Json>(
          `SELECT s.id, s.created_at, s.scope_value
             FROM ${S}.approval_authority_scopes s JOIN ${S}.approver_assignment_versions v ON v.id = s.assignment_version_id
            WHERE v.assignment_id = $1 AND s.scope_type = 'provenance' ORDER BY s.created_at, s.id`,
          [ar.id],
        );
        assignment = {
          assignmentId: ar.id as string, userId: ar.user_id as string, assignmentCode: ar.assignment_code as string, status: ar.status as string,
          versionAtDecision: version ? { id: version.id as string, versionNumber: version.version_number as number, roleCode: version.role_code as string } : null,
          provenance: provenance.rows.map((p) => ({ scopeId: p.id as string, createdAt: iso(p.created_at), entry: asRecord(p.scope_value) })),
        };
      }

      let review: IssuanceReview | null = null;
      const facts = asRecord(approvalEvents.length === 1 ? approvalEvents[0].detail.facts : undefined);
      const reviewVersionId = typeof facts.reviewVersionId === 'string' && UUID_PATTERN.test(facts.reviewVersionId) ? facts.reviewVersionId : null;
      if (reviewVersionId !== null) {
        const r = await client.query<Json>(
          `SELECT v.id, v.review_package_id, v.version_number, v.source_recommendation_version_id, v.risk_class,
                  v.is_time_sensitive, v.valid_until, v.twin_snapshot_id,
                  rv.id AS rec_version_id, rv.recommendation_id, rv.business_id AS rec_business_id
             FROM ${S}.action_review_package_versions v
             LEFT JOIN ai_decision_intelligence.decision_recommendation_versions rv ON rv.id = v.source_recommendation_version_id
            WHERE v.id = $1 AND v.review_package_id = $2`,
          [reviewVersionId, row.review_package_id],
        );
        if (r.rows.length > 0) {
          const v = r.rows[0];
          review = {
            reviewVersionId: v.id as string, reviewPackageId: v.review_package_id as string, versionNumber: v.version_number as number,
            sourceRecommendationVersionId: (v.source_recommendation_version_id as string | null) ?? null,
            riskClass: (v.risk_class as string | null) ?? null,
            isTimeSensitive: (v.is_time_sensitive as boolean | null) ?? null,
            validUntil: v.valid_until === null ? null : iso(v.valid_until),
            twinSnapshotId: (v.twin_snapshot_id as string | null) ?? null,
            recommendation: v.rec_version_id
              ? { recommendationId: v.recommendation_id as string, recommendationVersionId: v.rec_version_id as string, businessId: v.rec_business_id as string }
              : null,
          };
        }
      }

      const clock = await client.query<{ now: string }>(
        `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`,
      );

      return {
        action: {
          actionId: row.id as string, businessId: row.business_id as string, actionCode: row.action_code as string, status: row.status as string,
          sourceRecommendationId: (row.source_recommendation_id as string | null) ?? null,
          actionVersionId: (row.action_version_id as string | null) ?? null,
        },
        decision: {
          decisionId, status: row.decision_status as string, reviewPackageId: row.review_package_id as string,
          approverAssignmentId: row.approver_assignment_id as string, decisionVersionId: (row.decision_version_id as string | null) ?? null,
        },
        approvalAudit: { events: approvalEvents },
        assignment,
        review,
        now: clock.rows[0].now,
      };
    });
  }

  /** Appends one issuance / refusal audit event and returns its id. Joins the issuance transaction when called inside one. */
  async recordAudit(ctx: TenantContext, input: IssuanceAuditInput): Promise<string> {
    requireUuid('businessId', input.businessId);
    if (input.decisionId !== null) requireUuid('decisionId', input.decisionId);
    return withTenantTransaction(ctx, async (client) => {
      const detail = { schema: ISSUANCE_AUDIT_SCHEMA, eventType: input.eventType, ...input.detail };
      const result = await client.query<{ id: string }>(
        `INSERT INTO ${S}.approval_audit_events (tenant_id, workspace_id, business_id, decision_id, event_type, detail)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [ctx.tenantId, ctx.workspaceId, input.businessId, input.decisionId, input.eventType, JSON.stringify(detail)],
      );
      return result.rows[0].id;
    });
  }
}
