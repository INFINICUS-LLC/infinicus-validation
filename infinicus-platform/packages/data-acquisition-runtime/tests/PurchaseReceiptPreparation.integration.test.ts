import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { DataAcquisitionService } from '../src/DataAcquisitionService.js';
import { OPERATIONS_PREPARED_SUBMISSION_TYPE } from '../src/preparation/operationalRecordProfile.js';
import { hashRecord } from '../src/provenance/ProvenanceService.js';
import { RECEIPT_LINE_QUANTITY_CONTRACT, RECEIPT_LINE_UNIT_COST_CONTRACT } from '../src/preparation/operationalRecordProfile.js';
import { NotFoundError } from '../src/errors.js';
import { createPool, closePool } from '@infinicus/database';

// Own tenant fixture (same one-tenant-per-file convention as webhook.integration.test.ts): files run concurrently and a shared tenant's teardown
// would delete another file's rows mid-run.
const T1 = '66666666-0c08-0000-0000-000000000001';
const WS1 = '66666666-0c08-0000-0000-000000000002';
const UID = '66666666-0c08-0000-0000-000000000099';
const ctx1 = { tenantId: T1, workspaceId: WS1, userId: UID };
let seq = 0;
const uniqueCode = (prefix: string): string => `${prefix}-${Date.now()}-${++seq}`;

const RUN = !!process.env.DATABASE_URL;

describe.runIf(RUN)('Integration: R-01B-8 purchase_receipt preparation', () => {
  const svc = new DataAcquisitionService();
  let businessId: string;
  let admin: Pool;

  beforeAll(async () => {
    createPool({ connectionString: process.env.DATABASE_URL! });
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });
    await admin.query(`INSERT INTO tenancy.tenants (id, name, slug, status, plan_code) VALUES ($1,'DA R01B8 Int-Test Tenant','da-r01b8-int-t1','active','test') ON CONFLICT (id) DO NOTHING`, [T1]);
    await admin.query(`INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,'DA R01B8 Int-Test WS','da-r01b8-int-ws1','active') ON CONFLICT (id) DO NOTHING`, [WS1, T1]);
    const biz = await admin.query<{ id: string }>(
      `INSERT INTO platform.businesses (tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,'DA R01B8 Test Biz',$3,'active') RETURNING id`,
      [T1, WS1, uniqueCode('da-r01b8-biz')]);
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

  const PO = '3f2b8c1e-9d4a-4e6b-8c7d-1a2b3c4d5e6f';
  const WH = '4a2b8c1e-9d4a-4e6b-8c7d-1a2b3c4d5e60';
  const ITEM = '5b2b8c1e-9d4a-4e6b-8c7d-1a2b3c4d5e61';
  const line = (data: Record<string, unknown> = {}) => ({ inventoryItemId: ITEM, quantity: 10, ...data });
  const pr = (data: Record<string, unknown> = {}) => ({
    recordType: 'purchase_receipt',
    data: { purchaseOrderId: PO, warehouseId: WH, receiptNumber: 'GRN-1', receivedAt: '2026-10-01T09:30:00.250Z', lines: [line()], ...data },
  });
  const issuesOf = async (collectionRunId: string) => {
    const [vr] = await svc.listValidationResults(ctx1, businessId, collectionRunId);
    return (await admin.query('SELECT rule_code, severity, field_path, message FROM data_acquisition.validation_issues WHERE validation_result_id=$1 ORDER BY rule_code', [vr.id])).rows;
  };
  const receiptCount = async () => Number((await admin.query(`SELECT count(*) AS n FROM business_operations.purchase_receipts WHERE tenant_id=$1`, [ctx1.tenantId])).rows[0].n);

  it('valid receipts: run validated, payload carries the prepared form, raw preserved, raw and prepared provenance hashes recorded', async () => {
    const raw = pr({ receiptNumber: ' GRN-77 ', receivedAt: '2026-10-01T11:30:00.25+02:00', lines: [line({ quantity: ' 4.25 ', unitCost: '2.50', unitCostCurrency: 'USD' })] });
    const prepared = pr({ receiptNumber: 'GRN-77', receivedAt: '2026-10-01T09:30:00.250Z', lines: [line({ quantity: 4.25, unitCost: 2.5, unitCostCurrency: 'USD' })] });
    const result = await submit([raw, pr({ receiptNumber: 'GRN-78' })]);
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
    expect(JSON.stringify(rows[0].parameters)).not.toContain('GRN-77'); // rule names only
    expect(rows[0].parameters.actions).toContainEqual({ field: 'receivedAt', rule: 'utc_instant' });
    expect(rows[0].parameters.actions).toContainEqual({ field: 'lines[0].quantity', rule: 'numeric_string_to_number' });
  });

  it('invalid receipts (incl. the lower-case UUID ruling) are quarantined with stable codes, stay raw and provenance-less, cannot be published and write nothing downstream', async () => {
    const before = await receiptCount();
    const bad = [
      pr({ purchaseOrderId: PO.toUpperCase() }), pr({ warehouseId: 'WH-1' }), pr({ receivedAt: '2026-10-01T09:30:00' }), pr({ lines: [] }),
      pr({ lines: [line({ quantity: '1.00001' })] }), pr({ lines: [line({ unitCost: 1 })] }), pr({ lines: [line({ inventoryItemId: ITEM.toUpperCase() })] }),
      pr({ receivedBy: PO }), { recordType: 'purchase_receipt', data: {} },
    ];
    const result = await submit([pr({ receiptNumber: 'OK-1' }), ...bad]);
    expect(result.state).toBe('quarantined');
    expect(result.recordsAccepted).toBe(1);
    expect(result.recordsRejected).toBe(bad.length);
    expect(result.provenanceIds).toHaveLength(1);

    const codes = (await issuesOf(result.collectionRunId)).map((i) => i.rule_code);
    for (const expected of ['PREP_PURCHASEORDERID_INVALID', 'PREP_WAREHOUSEID_INVALID', 'PREP_RECEIVEDAT_INVALID', 'PREP_LINES_REQUIRED', 'PREP_LINE_QUANTITY_EXCEEDS_SCALE', 'PREP_LINE_UNITCOSTCURRENCY_REQUIRED_WITH_UNITCOST', 'PREP_LINE_INVENTORYITEMID_INVALID', 'PREP_UNSUPPORTED_FIELD']) {
      expect(codes, expected).toContain(expected);
    }
    const payload = await payloadOf(result.manualSubmissionId);
    expect(payload.records[1]).toEqual(bad[0]); // rejected records stay raw, including the upper-case UUID (never folded)
    expect(payload.preparation.outcomes[1]).toMatchObject({ status: 'REJECTED', actions: [] });

    await expect(svc.preparePublicationPackage(ctx1, businessId, result.collectionRunId, { targetBlock: 'bo-events' })).rejects.toBeDefined();
    expect(await receiptCount()).toBe(before);
  });

  it('no prepared-key findings: the receipt-number identity rule stays with BO, so a repeated receipt number is not reported by the DAL', async () => {
    const result = await submit([pr(), pr()]);
    expect(result.state).toBe('validated');
    const [vr] = await svc.listValidationResults(ctx1, businessId, result.collectionRunId);
    const details = (await admin.query('SELECT result_details FROM data_acquisition.validation_results WHERE id=$1', [vr.id])).rows[0].result_details;
    expect(details.preparedKeyFindings).toBeUndefined();
    expect((await issuesOf(result.collectionRunId)).filter((i) => i.rule_code.startsWith('PREP_'))).toEqual([]);
  });

  it('control characters in a receipt (also inside a line) are a controlled rejection (placeholder stored, nothing echoed)', async () => {
    const result = await submit([pr({ notes: 'a\u0000b' }), pr({ receiptNumber: 'OK-2' })]);
    expect(result.state).toBe('quarantined');
    expect((await payloadOf(result.manualSubmissionId)).records[0]).toMatchObject({ unstorable: true, reason: 'PREP_CONTROL_CHARACTER' });
    const inLine = await submit([pr({ lines: [line({ unitCostCurrency: 'U\u0000D' })] })]);
    expect(inLine.state).toBe('quarantined');
    expect((await payloadOf(inLine.manualSubmissionId)).records[0]).toMatchObject({ unstorable: true });
  });

  it('the profile assumptions equal the live receipt tables (uuid / timestamptz / text header, numeric(18,4) quantity and cost, currency and positivity CHECKs, unique receipt number)', async () => {
    const cols = async (table: string) => Object.fromEntries((await admin.query(
      `SELECT column_name, data_type, numeric_precision AS p, numeric_scale AS s FROM information_schema.columns WHERE table_schema='business_operations' AND table_name=$1`, [table])).rows.map((r) => [r.column_name, r]));
    const header = await cols('purchase_receipts');
    expect(header.purchase_order_id.data_type).toBe('uuid');
    expect(header.warehouse_id.data_type).toBe('uuid');
    expect(header.received_at.data_type).toBe('timestamp with time zone');
    expect(header.receipt_number.data_type).toBe('text');
    expect(header.notes.data_type).toBe('text');
    const lines = await cols('purchase_receipt_lines');
    expect(lines.inventory_item_id.data_type).toBe('uuid');
    expect(lines.purchase_order_line_id.data_type).toBe('uuid');
    expect({ precision: lines.quantity.p, scale: lines.quantity.s }).toEqual(RECEIPT_LINE_QUANTITY_CONTRACT);
    expect({ precision: lines.unit_cost.p, scale: lines.unit_cost.s }).toEqual(RECEIPT_LINE_UNIT_COST_CONTRACT);
    const checks = (await admin.query(
      `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
        WHERE n.nspname='business_operations' AND t.relname IN ('purchase_receipt_lines','purchase_receipts')`)).rows.map((r) => r.def as string).join('\n');
    expect(checks).toContain('[A-Z]{3}'); // currency exactly three upper-case letters, as the DAL requires
    expect(checks).toMatch(/quantity > \(?0\)?::numeric/);
    expect(checks).toMatch(/unit_cost > \(?0\)?::numeric/);
    const unique = (await admin.query(
      `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid WHERE t.relname='purchase_receipts' AND c.contype='u'`)).rows.map((r) => r.def as string);
    expect(unique).toContain('UNIQUE (business_id, receipt_number)'); // BO's identity rule, which the DAL deliberately does not duplicate
  });

  it('tenant and business isolation: receipt runs are unreadable from another tenant or business', async () => {
    const result = await submit([pr()]);
    const otherTenant = { ...ctx1, tenantId: '99999999-9999-9999-9999-999999999995', workspaceId: '99999999-9999-9999-9999-999999999994' };
    await expect(svc.getRun(otherTenant, businessId, result.collectionRunId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(svc.getRun(ctx1, '00000000-0000-0000-0000-deadbeef00ee', result.collectionRunId)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('legacy regression: the legacy submission type applies no preparation (raw payload, structural validation only)', async () => {
    const sloppy = pr({ receiptNumber: ' GRN-LEGACY ', lines: [line({ quantity: '5' })] });
    const result = await submit([sloppy], 'operations');
    expect(result.state).toBe('validated');
    const payload = await payloadOf(result.manualSubmissionId);
    expect(payload.records[0]).toEqual(sloppy);
    expect(payload.preparation).toBeUndefined();
  });
});
