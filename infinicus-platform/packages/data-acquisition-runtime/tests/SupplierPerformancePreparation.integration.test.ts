import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { DataAcquisitionService } from '../src/DataAcquisitionService.js';
import { OPERATIONS_PREPARED_SUBMISSION_TYPE } from '../src/preparation/operationalRecordProfile.js';
import { hashRecord } from '../src/provenance/ProvenanceService.js';
import { SUPPLIER_SCORE_CONTRACT, SUPPLIER_SCORE_FIELDS, SUPPLIER_SCORE_MAXIMUM, SUPPLIER_SCORE_MINIMUM } from '../src/preparation/operationalRecordProfile.js';
import { NotFoundError } from '../src/errors.js';
import { createPool, closePool } from '@infinicus/database';

// Own tenant fixture (same one-tenant-per-file convention as webhook.integration.test.ts): files run concurrently and a shared tenant's teardown
// would delete another file's rows mid-run.
const T1 = '66666666-0c07-0000-0000-000000000001';
const WS1 = '66666666-0c07-0000-0000-000000000002';
const UID = '66666666-0c07-0000-0000-000000000099';
const ctx1 = { tenantId: T1, workspaceId: WS1, userId: UID };
let seq = 0;
const uniqueCode = (prefix: string): string => `${prefix}-${Date.now()}-${++seq}`;

const RUN = !!process.env.DATABASE_URL;

describe.runIf(RUN)('Integration: R-01B-7 supplier_performance preparation', () => {
  const svc = new DataAcquisitionService();
  let businessId: string;
  let admin: Pool;

  beforeAll(async () => {
    createPool({ connectionString: process.env.DATABASE_URL! });
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });
    await admin.query(`INSERT INTO tenancy.tenants (id, name, slug, status, plan_code) VALUES ($1,'DA R01B7 Int-Test Tenant','da-r01b7-int-t1','active','test') ON CONFLICT (id) DO NOTHING`, [T1]);
    await admin.query(`INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,'DA R01B7 Int-Test WS','da-r01b7-int-ws1','active') ON CONFLICT (id) DO NOTHING`, [WS1, T1]);
    const biz = await admin.query<{ id: string }>(
      `INSERT INTO platform.businesses (tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,'DA R01B7 Test Biz',$3,'active') RETURNING id`,
      [T1, WS1, uniqueCode('da-r01b7-biz')]);
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

  const SUPPLIER = '3f2b8c1e-9d4a-4e6b-8c7d-1a2b3c4d5e6f';
  const sp = (data: Record<string, unknown> = {}) => ({
    recordType: 'supplier_performance',
    data: { supplierId: SUPPLIER, periodStart: '2026-01-01', periodEnd: '2026-03-31', qualityScore: 90, deliveryScore: 80, priceScore: 70, serviceScore: 60, overallScore: 75, ...data },
  });
  const issuesOf = async (collectionRunId: string) => {
    const [vr] = await svc.listValidationResults(ctx1, businessId, collectionRunId);
    return (await admin.query('SELECT rule_code, severity, field_path, message FROM data_acquisition.validation_issues WHERE validation_result_id=$1 ORDER BY rule_code', [vr.id])).rows;
  };
  const rowCount = async () => Number((await admin.query(`SELECT count(*) AS n FROM business_operations.supplier_performance_scores WHERE tenant_id=$1`, [ctx1.tenantId])).rows[0].n);

  it('valid records: run validated, payload carries the prepared form, raw preserved, raw and prepared provenance hashes recorded', async () => {
    const raw = sp({ supplierId: SUPPLIER.toUpperCase(), periodStart: ' 2026-01-01 ', qualityScore: '88.50', notes: ' good ' });
    const prepared = sp({ qualityScore: 88.5, notes: 'good' });
    const result = await submit([raw, sp()]);
    expect(result.state).toBe('validated');
    expect(result.recordsAccepted).toBe(2);
    expect(result.provenanceIds).toHaveLength(2);

    const payload = await payloadOf(result.manualSubmissionId);
    expect(payload.records[0]).toEqual(prepared);
    expect(payload.preparation.rawRecords[0]).toEqual(raw);
    expect(payload.preparation.outcomes[0].status).toBe('AUTO_CORRECTED');
    expect(payload.preparation.outcomes[1].status).toBe('VALID');

    const rows = (await admin.query(
      `SELECT p.tenant_id, p.business_id, p.source_hash, t.input_hash, t.output_hash, t.parameters
         FROM data_acquisition.provenance_records p
         JOIN data_acquisition.transformation_records t ON t.provenance_record_id=p.id AND t.transformation_type='normalize'
        WHERE p.id=$1`, [result.provenanceIds[0]])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].tenant_id).toBe(ctx1.tenantId);
    expect(rows[0].business_id).toBe(businessId);
    expect(rows[0].source_hash).toBe(hashRecord(raw));
    expect(rows[0].input_hash).toBe(hashRecord(raw));
    expect(rows[0].output_hash).toBe(hashRecord(prepared));
    expect(JSON.stringify(rows[0].parameters)).not.toContain('good'); // rule names only
    expect(rows[0].parameters.actions).toContainEqual({ field: 'supplierId', rule: 'lowercase_uuid' });
    expect(rows[0].parameters.actions).toContainEqual({ field: 'qualityScore', rule: 'numeric_string_to_number' });
  });

  it('invalid records are quarantined with stable codes, stay raw and provenance-less, cannot be published and write nothing downstream', async () => {
    const before = await rowCount();
    const bad = [
      sp({ supplierId: 'SUP-1' }), sp({ qualityScore: 101 }), sp({ serviceScore: '85.123' }), sp({ periodStart: '2026-04-01', periodEnd: '2026-03-31' }),
      sp({ periodStart: '2026-02-31' }), sp({ evaluatedBy: SUPPLIER }), { recordType: 'supplier_performance', data: {} },
    ];
    const result = await submit([sp({ notes: 'ok' }), ...bad]);
    expect(result.state).toBe('quarantined');
    expect(result.recordsAccepted).toBe(1);
    expect(result.recordsRejected).toBe(bad.length);
    expect(result.provenanceIds).toHaveLength(1);

    const codes = (await issuesOf(result.collectionRunId)).map((i) => i.rule_code);
    for (const expected of ['PREP_SUPPLIERID_INVALID', 'PREP_QUALITYSCORE_OUT_OF_RANGE', 'PREP_SERVICESCORE_EXCEEDS_SCALE', 'PREP_PERIODEND_BEFORE_PERIODSTART', 'PREP_PERIODSTART_INVALID', 'PREP_UNSUPPORTED_FIELD', 'PREP_SUPPLIERID_REQUIRED']) {
      expect(codes, expected).toContain(expected);
    }
    const payload = await payloadOf(result.manualSubmissionId);
    expect(payload.records[1]).toEqual(bad[0]); // rejected records stay raw
    expect(payload.preparation.outcomes[1]).toMatchObject({ status: 'REJECTED', actions: [] });

    await expect(svc.preparePublicationPackage(ctx1, businessId, result.collectionRunId, { targetBlock: 'bo-events' })).rejects.toBeDefined();
    expect(await rowCount()).toBe(before);
  });

  it('no prepared-key findings: BO defines no identity rule, so a repeated supplier and period is not reported as a duplicate', async () => {
    const result = await submit([sp(), sp()]);
    expect(result.state).toBe('validated');
    const [vr] = await svc.listValidationResults(ctx1, businessId, result.collectionRunId);
    const details = (await admin.query('SELECT result_details FROM data_acquisition.validation_results WHERE id=$1', [vr.id])).rows[0].result_details;
    expect(details.preparedKeyFindings).toBeUndefined();
    expect((await issuesOf(result.collectionRunId)).filter((i) => i.rule_code.startsWith('PREP_'))).toEqual([]);
  });

  it('control characters in a record are a controlled rejection (placeholder stored, nothing echoed)', async () => {
    const result = await submit([sp({ notes: 'a\u0000b' }), sp({ notes: 'ok' })]);
    expect(result.state).toBe('quarantined');
    const payload = await payloadOf(result.manualSubmissionId);
    expect(payload.records[0]).toMatchObject({ unstorable: true, reason: 'PREP_CONTROL_CHARACTER' });
  });

  it('the profile assumptions equal the live supplier_performance_scores columns (uuid, date, numeric(5,2) scores, 0..100 CHECKs, period CHECK)', async () => {
    const { rows } = await admin.query(
      `SELECT column_name, data_type, numeric_precision AS p, numeric_scale AS s, is_nullable FROM information_schema.columns
        WHERE table_schema='business_operations' AND table_name='supplier_performance_scores'`);
    const by = Object.fromEntries(rows.map((r) => [r.column_name, r]));
    expect(by.supplier_id.data_type).toBe('uuid');
    expect(by.period_start.data_type).toBe('date');
    expect(by.period_end.data_type).toBe('date');
    const column = (f: string) => f.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    for (const f of SUPPLIER_SCORE_FIELDS) {
      const c = by[column(f)];
      expect({ precision: c.p, scale: c.s }, f).toEqual(SUPPLIER_SCORE_CONTRACT);
      expect(c.is_nullable, f).toBe('NO'); // required, as in the BO mapper
    }
    const checks = (await admin.query(
      `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
        WHERE n.nspname='business_operations' AND t.relname='supplier_performance_scores' AND c.contype='c'`)).rows.map((r) => r.def as string);
    for (const f of SUPPLIER_SCORE_FIELDS) {
      const def = checks.find((d) => d.includes(column(f)));
      expect(def, f).toMatch(new RegExp(`${column(f)} >= \\(${SUPPLIER_SCORE_MINIMUM}\\)::numeric`));
      expect(def, f).toMatch(new RegExp(`${column(f)} <= \\(${SUPPLIER_SCORE_MAXIMUM}\\)::numeric`));
    }
    expect(checks.some((d) => d.includes('period_end >= period_start'))).toBe(true);
  });

  it('tenant and business isolation: runs are unreadable from another tenant or business', async () => {
    const result = await submit([sp()]);
    const otherTenant = { ...ctx1, tenantId: '99999999-9999-9999-9999-999999999995', workspaceId: '99999999-9999-9999-9999-999999999994' };
    await expect(svc.getRun(otherTenant, businessId, result.collectionRunId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(svc.getRun(ctx1, '00000000-0000-0000-0000-deadbeef00ee', result.collectionRunId)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('legacy regression: the legacy submission type applies no preparation (raw payload, structural validation only)', async () => {
    const sloppy = sp({ supplierId: 'not-a-uuid', qualityScore: '88.5' });
    const result = await submit([sloppy], 'operations');
    expect(result.state).toBe('validated');
    const payload = await payloadOf(result.manualSubmissionId);
    expect(payload.records[0]).toEqual(sloppy);
    expect(payload.preparation).toBeUndefined();
  });
});
