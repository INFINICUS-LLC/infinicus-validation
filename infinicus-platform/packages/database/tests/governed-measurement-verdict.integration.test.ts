import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { closePool, createPool, type TenantContext } from '../src/client.js';
import { GovernedMeasurementVerdictRepository } from '../src/repositories/om/GovernedMeasurementVerdictRepository.js';

const run = !!process.env.DATABASE_URL && !!process.env.ADMIN_DATABASE_URL && !!process.env.OM_RUNNER_DATABASE_URL;
const digest = `sha256:${'a'.repeat(64)}`;

describe.runIf(run)('OM-MEASURE-5 durable assessments', () => {
  let admin: Pool;
  let runnerPool: Pool;
  let writer: GovernedMeasurementVerdictRepository;
  let ctx: TenantContext;
  let businessId: string;
  let verificationId: string;
  let serviceAccountId: string;
  let definitionId: string;

  beforeAll(async () => {
    createPool({ connectionString: process.env.DATABASE_URL! });
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL! });
    runnerPool = new Pool({ connectionString: process.env.OM_RUNNER_DATABASE_URL! });
    writer = new GovernedMeasurementVerdictRepository(runnerPool, 'om_measure_runner');
    const tenantId = randomUUID(); const workspaceId = randomUUID(); businessId = randomUUID();
    verificationId = randomUUID(); serviceAccountId = randomUUID(); definitionId = randomUUID();
    ctx = { tenantId, workspaceId, userId: randomUUID() };
    await admin.query(`INSERT INTO tenancy.tenants (id,name,slug,status,plan_code) VALUES ($1,'OM runner',$2,'active','test')`, [tenantId, `om-${tenantId}`]);
    await admin.query(`INSERT INTO tenancy.workspaces (id,tenant_id,name,slug,status) VALUES ($1,$2,'OM runner',$3,'active')`, [workspaceId, tenantId, `om-${workspaceId}`]);
    await admin.query(`INSERT INTO platform.businesses (id,tenant_id,workspace_id,legal_name,business_code,status) VALUES ($1,$2,$3,'OM runner',$4,'active')`, [businessId, tenantId, workspaceId, `om-${businessId}`]);
    await admin.query(`INSERT INTO identity.service_accounts (id,tenant_id,workspace_id,name,status) VALUES ($1,$2,$3,'om-measure-test','active')`, [serviceAccountId, tenantId, workspaceId]);
    const author = randomUUID(); const approver = randomUUID();
    await admin.query(`INSERT INTO identity.users (id,email,status) VALUES ($1,$2,'active'),($3,$4,'active')`,
      [author, `om-author-${author}@example.test`, approver, `om-approver-${approver}@example.test`]);
    await admin.query(`INSERT INTO outcome_monitoring.governed_measurement_definitions
      (id,tenant_id,workspace_id,business_id,action_type_code,action_type_schema_version,metric_code,
       definition_version,window_seconds,baseline_seconds,minimum_observations,attribution_rule_code,
       success_direction,success_threshold,author_id,approver_id)
      VALUES ($1,$2,$3,$4,'inventory_reorder_policy_update','1','inventory_issue_count',1,86400,86400,2,
        'no_other_policy_change','decrease',0.125,$5,$6)`, [definitionId, tenantId, workspaceId, businessId, author, approver]);
    await admin.query(`INSERT INTO outcome_monitoring.action_execution_verifications
      (id,tenant_id,workspace_id,business_id,execution_id,source_event_id,contract_version,evidence_digest,
       package_id,package_version,claim_id,action_type_code,action_type_schema_version,target_kind,target_id,
       execution_outcome,mutation_result,execution_recorded_at,execution_state,outcome_state,outcome_state_reason,correlation_id)
      VALUES ($1,$2,$3,$4,$5,$6,'execution-evidence/1',$7,$8,1,$9,'inventory_reorder_policy_update','1','inventory_item',$10,
        'SUCCEEDED','APPLIED',date_trunc('milliseconds',now()-interval '2 days'),'EXECUTION_VERIFIED','OUTCOME_PENDING','measurement pending',$11)`,
      [verificationId, tenantId, workspaceId, businessId, randomUUID(), randomUUID(), digest,
        randomUUID(), randomUUID(), randomUUID(), randomUUID()]);
  });
  afterAll(async () => { await admin?.end(); await runnerPool?.end(); await closePool(); });

  const assessment = () => ({ verificationId, definitionId: null, state: 'OUTCOME_INCONCLUSIVE' as const,
    reason: 'NO_DEFINITION', sourceDigest: null, assessmentDigest: digest, runnerServiceAccountId: serviceAccountId });

  it('stores a scoped assessment once and returns the same row on replay', async () => {
    const first = await writer.record(ctx, businessId, assessment());
    expect(first.created).toBe(true);
    expect(await writer.record(ctx, businessId, assessment())).toEqual({ id: first.id, created: false });
    const stored = await admin.query(`SELECT outcome_state,reason_code,definition_id,observation_id,runner_service_account_id
      FROM outcome_monitoring.governed_outcome_verdicts WHERE id = $1`, [first.id]);
    expect(stored.rows[0]).toMatchObject({ outcome_state: 'OUTCOME_INCONCLUSIVE', reason_code: 'NO_DEFINITION',
      definition_id: null, observation_id: null, runner_service_account_id: serviceAccountId });
  });

  it('stores an idempotent PENDING assessment only for an applied execution with its scoped definition', async () => {
    const pending = { ...assessment(), definitionId, state: 'OUTCOME_PENDING' as const,
      reason: 'WINDOW_OPEN', assessmentDigest: `sha256:${'b'.repeat(64)}` };
    const first = await writer.record(ctx, businessId, pending);
    expect(first.created).toBe(true);
    expect(await writer.record(ctx, businessId, pending)).toEqual({ id: first.id, created: false });
  });

  it('refuses app-role writes, cross-scope writes, and non-runner database roles', async () => {
    const app = new Pool({ connectionString: process.env.DATABASE_URL! });
    try {
      await expect(app.query(`INSERT INTO outcome_monitoring.governed_outcome_verdicts
        (tenant_id,workspace_id,business_id,execution_verification_id,outcome_state,reason_code,
         input_digest,verdict_digest,runner_service_account_id)
        VALUES ($1,$2,$3,$4,'OUTCOME_INCONCLUSIVE','NO_DEFINITION',$5,$5,$6)`,
      [ctx.tenantId, ctx.workspaceId, businessId, verificationId, digest, serviceAccountId]))
        .rejects.toMatchObject({ code: '42501' });
      const wrongWriter = new GovernedMeasurementVerdictRepository(app, 'om_measure_runner');
      await expect(wrongWriter.record(ctx, businessId, assessment())).rejects.toThrow('least-privilege');
    } finally { await app.end(); }
    await expect(writer.record({ ...ctx, tenantId: randomUUID() }, businessId, assessment()))
      .rejects.toMatchObject({ code: '23514' });
  });

  it('cannot forge OBSERVED or mutate an assessment', async () => {
    await expect(admin.query(`INSERT INTO outcome_monitoring.governed_outcome_verdicts
      (tenant_id,workspace_id,business_id,execution_verification_id,outcome_state,reason_code,
       input_digest,verdict_digest,runner_service_account_id)
      VALUES ($1,$2,$3,$4,'OUTCOME_OBSERVED','MEASURED',$5,$5,$6)`,
    [ctx.tenantId, ctx.workspaceId, businessId, verificationId, digest, serviceAccountId]))
      .rejects.toMatchObject({ code: '23514' });
    await expect(admin.query(`UPDATE outcome_monitoring.governed_outcome_verdicts SET reason_code = 'DATA_QUALITY' WHERE execution_verification_id = $1`, [verificationId]))
      .rejects.toMatchObject({ code: '23514' });
  });

  it('records NOTHING_APPLIED without inventing a measurement definition', async () => {
    const noChangeVerification = randomUUID();
    await admin.query(`INSERT INTO outcome_monitoring.action_execution_verifications
      (id,tenant_id,workspace_id,business_id,execution_id,source_event_id,contract_version,evidence_digest,
       package_id,package_version,claim_id,action_type_code,action_type_schema_version,target_kind,target_id,
       execution_outcome,mutation_result,execution_recorded_at,execution_state,outcome_state,outcome_state_reason,correlation_id)
      VALUES ($1,$2,$3,$4,$5,$6,'execution-evidence/1',$7,$8,1,$9,'inventory_reorder_policy_update','1','inventory_item',$10,
        'SUCCEEDED','NO_CHANGE',date_trunc('milliseconds',now()-interval '2 days'),'EXECUTION_VERIFIED','OUTCOME_INCONCLUSIVE','nothing applied',$11)`,
      [noChangeVerification, ctx.tenantId, ctx.workspaceId, businessId, randomUUID(), randomUUID(), digest,
        randomUUID(), randomUUID(), randomUUID(), randomUUID()]);
    const result = await writer.record(ctx, businessId, { ...assessment(), verificationId: noChangeVerification, reason: 'NOTHING_APPLIED' });
    expect(result.created).toBe(true);
  });
});
