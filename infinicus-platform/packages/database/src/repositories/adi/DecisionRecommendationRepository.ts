import { randomUUID } from 'crypto';
import type { TenantContext } from '../../client.js';
import { withTenantTransaction } from '../../client.js';
import {
  DecisionRecommendationNotFoundError,
  DecisionRecommendationStateConflictError,
  DecisionRecommendationImmutableError,
  DecisionRecommendationValidationError,
} from './errors.js';

export interface DecisionRecommendation {
  id: string;
  tenantId: string;
  workspaceId: string;
  businessId: string;
  caseId: string;
  chosenAlternativeId: string | null;
  recommendationCode: string;
  status: string;
  latestVersion: number;
}

/**
 * Risk class vocabulary (implementation vocabulary; owner ruling Q2). Documented in
 * docs/architecture/reconciliation/P0-3_RISK_CLASS_VALID_UNTIL_RECONCILIATION.md, not frozen in a locked spec.
 */
export const RISK_CLASSES = ['low', 'medium', 'high', 'critical'] as const;
export type RiskClass = (typeof RISK_CLASSES)[number];

/**
 * Risk and temporal-validity facts of a recommendation (P0-3). All optional and nullable:
 * null means unclassified/unknown (legacy) and is NEVER read as low risk or as "not time-sensitive".
 */
export interface RecommendationRiskValidity {
  riskClass: RiskClass | null;
  isTimeSensitive: boolean | null;
  validUntil: Date | null;
  /** Soft UUID reference to a Digital Twin snapshot (no foreign key by design). */
  twinSnapshotId: string | null;
}

export interface DecisionRecommendationVersion extends RecommendationRiskValidity {
  id: string;
  recommendationId: string;
  versionNumber: number;
  summary: string;
  status: string;
  correlationId: string;
  createdAt: Date;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validates authoring input; returns the normalised persisted shape. Throws on anything inconsistent. */
export function normalizeRiskValidity(input: Partial<RecommendationRiskValidity> = {}): RecommendationRiskValidity {
  const errors: string[] = [];
  const riskClass = input.riskClass ?? null;
  if (riskClass !== null && !(RISK_CLASSES as readonly string[]).includes(riskClass)) errors.push(`unknown risk_class: ${String(riskClass)}`);
  const isTimeSensitive = input.isTimeSensitive ?? null;
  if (isTimeSensitive !== null && typeof isTimeSensitive !== 'boolean') errors.push('is_time_sensitive must be a boolean or null');
  const validUntil = input.validUntil ?? null;
  if (validUntil !== null && !(validUntil instanceof Date && Number.isFinite(validUntil.getTime()))) errors.push('valid_until must be a valid Date or null');
  if (isTimeSensitive === true && validUntil === null) errors.push('a time-sensitive recommendation must carry valid_until');
  const twinSnapshotId = input.twinSnapshotId ?? null;
  if (twinSnapshotId !== null && !(typeof twinSnapshotId === 'string' && UUID_PATTERN.test(twinSnapshotId))) errors.push('twin_snapshot_id must be a UUID or null');
  if (errors.length > 0) throw new DecisionRecommendationValidationError(errors);
  return { riskClass: riskClass as RiskClass | null, isTimeSensitive, validUntil, twinSnapshotId };
}

function rowToRecommendation(row: Record<string, unknown>): DecisionRecommendation {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    workspaceId: row.workspace_id as string,
    businessId: row.business_id as string,
    caseId: row.case_id as string,
    chosenAlternativeId: row.chosen_alternative_id as string | null,
    recommendationCode: row.recommendation_code as string,
    status: row.status as string,
    latestVersion: row.latest_version as number,
  };
}

export interface RecommendationRationale {
  recommendationVersionId: string;
  statement: string;
  /** Written by addRationale()'s evidenceReference param — for the twin-grounded flow this holds { expectedOutcome, riskLevel }. */
  evidenceReference: Record<string, unknown>;
}

function rowToRationale(row: Record<string, unknown>): RecommendationRationale {
  return {
    recommendationVersionId: row.recommendation_version_id as string,
    statement: row.statement as string,
    evidenceReference: row.evidence_reference as Record<string, unknown>,
  };
}

function rowToVersion(row: Record<string, unknown>): DecisionRecommendationVersion {
  return {
    id: row.id as string,
    recommendationId: row.recommendation_id as string,
    versionNumber: row.version_number as number,
    summary: row.summary as string,
    status: row.status as string,
    correlationId: row.correlation_id as string,
    createdAt: row.created_at as Date,
    riskClass: (row.risk_class as RiskClass | null) ?? null,
    isTimeSensitive: (row.is_time_sensitive as boolean | null) ?? null,
    validUntil: (row.valid_until as Date | null) ?? null,
    twinSnapshotId: (row.twin_snapshot_id as string | null) ?? null,
  };
}

export class DecisionRecommendationRepository {
  async createRecommendation(ctx: TenantContext, businessId: string, caseId: string, recommendationCode: string, summary: string, chosenAlternativeId?: string, riskValidity?: Partial<RecommendationRiskValidity>): Promise<{ recommendation: DecisionRecommendation; version: DecisionRecommendationVersion }> {
    const facts = normalizeRiskValidity(riskValidity);
    return withTenantTransaction(ctx, async (client) => {
      const recRow = await client.query<Record<string, unknown>>(
        `INSERT INTO ai_decision_intelligence.decision_recommendations (tenant_id, workspace_id, business_id, case_id, chosen_alternative_id, recommendation_code, latest_version)
         VALUES ($1,$2,$3,$4,$5,$6,1) RETURNING *`,
        [ctx.tenantId, ctx.workspaceId, businessId, caseId, chosenAlternativeId ?? null, recommendationCode]
      );
      const correlationId = randomUUID();
      const versionResult = await client.query<Record<string, unknown>>(
        `INSERT INTO ai_decision_intelligence.decision_recommendation_versions
           (recommendation_id, tenant_id, workspace_id, business_id, version_number, summary, correlation_id,
            risk_class, is_time_sensitive, valid_until, twin_snapshot_id)
         VALUES ($1,$2,$3,$4,1,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [recRow.rows[0].id, ctx.tenantId, ctx.workspaceId, businessId, summary, correlationId,
         facts.riskClass, facts.isTimeSensitive, facts.validUntil, facts.twinSnapshotId]
      );
      return { recommendation: rowToRecommendation(recRow.rows[0]), version: rowToVersion(versionResult.rows[0]) };
    });
  }

  async addRationale(ctx: TenantContext, recommendationVersionId: string, businessId: string, rationaleCode: string, statement: string, evidenceReference: Record<string, unknown> = {}): Promise<void> {
    return withTenantTransaction(ctx, async (client) => {
      await client.query(
        `INSERT INTO ai_decision_intelligence.recommendation_rationales (recommendation_version_id, tenant_id, workspace_id, business_id, rationale_code, statement, evidence_reference)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [recommendationVersionId, ctx.tenantId, ctx.workspaceId, businessId, rationaleCode, statement, JSON.stringify(evidenceReference)]
      );
    });
  }

  async addImplementationStep(ctx: TenantContext, recommendationVersionId: string, businessId: string, stepNumber: number, description: string): Promise<void> {
    return withTenantTransaction(ctx, async (client) => {
      await client.query(
        `INSERT INTO ai_decision_intelligence.recommendation_implementation_steps (recommendation_version_id, tenant_id, workspace_id, business_id, step_number, description)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [recommendationVersionId, ctx.tenantId, ctx.workspaceId, businessId, stepNumber, description]
      );
    });
  }

  async validateRecommendation(ctx: TenantContext, recommendationId: string, recommendationVersionId: string): Promise<DecisionRecommendation> {
    return withTenantTransaction(ctx, async (client) => {
      const current = await client.query<Record<string, unknown>>('SELECT * FROM ai_decision_intelligence.decision_recommendations WHERE id = $1', [recommendationId]);
      if (current.rows.length === 0) throw new DecisionRecommendationNotFoundError('DecisionRecommendation', recommendationId);
      if (current.rows[0].status === 'published') {
        throw new DecisionRecommendationImmutableError('DecisionRecommendation', 'published recommendations cannot be revalidated');
      }
      const result = await client.query<Record<string, unknown>>(
        `UPDATE ai_decision_intelligence.decision_recommendations SET status = 'validated' WHERE id = $1 RETURNING *`,
        [recommendationId]
      );
      await client.query(`UPDATE ai_decision_intelligence.decision_recommendation_versions SET status = 'validated' WHERE id = $1`, [recommendationVersionId]);
      return rowToRecommendation(result.rows[0]);
    });
  }

  /** Publishing is the ADI/ABA authority boundary: this only marks the recommendation eligible for the ADI-to-ABA handoff. ADI never approves or executes it. */
  async publishRecommendation(ctx: TenantContext, recommendationId: string, recommendationVersionId: string): Promise<DecisionRecommendation> {
    return withTenantTransaction(ctx, async (client) => {
      const current = await client.query<Record<string, unknown>>('SELECT * FROM ai_decision_intelligence.decision_recommendations WHERE id = $1', [recommendationId]);
      if (current.rows.length === 0) throw new DecisionRecommendationNotFoundError('DecisionRecommendation', recommendationId);
      if (current.rows[0].status !== 'validated') {
        throw new DecisionRecommendationStateConflictError('DecisionRecommendation', 'must be validated before publication');
      }
      const result = await client.query<Record<string, unknown>>(
        `UPDATE ai_decision_intelligence.decision_recommendations SET status = 'published' WHERE id = $1 RETURNING *`,
        [recommendationId]
      );
      await client.query(`UPDATE ai_decision_intelligence.decision_recommendation_versions SET status = 'published' WHERE id = $1`, [recommendationVersionId]);
      return rowToRecommendation(result.rows[0]);
    });
  }

  async rejectRecommendation(ctx: TenantContext, recommendationId: string): Promise<DecisionRecommendation> {
    return withTenantTransaction(ctx, async (client) => {
      const current = await client.query<Record<string, unknown>>('SELECT * FROM ai_decision_intelligence.decision_recommendations WHERE id = $1', [recommendationId]);
      if (current.rows.length === 0) throw new DecisionRecommendationNotFoundError('DecisionRecommendation', recommendationId);
      if (current.rows[0].status === 'published') {
        throw new DecisionRecommendationImmutableError('DecisionRecommendation', 'published recommendations cannot be rejected in place');
      }
      const result = await client.query<Record<string, unknown>>(
        `UPDATE ai_decision_intelligence.decision_recommendations SET status = 'rejected' WHERE id = $1 RETURNING *`,
        [recommendationId]
      );
      return rowToRecommendation(result.rows[0]);
    });
  }

  /** Only legal before publication — published recommendations are immutable (enforced by the database trigger). */
  async supersedeRecommendation(ctx: TenantContext, recommendationId: string): Promise<DecisionRecommendation> {
    return withTenantTransaction(ctx, async (client) => {
      const current = await client.query<Record<string, unknown>>('SELECT * FROM ai_decision_intelligence.decision_recommendations WHERE id = $1', [recommendationId]);
      if (current.rows.length === 0) throw new DecisionRecommendationNotFoundError('DecisionRecommendation', recommendationId);
      if (current.rows[0].status === 'published') {
        throw new DecisionRecommendationImmutableError('DecisionRecommendation', 'published recommendations cannot be superseded in place');
      }
      const result = await client.query<Record<string, unknown>>(
        `UPDATE ai_decision_intelligence.decision_recommendations SET status = 'superseded' WHERE id = $1 RETURNING *`,
        [recommendationId]
      );
      return rowToRecommendation(result.rows[0]);
    });
  }

  async getById(ctx: TenantContext, id: string): Promise<DecisionRecommendation> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>('SELECT * FROM ai_decision_intelligence.decision_recommendations WHERE id = $1', [id]);
      if (result.rows.length === 0) throw new DecisionRecommendationNotFoundError('DecisionRecommendation', id);
      return rowToRecommendation(result.rows[0]);
    });
  }

  async getPublishedForCase(ctx: TenantContext, caseId: string): Promise<DecisionRecommendation[]> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `SELECT * FROM ai_decision_intelligence.decision_recommendations WHERE case_id = $1 AND status = 'published' ORDER BY created_at DESC`,
        [caseId]
      );
      return result.rows.map(rowToRecommendation);
    });
  }

  /** The published version of a single recommendation — needed anywhere a caller only has the recommendation's header id (e.g. from an API param) but needs the version id FK'd elsewhere (ADI publication packages, addRationale, etc.). */
  async getPublishedVersion(ctx: TenantContext, recommendationId: string): Promise<DecisionRecommendationVersion> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `SELECT * FROM ai_decision_intelligence.decision_recommendation_versions
         WHERE recommendation_id = $1 AND status = 'published'
         ORDER BY version_number DESC LIMIT 1`,
        [recommendationId]
      );
      if (result.rows.length === 0) throw new DecisionRecommendationNotFoundError('PublishedDecisionRecommendationVersion', recommendationId);
      return rowToVersion(result.rows[0]);
    });
  }

  /** Published version(s) for a case, joined server-side — includes the summary text getPublishedForCase's header rows don't expose. */
  async getPublishedVersionsForCase(ctx: TenantContext, caseId: string): Promise<DecisionRecommendationVersion[]> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `SELECT v.* FROM ai_decision_intelligence.decision_recommendation_versions v
         JOIN ai_decision_intelligence.decision_recommendations r ON r.id = v.recommendation_id
         WHERE r.case_id = $1 AND v.status = 'published'
         ORDER BY v.created_at DESC`,
        [caseId]
      );
      return result.rows.map(rowToVersion);
    });
  }

  /**
   * Bulk lookup of each version's rationale (statement + evidence_reference),
   * keyed by recommendation_version_id — a single query rather than N+1 when
   * building a history page over many recommendations. recommend() adds
   * exactly one rationale row per version; DISTINCT ON ... ORDER BY
   * created_at keeps this correct (earliest wins) even if that ever changes.
   */
  async listRationalesForVersions(ctx: TenantContext, recommendationVersionIds: string[]): Promise<RecommendationRationale[]> {
    if (recommendationVersionIds.length === 0) return [];
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `SELECT DISTINCT ON (recommendation_version_id) *
         FROM ai_decision_intelligence.recommendation_rationales
         WHERE recommendation_version_id = ANY($1)
         ORDER BY recommendation_version_id, created_at ASC`,
        [recommendationVersionIds]
      );
      return result.rows.map(rowToRationale);
    });
  }
}
