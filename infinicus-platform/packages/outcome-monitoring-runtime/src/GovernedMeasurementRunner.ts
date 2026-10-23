import { createHash } from 'node:crypto';
import type {
  ActionExecutionVerification, GovernedMeasurementDefinition, InventoryOutcomeEvidence,
  InventoryOutcomeEvidenceInput, TenantContext,
  GovernedMeasurementVerdictRepository,
  InventoryAttributionEvidence, InventoryAttributionInput,
} from '@infinicus/database';
import {
  ActionExecutionVerificationRepository, GovernedMeasurementDefinitionRepository,
  InventoryOutcomeEvidenceRepository, InventoryAttributionEvidenceRepository, query, withTenantTransaction,
} from '@infinicus/database';

export type MeasurementAssessmentState = 'OUTCOME_PENDING' | 'OUTCOME_INCONCLUSIVE';
export type MeasurementAssessmentReason =
  'NO_DEFINITION' | 'NOTHING_APPLIED' | 'SCOPE_MISMATCH' | 'WINDOW_OPEN' |
  'SOURCE_UNAVAILABLE' | 'BASELINE_MISSING' | 'INSUFFICIENT_DATA' |
  'DATA_QUALITY' | 'ATTRIBUTION_UNAVAILABLE' | 'CONFOUNDED';

/** An idempotent, non-verifying assessment. Its persisted row cannot confer learning authority. */
export interface MeasurementAssessment {
  verificationId: string;
  definitionId: string | null;
  state: MeasurementAssessmentState;
  reason: MeasurementAssessmentReason;
  sourceDigest: string | null;
  assessmentDigest: string;
  runnerServiceAccountId: string;
}

export interface MeasurementRunnerPorts {
  isActiveRunner(ctx: TenantContext, serviceAccountId: string): Promise<boolean>;
  loadVerification(ctx: TenantContext, businessId: string, executionId: string): Promise<ActionExecutionVerification | null>;
  loadDefinitions(ctx: TenantContext, businessId: string): Promise<readonly GovernedMeasurementDefinition[]>;
  readInventoryIssues(ctx: TenantContext, input: InventoryOutcomeEvidenceInput): Promise<InventoryOutcomeEvidence>;
  readAttributionEvidence(ctx: TenantContext, input: InventoryAttributionInput): Promise<InventoryAttributionEvidence>;
  databaseNow(): Promise<Date>;
}

/** Production read ports. No verdict write capability is exposed to the application role. */
export class DatabaseMeasurementRunnerPorts implements MeasurementRunnerPorts {
  private readonly verifications = new ActionExecutionVerificationRepository();
  private readonly definitions = new GovernedMeasurementDefinitionRepository();
  private readonly inventory = new InventoryOutcomeEvidenceRepository();
  private readonly attribution = new InventoryAttributionEvidenceRepository();

  isActiveRunner(ctx: TenantContext, id: string): Promise<boolean> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query(`SELECT 1 FROM identity.service_accounts
        WHERE id = $1 AND tenant_id = $2 AND workspace_id = $3 AND status = 'active'`, [id, ctx.tenantId, ctx.workspaceId]);
      return result.rowCount === 1;
    });
  }
  loadVerification(ctx: TenantContext, businessId: string, executionId: string) {
    return this.verifications.getByExecution(ctx, businessId, executionId);
  }
  async loadDefinitions(ctx: TenantContext, businessId: string) {
    const page = await this.definitions.listApproved(ctx, businessId);
    if (page.truncated) throw new Error('approved measurement definitions exceed the bounded page');
    return page.definitions;
  }
  readInventoryIssues(ctx: TenantContext, input: InventoryOutcomeEvidenceInput) {
    return this.inventory.readIssues(ctx, input);
  }
  readAttributionEvidence(ctx: TenantContext, input: InventoryAttributionInput) {
    return this.attribution.read(ctx, input);
  }
  async databaseNow(): Promise<Date> {
    return (await query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0].now;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const METRIC = 'inventory_issue_count';

export class GovernedMeasurementRunner {
  constructor(private readonly ports: MeasurementRunnerPorts, private readonly runnerServiceAccountId: string) {
    if (!UUID.test(runnerServiceAccountId)) throw new Error('runner requires a service account UUID');
  }

  async assess(ctx: TenantContext, businessId: string, executionId: string): Promise<MeasurementAssessment | null> {
    if (!UUID.test(businessId) || !UUID.test(executionId)) return null;
    if (!await this.ports.isActiveRunner(ctx, this.runnerServiceAccountId)) throw new Error('inactive or out-of-scope OM runner identity');
    const verification = await this.ports.loadVerification(ctx, businessId, executionId);
    if (!verification) return null;
    const emit = (state: MeasurementAssessmentState, reason: MeasurementAssessmentReason,
      definitionId: string | null = null, sourceDigest: string | null = null): MeasurementAssessment => {
      const body = { verificationId: verification.id, definitionId, state, reason, sourceDigest, runnerServiceAccountId: this.runnerServiceAccountId };
      return { ...body, assessmentDigest: `sha256:${createHash('sha256').update(JSON.stringify(body)).digest('hex')}` };
    };
    if (verification.tenantId !== ctx.tenantId || verification.workspaceId !== ctx.workspaceId || verification.businessId !== businessId) {
      return emit('OUTCOME_INCONCLUSIVE', 'SCOPE_MISMATCH');
    }
    if (verification.executionOutcome !== 'SUCCEEDED' || verification.mutationResult !== 'APPLIED') {
      return emit('OUTCOME_INCONCLUSIVE', 'NOTHING_APPLIED');
    }
    if (verification.actionType.code !== 'inventory_reorder_policy_update' || verification.actionType.schemaVersion !== '1' ||
      verification.target.kind !== 'inventory_item' || !UUID.test(verification.target.id)) {
      return emit('OUTCOME_INCONCLUSIVE', 'DATA_QUALITY');
    }
    let availableDefinitions: readonly GovernedMeasurementDefinition[];
    try { availableDefinitions = await this.ports.loadDefinitions(ctx, businessId); }
    catch { return emit('OUTCOME_INCONCLUSIVE', 'DATA_QUALITY'); }
    const definitions = availableDefinitions
      .filter((definition) => definition.actionTypeCode === verification.actionType.code &&
        definition.actionTypeSchemaVersion === verification.actionType.schemaVersion && definition.metricCode === METRIC)
      .sort((a, b) => b.definitionVersion - a.definitionVersion);
    if (definitions.length === 0) return emit('OUTCOME_INCONCLUSIVE', 'NO_DEFINITION');
    const definition = definitions[0];
    const started = new Date(verification.executionRecordedAt).getTime();
    const now = (await this.ports.databaseNow()).getTime();
    if (!Number.isFinite(started) || !Number.isFinite(now) || !Number.isInteger(definition.windowSeconds) || !Number.isInteger(definition.baselineSeconds) ||
      definition.windowSeconds <= 0 || definition.baselineSeconds <= 0 || !Number.isInteger(definition.minimumObservations) || definition.minimumObservations <= 0) {
      return emit('OUTCOME_INCONCLUSIVE', 'DATA_QUALITY', definition.id);
    }
    const windowClosed = started + definition.windowSeconds * 1000;
    if (now < windowClosed) return emit('OUTCOME_PENDING', 'WINDOW_OPEN', definition.id);
    let evidence: InventoryOutcomeEvidence;
    try {
      evidence = await this.ports.readInventoryIssues(ctx, {
        businessId, inventoryItemId: verification.target.id,
        baselineOpenedAt: new Date(started - definition.baselineSeconds * 1000).toISOString(),
        baselineClosedAt: new Date(started).toISOString(),
        windowOpenedAt: new Date(started).toISOString(),
        windowClosedAt: new Date(windowClosed).toISOString(),
      });
    } catch {
      return emit('OUTCOME_PENDING', 'SOURCE_UNAVAILABLE', definition.id);
    }
    if (evidence.targetStatus !== 'single_balance' || evidence.truncated ||
      !/^sha256:[0-9a-f]{64}$/.test(evidence.digest)) {
      return emit('OUTCOME_INCONCLUSIVE', 'DATA_QUALITY', definition.id, evidence.digest);
    }
    if (evidence.baseline.length === 0) return emit('OUTCOME_INCONCLUSIVE', 'BASELINE_MISSING', definition.id, evidence.digest);
    if (evidence.window.length < definition.minimumObservations) {
      return emit('OUTCOME_INCONCLUSIVE', 'INSUFFICIENT_DATA', definition.id, evidence.digest);
    }
    // Only an explicitly named, conservative rule is understood here. A definition with any
    // other rule never inherits a default interpretation.
    if (definition.attributionRuleCode !== 'no_other_policy_change_or_adjustment' ||
      !evidence.balanceId || !evidence.warehouseId) {
      return emit('OUTCOME_INCONCLUSIVE', 'ATTRIBUTION_UNAVAILABLE', definition.id, evidence.digest);
    }
    let attribution: InventoryAttributionEvidence;
    try {
      attribution = await this.ports.readAttributionEvidence(ctx, {
        businessId, inventoryItemId: verification.target.id,
        balanceId: evidence.balanceId, warehouseId: evidence.warehouseId,
        executionId: verification.executionId,
        baselineOpenedAt: new Date(started - definition.baselineSeconds * 1000).toISOString(),
        windowClosedAt: new Date(windowClosed).toISOString(),
      });
    } catch {
      return emit('OUTCOME_INCONCLUSIVE', 'ATTRIBUTION_UNAVAILABLE', definition.id, evidence.digest);
    }
    const combinedDigest = `sha256:${createHash('sha256').update(`${evidence.digest}\n${attribution.digest}`).digest('hex')}`;
    if (attribution.truncated || !/^sha256:[0-9a-f]{64}$/.test(attribution.digest)) {
      return emit('OUTCOME_INCONCLUSIVE', 'DATA_QUALITY', definition.id, combinedDigest);
    }
    if (attribution.policyChanges.length > 0 || attribution.adjustments.length > 0) {
      return emit('OUTCOME_INCONCLUSIVE', 'CONFOUNDED', definition.id, combinedDigest);
    }
    // The legacy attribution tables have no governed rule, source digest, or machine-observation
    // identity. Absence of BO confounders is useful negative evidence, not an approved attribution pass.
    return emit('OUTCOME_INCONCLUSIVE', 'ATTRIBUTION_UNAVAILABLE', definition.id, combinedDigest);
  }

  /** Persist only pending/inconclusive assessments through the dedicated OM runner role. */
  async runAndRecord(ctx: TenantContext, businessId: string, executionId: string,
    writer: Pick<GovernedMeasurementVerdictRepository, 'record'>) {
    const assessment = await this.assess(ctx, businessId, executionId);
    if (!assessment) return null;
    const record = await writer.record(ctx, businessId, assessment);
    return { assessment, record };
  }
}
