import { randomUUID } from 'crypto';
import type { TenantContext } from '../../client.js';
import { withTenantTransaction } from '../../client.js';
import { ActionReviewNotFoundError, ValidationError } from './errors.js';

export interface ActionReviewPackage {
  id: string;
  tenantId: string;
  workspaceId: string;
  businessId: string;
  intakePackageId: string;
  reviewCode: string;
  status: string;
  latestVersion: number;
}

/** Snapshot of the published ADI risk/validity facts, copied at review-version creation (P0-3). ABA never authors these. */
export interface ReviewVersionSnapshot {
  sourceRecommendationVersionId: string | null;
  riskClass: 'low' | 'medium' | 'high' | 'critical' | null;
  isTimeSensitive: boolean | null;
  validUntil: Date | null;
  twinSnapshotId: string | null;
}

export interface ActionReviewVersion extends ReviewVersionSnapshot {
  id: string;
  reviewPackageId: string;
  versionNumber: number;
  summary: string;
}

const RISK_CLASS_VALUES = new Set(['low', 'medium', 'high', 'critical']);

const VALID_STATUSES = ['draft', 'in_review', 'completed', 'cancelled'];
const EVIDENCE_TYPES = new Set(['adi_recommendation', 'simulation_result', 'business_intelligence_finding', 'external', 'other']);

function rowToReview(row: Record<string, unknown>): ActionReviewPackage {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    workspaceId: row.workspace_id as string,
    businessId: row.business_id as string,
    intakePackageId: row.intake_package_id as string,
    reviewCode: row.review_code as string,
    status: row.status as string,
    latestVersion: row.latest_version as number,
  };
}

export class ActionReviewRepository {
  async createReviewPackage(ctx: TenantContext, businessId: string, intakePackageId: string, reviewCode: string): Promise<ActionReviewPackage> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `INSERT INTO approved_business_action.action_review_packages (tenant_id, workspace_id, business_id, intake_package_id, review_code)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [ctx.tenantId, ctx.workspaceId, businessId, intakePackageId, reviewCode]
      );
      return rowToReview(result.rows[0]);
    });
  }

  async createVersion(
    ctx: TenantContext, reviewPackageId: string, businessId: string, summary: string, snapshot?: Partial<ReviewVersionSnapshot>
  ): Promise<{ id: string; versionNumber: number }> {
    const facts: ReviewVersionSnapshot = {
      sourceRecommendationVersionId: snapshot?.sourceRecommendationVersionId ?? null,
      riskClass: snapshot?.riskClass ?? null,
      isTimeSensitive: snapshot?.isTimeSensitive ?? null,
      validUntil: snapshot?.validUntil ?? null,
      twinSnapshotId: snapshot?.twinSnapshotId ?? null,
    };
    if (facts.riskClass !== null && !RISK_CLASS_VALUES.has(facts.riskClass)) {
      throw new ValidationError('ActionReviewPackageVersion', [`unknown risk_class: ${String(facts.riskClass)}`]);
    }
    return withTenantTransaction(ctx, async (client) => {
      const r = await client.query<Record<string, unknown>>('SELECT * FROM approved_business_action.action_review_packages WHERE id = $1', [reviewPackageId]);
      if (r.rows.length === 0) throw new ActionReviewNotFoundError('ActionReviewPackage', reviewPackageId);
      const nextVersion = (r.rows[0].latest_version as number) + 1;
      const result = await client.query<Record<string, unknown>>(
        `INSERT INTO approved_business_action.action_review_package_versions
           (review_package_id, tenant_id, workspace_id, business_id, version_number, summary, correlation_id,
            source_recommendation_version_id, risk_class, is_time_sensitive, valid_until, twin_snapshot_id)
         VALUES ($1,$2,$3,$4,$5,$6,gen_random_uuid(),$7,$8,$9,$10,$11) RETURNING id, version_number`,
        [reviewPackageId, ctx.tenantId, ctx.workspaceId, businessId, nextVersion, summary,
         facts.sourceRecommendationVersionId, facts.riskClass, facts.isTimeSensitive, facts.validUntil, facts.twinSnapshotId]
      );
      await client.query('UPDATE approved_business_action.action_review_packages SET latest_version = $2 WHERE id = $1', [reviewPackageId, nextVersion]);
      return { id: result.rows[0].id as string, versionNumber: result.rows[0].version_number as number };
    });
  }

  /**
   * Resolves the risk/validity facts of the PUBLISHED ADI recommendation version behind an ABA intake package
   * (intake -> ADI publication package -> insight package version -> recommendation version). ABA only reads what
   * ADI published; it neither authors nor recalculates these facts. Returns an all-null snapshot (unclassified /
   * unknown, i.e. fail-closed downstream) when the chain is broken or the recommendation is not published.
   */
  async resolvePublishedSnapshot(ctx: TenantContext, intakePackageId: string): Promise<ReviewVersionSnapshot> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `SELECT rv.id, rv.risk_class, rv.is_time_sensitive, rv.valid_until, rv.twin_snapshot_id
           FROM approved_business_action.aba_intake_packages ip
           JOIN ai_decision_intelligence.adi_publication_packages pp ON pp.id = ip.adi_publication_package_id
           JOIN ai_decision_intelligence.adi_insight_package_versions iv ON iv.id = pp.adi_insight_package_version_id
           JOIN ai_decision_intelligence.decision_recommendation_versions rv ON rv.id = iv.recommendation_version_id
          WHERE ip.id = $1 AND rv.status = 'published' AND rv.business_id = ip.business_id`,
        [intakePackageId]
      );
      if (result.rows.length === 0) {
        return { sourceRecommendationVersionId: null, riskClass: null, isTimeSensitive: null, validUntil: null, twinSnapshotId: null };
      }
      const row = result.rows[0];
      return {
        sourceRecommendationVersionId: row.id as string,
        riskClass: (row.risk_class as ReviewVersionSnapshot['riskClass']) ?? null,
        isTimeSensitive: (row.is_time_sensitive as boolean | null) ?? null,
        validUntil: (row.valid_until as Date | null) ?? null,
        twinSnapshotId: (row.twin_snapshot_id as string | null) ?? null,
      };
    });
  }

  /** The latest version of a review package with its risk/validity snapshot, or null if it has no version. */
  async getLatestVersion(ctx: TenantContext, reviewPackageId: string): Promise<ActionReviewVersion | null> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `SELECT * FROM approved_business_action.action_review_package_versions
          WHERE review_package_id = $1 ORDER BY version_number DESC LIMIT 1`,
        [reviewPackageId]
      );
      if (result.rows.length === 0) return null;
      const row = result.rows[0];
      return {
        id: row.id as string,
        reviewPackageId: row.review_package_id as string,
        versionNumber: row.version_number as number,
        summary: row.summary as string,
        sourceRecommendationVersionId: (row.source_recommendation_version_id as string | null) ?? null,
        riskClass: (row.risk_class as ReviewVersionSnapshot['riskClass']) ?? null,
        isTimeSensitive: (row.is_time_sensitive as boolean | null) ?? null,
        validUntil: (row.valid_until as Date | null) ?? null,
        twinSnapshotId: (row.twin_snapshot_id as string | null) ?? null,
      };
    });
  }

  /** The latest review version with the database clock, read in one statement so expiry is judged on database time. */
  async getLatestVersionWithClock(ctx: TenantContext, reviewPackageId: string): Promise<{ version: ActionReviewVersion | null; now: Date }> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `SELECT v.*, now() AS db_now
           FROM approved_business_action.action_review_package_versions v
          WHERE v.review_package_id = $1 ORDER BY v.version_number DESC LIMIT 1`,
        [reviewPackageId]
      );
      if (result.rows.length === 0) {
        const clock = await client.query<{ db_now: Date }>('SELECT now() AS db_now');
        return { version: null, now: clock.rows[0].db_now };
      }
      const row = result.rows[0];
      return {
        now: row.db_now as Date,
        version: {
          id: row.id as string,
          reviewPackageId: row.review_package_id as string,
          versionNumber: row.version_number as number,
          summary: row.summary as string,
          sourceRecommendationVersionId: (row.source_recommendation_version_id as string | null) ?? null,
          riskClass: (row.risk_class as ReviewVersionSnapshot['riskClass']) ?? null,
          isTimeSensitive: (row.is_time_sensitive as boolean | null) ?? null,
          validUntil: (row.valid_until as Date | null) ?? null,
          twinSnapshotId: (row.twin_snapshot_id as string | null) ?? null,
        },
      };
    });
  }

  async addEvidence(ctx: TenantContext, reviewPackageVersionId: string, businessId: string, evidenceType: string, evidenceReference: Record<string, unknown>): Promise<void> {
    if (!EVIDENCE_TYPES.has(evidenceType)) {
      throw new ValidationError('ActionReviewEvidence', [`unknown evidence_type: ${evidenceType}`]);
    }
    return withTenantTransaction(ctx, async (client) => {
      await client.query(
        `INSERT INTO approved_business_action.action_review_evidence (review_package_version_id, tenant_id, workspace_id, business_id, evidence_type, evidence_reference)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [reviewPackageVersionId, ctx.tenantId, ctx.workspaceId, businessId, evidenceType, JSON.stringify(evidenceReference)]
      );
    });
  }

  async transitionStatus(ctx: TenantContext, reviewPackageId: string, toStatus: string, reason?: string): Promise<ActionReviewPackage> {
    if (!VALID_STATUSES.includes(toStatus)) {
      throw new ValidationError('ActionReviewPackage', [`unknown status: ${toStatus}`]);
    }
    return withTenantTransaction(ctx, async (client) => {
      const current = await client.query<Record<string, unknown>>('SELECT * FROM approved_business_action.action_review_packages WHERE id = $1', [reviewPackageId]);
      if (current.rows.length === 0) throw new ActionReviewNotFoundError('ActionReviewPackage', reviewPackageId);
      const fromStatus = current.rows[0].status as string;
      const result = await client.query<Record<string, unknown>>(
        `UPDATE approved_business_action.action_review_packages SET status = $2 WHERE id = $1 RETURNING *`,
        [reviewPackageId, toStatus]
      );
      await client.query(
        `INSERT INTO approved_business_action.action_review_status_history
           (review_package_id, tenant_id, workspace_id, business_id, from_status, to_status, reason, correlation_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [reviewPackageId, ctx.tenantId, ctx.workspaceId, result.rows[0].business_id, fromStatus, toStatus, reason ?? null, randomUUID()]
      );
      return rowToReview(result.rows[0]);
    });
  }

  async getById(ctx: TenantContext, id: string): Promise<ActionReviewPackage> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>('SELECT * FROM approved_business_action.action_review_packages WHERE id = $1', [id]);
      if (result.rows.length === 0) throw new ActionReviewNotFoundError('ActionReviewPackage', id);
      return rowToReview(result.rows[0]);
    });
  }

  async listForBusiness(ctx: TenantContext, businessId: string): Promise<ActionReviewPackage[]> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        'SELECT * FROM approved_business_action.action_review_packages WHERE business_id = $1 ORDER BY created_at DESC', [businessId]
      );
      return result.rows.map(rowToReview);
    });
  }
}
