import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { closePool, createPool } from '../src/client.js';
import { OM24AuthorityRepository } from '../src/repositories/om/OM24AuthorityRepository.js';

const run = !!process.env.DATABASE_URL && !!process.env.ADMIN_DATABASE_URL;
const names = ['governed_measurement_definitions', 'governed_outcome_verdicts', 'om24_publication_receipts'];
const ctx = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  workspaceId: '22222222-2222-4222-8222-222222222222',
  userId: '33333333-3333-4333-8333-333333333333',
};
const businessId = '44444444-4444-4444-8444-444444444444';
const publicationId = '55555555-5555-4555-8555-555555555555';
let admin: Pool;

describe.runIf(run)('OM-24 authority source on disposable PostgreSQL', () => {
  beforeAll(() => {
    createPool({ connectionString: process.env.DATABASE_URL! });
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL! });
  });
  afterAll(async () => { await admin.end(); await closePool(); });

  it('forces RLS and withholds application writes to all authority records', async () => {
    for (const name of names) {
      const result = await admin.query(`SELECT c.relrowsecurity, c.relforcerowsecurity,
        has_table_privilege('app_test_user', c.oid, 'SELECT') AS can_read,
        has_table_privilege('app_test_user', c.oid, 'INSERT') AS can_insert,
        has_table_privilege('app_test_user', c.oid, 'UPDATE') AS can_update,
        has_table_privilege('app_test_user', c.oid, 'DELETE') AS can_delete
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'outcome_monitoring' AND c.relname = $1`, [name]);
      expect(result.rows[0]).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true,
        can_read: true, can_insert: false, can_update: false, can_delete: false });
    }
  });

  it('cannot claim a verified verdict before the governed runner exists', async () => {
    await expect(admin.query(`INSERT INTO outcome_monitoring.governed_outcome_verdicts
      (tenant_id, workspace_id, business_id, execution_verification_id, observation_id, observation_version_id,
       definition_id, outcome_state, input_digest, verdict_digest, measured_value, baseline_value,
       observation_count, baseline_opened_at, baseline_closed_at, window_opened_at, window_closed_at, runner_id, approver_id)
      VALUES ($1,$2,$3,$1,$1,$1,$1,'OUTCOME_VERIFIED',$4,$4,1,0,1,now()-interval '3 days',now()-interval '2 days',now()-interval '1 day',now(),$1,$2)`,
      [ctx.tenantId, ctx.workspaceId, businessId, `sha256:${'a'.repeat(64)}`])).rejects.toMatchObject({ code: '23514' });
  });

  it('enforces every verdict source relationship as a validated scoped foreign key', async () => {
    const result = await admin.query(`SELECT conname, contype, convalidated,
      pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE conrelid = 'outcome_monitoring.governed_outcome_verdicts'::regclass`);
    const constraints = new Map(result.rows.map((row) => [row.conname as string, row]));
    for (const name of [
      'om_verdict_definition_scope', 'om_verdict_verification_scope', 'om_verdict_observation_scope',
      'om_verdict_version_scope', 'om_verdict_attribution_scope',
    ]) {
      expect(constraints.get(name)).toMatchObject({ contype: 'f', convalidated: true });
      expect(constraints.get(name)?.definition).toContain('tenant_id, workspace_id, business_id');
    }
    expect(constraints.get('om_verdict_assessment_shape')).toMatchObject({ contype: 'c', convalidated: true });
  });

  it('keeps verdicts append-only and rejects a forged approval even without source rows', async () => {
    const triggers = await admin.query(`SELECT tgname, tgenabled FROM pg_trigger
      WHERE tgrelid = 'outcome_monitoring.governed_outcome_verdicts'::regclass AND NOT tgisinternal`);
    for (const name of ['guard_governed_outcome_verdict_insert', 'immutable_governed_outcome_verdicts',
      'immutable_governed_outcome_verdicts_truncate']) {
      expect(triggers.rows).toContainEqual({ tgname: name, tgenabled: 'O' });
    }
    // The receipt FK may reject a plain TRUNCATE before the append-only trigger runs.
    await expect(admin.query('TRUNCATE outcome_monitoring.governed_outcome_verdicts'))
      .rejects.toMatchObject({ code: '0A000' });
    await expect(admin.query('TRUNCATE outcome_monitoring.governed_outcome_verdicts CASCADE'))
      .rejects.toMatchObject({ code: '23514' });
    await expect(admin.query(`INSERT INTO outcome_monitoring.governed_outcome_verdicts
      (tenant_id, workspace_id, business_id, execution_verification_id, observation_id, observation_version_id,
       definition_id, outcome_state, input_digest, verdict_digest, measured_value, baseline_value,
       observation_count, baseline_opened_at, baseline_closed_at, window_opened_at, window_closed_at, runner_id, approver_id)
      VALUES ($1,$2,$3,$1,$1,$1,$1,'OUTCOME_OBSERVED',$4,$4,1,0,1,
        now()-interval '3 days',now()-interval '2 days',now()-interval '1 day',now(),$1,$2)`,
      [ctx.tenantId, ctx.workspaceId, businessId, `sha256:${'a'.repeat(64)}`]))
      .rejects.toMatchObject({ code: '23514' });
  });

  it('refuses a missing or malformed source under tenant scope', async () => {
    const reader = new OM24AuthorityRepository();
    expect(await reader.hasVerifiedPublication(ctx, businessId, publicationId, {})).toBe(false);
    expect(await reader.hasVerifiedPublication(ctx, businessId, publicationId, {
      publicationReceiptId: '66666666-6666-4666-8666-666666666666',
      outcomeVerdictId: '77777777-7777-4777-8777-777777777777',
      monitoringContractId: '88888888-8888-4888-8888-888888888888',
    })).toBe(false);
  });
});
