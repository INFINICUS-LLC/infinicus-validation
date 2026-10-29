import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { DataAcquisitionService } from '../src/DataAcquisitionService.js';
import { OPERATIONS_PREPARED_SUBMISSION_TYPE } from '../src/preparation/operationalRecordProfile.js';
import { hashRecord } from '../src/provenance/ProvenanceService.js';
import { NotFoundError } from '../src/errors.js';
import { createPool, closePool } from '@infinicus/database';

// Own tenant fixture (same one-tenant-per-file convention as webhook.integration.test.ts): files run concurrently and a shared tenant's teardown
// would delete another file's rows mid-run.
const T1 = '66666666-0a01-0000-0000-000000000001';
const WS1 = '66666666-0a01-0000-0000-000000000002';
const UID = '66666666-0a01-0000-0000-000000000099';
const ctx1 = { tenantId: T1, workspaceId: WS1, userId: UID };
let seq = 0;
const uniqueCode = (prefix: string): string => `${prefix}-${Date.now()}-${++seq}`;

const RUN = !!process.env.DATABASE_URL;

describe.runIf(RUN)('Integration: R-01A operational preparation', () => {
  const svc = new DataAcquisitionService();
  let businessId: string;
  let admin: Pool;

  beforeAll(async () => {
    createPool({ connectionString: process.env.DATABASE_URL! });
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });
    await admin.query(`INSERT INTO tenancy.tenants (id, name, slug, status, plan_code) VALUES ($1,'DA R01A Int-Test Tenant','da-r01a-int-t1','active','test') ON CONFLICT (id) DO NOTHING`, [T1]);
    await admin.query(`INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,'DA R01A Int-Test WS','da-r01a-int-ws1','active') ON CONFLICT (id) DO NOTHING`, [WS1, T1]);
    const biz = await admin.query<{ id: string }>(
      `INSERT INTO platform.businesses (tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,'DA R01A Test Biz',$3,'active') RETURNING id`,
      [T1, WS1, uniqueCode('da-r01a-biz')]);
    businessId = biz.rows[0].id;
  });
  afterAll(async () => {
    const clean = (sql: string) => admin.query(sql, [[T1]]);
    await clean(`DELETE FROM data_acquisition.transformation_records WHERE provenance_record_id IN (SELECT id FROM data_acquisition.provenance_records WHERE tenant_id = ANY($1))`);
    for (const t of ['provenance_records', 'publication_packages', 'data_quality_scores']) await clean(`DELETE FROM data_acquisition.${t} WHERE tenant_id = ANY($1)`);
    await clean(`DELETE FROM data_acquisition.validation_issues WHERE validation_result_id IN (SELECT id FROM data_acquisition.validation_results WHERE tenant_id = ANY($1))`);
    for (const t of ['validation_results', 'manual_submissions', 'webhook_receipts', 'collection_runs', 'connectors', 'data_sources']) await clean(`DELETE FROM data_acquisition.${t} WHERE tenant_id = ANY($1)`);
    await admin.query(`DELETE FROM platform.businesses WHERE id = $1`, [businessId]);
    await admin.end();
    await closePool();
  });

  async function source() {
    return svc.registerSource(ctx1, {
      businessId, name: 'Prep Source', sourceCode: uniqueCode('prep-src'), sourceType: 'api', sensitivityLevel: 'internal', status: 'active',
    });
  }
  const submit = async (records: unknown[], submissionType = OPERATIONS_PREPARED_SUBMISSION_TYPE) => {
    const s = await source();
    return svc.submitManualIntake(ctx1, { businessId, dataSourceId: s.id, submissionType, sourceReference: 'ref-1', records });
  };
  const payloadOf = async (submissionId: string) =>
    (await admin.query<{ payload: any }>('SELECT payload FROM data_acquisition.manual_submissions WHERE id=$1', [submissionId])).rows[0].payload;

  const raw = { recordType: 'inventory_movement', data: { sku: ' SKU-1 ', warehouseCode: 'WH-1', movementType: 'RECEIPT', quantity: '4', unitCost: 2, unitCostCurrency: 'USD' } };
  const prepared = { recordType: 'inventory_movement', data: { sku: 'SKU-1', warehouseCode: 'WH-1', movementType: 'receipt', quantity: 4, unitCost: 2, unitCostCurrency: 'USD' } };

  it('prepares valid manual records: run validated, payload.records holds the prepared form, raw is preserved verbatim', async () => {
    const result = await submit([raw, { recordType: 'warehouse', data: { warehouseCode: 'WH-1', name: 'Main' } }]);
    expect(result.state).toBe('validated');
    expect(result.recordsAccepted).toBe(2);
    expect(result.provenanceIds).toHaveLength(2);

    const payload = await payloadOf(result.manualSubmissionId);
    expect(payload.records[0]).toEqual(prepared);
    expect(payload.preparation.rawRecords[0]).toEqual(raw);
    expect(payload.preparation.outcomes[0].status).toBe('AUTO_CORRECTED');
    expect(payload.preparation.outcomes[1].status).toBe('VALID');
  });

  it('preserves provenance: source hash is of the RAW record, a normalize transformation links raw hash -> prepared hash, scope is the tenant/business', async () => {
    const result = await submit([raw]);
    const rows = (await admin.query(
      `SELECT p.tenant_id, p.business_id, p.record_reference, p.source_reference, p.source_hash, t.transformation_type, t.input_hash, t.output_hash, t.parameters
         FROM data_acquisition.provenance_records p JOIN data_acquisition.transformation_records t ON t.provenance_record_id = p.id
        WHERE p.id = $1 ORDER BY t.transformation_type`, [result.provenanceIds[0]])).rows;
    expect(rows.map((r) => r.transformation_type)).toEqual(['canonicalize', 'normalize']);
    const norm = rows[1];
    expect(norm.tenant_id).toBe(ctx1.tenantId);
    expect(norm.business_id).toBe(businessId);
    expect(norm.record_reference).toBe(`${result.manualSubmissionId}#0`);
    expect(norm.source_reference).toBe('ref-1');
    expect(norm.source_hash).toBe(hashRecord(raw));
    expect(norm.input_hash).toBe(hashRecord(raw));
    expect(norm.output_hash).toBe(hashRecord(prepared));
    expect(norm.parameters.actions).toContainEqual({ field: 'movementType', rule: 'lowercase_enum' });
    expect(JSON.stringify(norm.parameters)).not.toContain('SKU-1'); // rules only, never values
  });

  it('rejects invalid records with persisted reasons, quarantines the run, and keeps them provenance-less (so BO skips them)', async () => {
    const bad = { recordType: 'warehouse', data: { warehouseCode: 'W' } };
    const result = await submit([raw, bad, { recordType: 'nope', data: {} }]);
    expect(result.state).toBe('quarantined');
    expect(result.recordsAccepted).toBe(1);
    expect(result.recordsRejected).toBe(2);
    expect(result.provenanceIds).toHaveLength(1);

    const [vr] = await svc.listValidationResults(ctx1, businessId, result.collectionRunId);
    expect(vr.isValid).toBe(false);
    const issues = (await admin.query('SELECT rule_code, message FROM data_acquisition.validation_issues WHERE validation_result_id=$1 ORDER BY rule_code', [vr.id])).rows;
    expect(issues.map((i) => i.rule_code)).toEqual(['PREP_NAME_REQUIRED', 'PREP_UNSUPPORTED_RECORD_TYPE']);
    expect(issues[0].message).toContain('record[1]');

    const payload = await payloadOf(result.manualSubmissionId);
    expect(payload.records[1]).toEqual(bad); // raw, unmodified
    expect(payload.preparation.outcomes[1]).toMatchObject({ status: 'REJECTED', actions: [] });
  });

  it('writes nothing downstream for a fully rejected batch: no provenance, no package is preparable, nothing reaches BO tables', async () => {
    const result = await submit([{ recordType: 'warehouse', data: {} }]);
    expect(result.state).toBe('quarantined');
    expect(result.provenanceIds).toHaveLength(0);
    await expect(svc.preparePublicationPackage(ctx1, businessId, result.collectionRunId, { targetBlock: 'bo-events' })).rejects.toBeDefined();
    const bo = await admin.query(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='business_operations' AND table_name='inventory_items'`);
    if (bo.rows[0].n === 1) {
      const n = await admin.query(`SELECT count(*)::int AS n FROM business_operations.inventory_items WHERE tenant_id=$1`, [ctx1.tenantId]);
      expect(n.rows[0].n).toBe(0);
    }
  });

  it('is isolated by business and tenant: another business or tenant cannot read the run, provenance or results', async () => {
    const result = await submit([raw]);
    const otherBiz = '00000000-0000-0000-0000-deadbeef00cc';
    await expect(svc.getRun(ctx1, otherBiz, result.collectionRunId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(svc.listProvenance(ctx1, otherBiz, result.collectionRunId)).rejects.toBeInstanceOf(NotFoundError);
    const otherTenant = { ...ctx1, tenantId: '99999999-9999-9999-9999-999999999999', workspaceId: '99999999-9999-9999-9999-999999999998' };
    await expect(svc.listProvenance(otherTenant, businessId, result.collectionRunId)).rejects.toBeInstanceOf(NotFoundError);
    const rls = await admin.query(`SELECT tenant_id FROM data_acquisition.manual_submissions WHERE id=$1`, [result.manualSubmissionId]);
    expect(rls.rows[0].tenant_id).toBe(ctx1.tenantId);
  });

  it('never reads scope from a record: a record carrying businessId/tenantId is rejected, not honored', async () => {
    const result = await submit([{ recordType: 'warehouse', data: { warehouseCode: 'W', name: 'n', businessId: 'x', tenantId: 'y' } }]);
    expect(result.state).toBe('quarantined');
    expect(result.recordsAccepted).toBe(0);
  });

  it('regression: the legacy submissionType flow is byte-for-byte unchanged (no preparation, no normalize transformation, raw payload)', async () => {
    const legacy = { recordType: 'inventory_movement', data: { sku: ' SKU-1 ', movementType: 'RECEIPT' } };
    const result = await submit([legacy], 'operations');
    expect(result.state).toBe('validated'); // structural validation only, as before
    const payload = await payloadOf(result.manualSubmissionId);
    expect(payload.records[0]).toEqual(legacy);
    expect(payload.preparation).toBeUndefined();
    const t = await admin.query(`SELECT transformation_type FROM data_acquisition.transformation_records WHERE provenance_record_id=$1`, [result.provenanceIds[0]]);
    expect(t.rows.map((r) => r.transformation_type)).toEqual(['canonicalize']);
  });
});
