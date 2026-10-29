import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { DataAcquisitionService } from '../src/DataAcquisitionService.js';
import { OPERATIONS_PREPARED_SUBMISSION_TYPE } from '../src/preparation/operationalRecordProfile.js';
import { hashRecord } from '../src/provenance/ProvenanceService.js';
import { NotFoundError } from '../src/errors.js';
import { createPool, closePool } from '@infinicus/database';

// Own tenant fixture (same one-tenant-per-file convention as webhook.integration.test.ts): files run concurrently and a shared tenant's teardown
// would delete another file's rows mid-run.
const T1 = '66666666-0b02-0000-0000-000000000001';
const WS1 = '66666666-0b02-0000-0000-000000000002';
const UID = '66666666-0b02-0000-0000-000000000099';
const ctx1 = { tenantId: T1, workspaceId: WS1, userId: UID };
let seq = 0;
const uniqueCode = (prefix: string): string => `${prefix}-${Date.now()}-${++seq}`;

const RUN = !!process.env.DATABASE_URL;

describe.runIf(RUN)('Integration: R-01B-2 prepared-key findings', () => {
  const svc = new DataAcquisitionService();
  let businessId: string;
  let admin: Pool;

  beforeAll(async () => {
    createPool({ connectionString: process.env.DATABASE_URL! });
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });
    await admin.query(`INSERT INTO tenancy.tenants (id, name, slug, status, plan_code) VALUES ($1,'DA R01B2 Int-Test Tenant','da-r01b2-int-t1','active','test') ON CONFLICT (id) DO NOTHING`, [T1]);
    await admin.query(`INSERT INTO tenancy.workspaces (id, tenant_id, name, slug, status) VALUES ($1,$2,'DA R01B2 Int-Test WS','da-r01b2-int-ws1','active') ON CONFLICT (id) DO NOTHING`, [WS1, T1]);
    const biz = await admin.query<{ id: string }>(
      `INSERT INTO platform.businesses (tenant_id, workspace_id, legal_name, business_code, status) VALUES ($1,$2,'DA R01B2 Test Biz',$3,'active') RETURNING id`,
      [T1, WS1, uniqueCode('da-r01b2-biz')]);
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

  const item = (data: Record<string, unknown> = {}) => ({ recordType: 'inventory_item', data: { sku: 'K-1', name: 'Widget', ...data } });
  const wh = (data: Record<string, unknown> = {}) => ({ recordType: 'warehouse', data: { warehouseCode: 'KW-1', name: 'Main', ...data } });
  const move = (data: Record<string, unknown> = {}) => ({ recordType: 'inventory_movement', data: { sku: 'K-1', warehouseCode: 'KW-1', movementType: 'receipt', quantity: 1, ...data } });
  const detailsOf = async (collectionRunId: string) => {
    const [vr] = await svc.listValidationResults(ctx1, businessId, collectionRunId);
    const row = (await admin.query('SELECT result_details FROM data_acquisition.validation_results WHERE id=$1', [vr.id])).rows[0];
    const issues = (await admin.query('SELECT rule_code, severity, field_path, message FROM data_acquisition.validation_issues WHERE validation_result_id=$1 ORDER BY message, rule_code', [vr.id])).rows;
    return { details: row.result_details, issues };
  };
  const boCount = async () =>
    (await admin.query(`SELECT (SELECT count(*) FROM platform.inventory_items WHERE tenant_id=$1) + (SELECT count(*) FROM platform.warehouses WHERE tenant_id=$1) AS n`, [ctx1.tenantId])).rows[0].n as string;

  it('EXACT_DUPLICATE: warning only; the run validates, every record is kept with its own provenance, hashes are reported', async () => {
    const result = await submit([item(), item(), wh()]);
    expect(result.state).toBe('validated');
    expect(result.recordsAccepted).toBe(3);
    expect(result.provenanceIds).toHaveLength(3);

    const payload = await payloadOf(result.manualSubmissionId);
    expect(payload.records).toHaveLength(3);
    expect(payload.records[0]).toEqual(item());
    expect(payload.records[1]).toEqual(item());
    expect(payload.preparation.outcomes[0].findings).toEqual(['EXACT_DUPLICATE']);
    expect(payload.preparation.outcomes[2].findings).toBeUndefined();

    const { details, issues } = await detailsOf(result.collectionRunId);
    expect(details.preparedKeyFindings).toHaveLength(1);
    expect(details.preparedKeyFindings[0]).toMatchObject({ kind: 'EXACT_DUPLICATE', recordType: 'inventory_item', keyField: 'sku', groupId: 'inventory_item#0', normalizationCollision: false });
    expect(issues.filter((i) => i.rule_code === 'PREP_EXACT_DUPLICATE').map((i) => i.severity)).toEqual(['warning', 'warning']);
    expect(issues.some((i) => i.severity === 'error')).toBe(false);

    // the hashes in the finding are the provenance hashes
    const prov = (await admin.query(
      `SELECT p.record_reference, p.source_hash, t.output_hash FROM data_acquisition.provenance_records p
         JOIN data_acquisition.transformation_records t ON t.provenance_record_id=p.id AND t.transformation_type='normalize'
        WHERE p.collection_run_id=$1 ORDER BY p.record_reference`, [result.collectionRunId])).rows;
    // identical raw records have no normalize step when nothing changed? they do (normalize is always recorded in prepared mode)
    for (const m of details.preparedKeyFindings[0].members) {
      const row = prov.find((p) => p.record_reference === `${result.manualSubmissionId}#${m.recordIndex}`)!;
      expect(m.rawHash).toBe(row.source_hash);
      expect(m.preparedHash).toBe(row.output_hash);
    }
  });

  it('CONFLICT: error on every member, run quarantined, members rejected without provenance, nothing publishable, no BO write', async () => {
    const before = await boCount();
    const result = await submit([item(), item({ name: 'Different' }), wh()]);
    expect(result.state).toBe('quarantined');
    expect(result.recordsAccepted).toBe(1);
    expect(result.recordsRejected).toBe(2);
    expect(result.provenanceIds).toHaveLength(1); // only the unrelated warehouse

    const payload = await payloadOf(result.manualSubmissionId);
    expect(payload.records[0]).toEqual(item()); // raw, kept unmodified
    expect(payload.records[1]).toEqual(item({ name: 'Different' }));
    expect(payload.preparation.rawRecords).toHaveLength(3);
    expect(payload.preparation.outcomes[0]).toMatchObject({ status: 'REJECTED', findings: ['CONFLICT'] });
    expect(payload.preparation.outcomes[1]).toMatchObject({ status: 'REJECTED', findings: ['CONFLICT'] });

    const { details, issues } = await detailsOf(result.collectionRunId);
    expect(details.preparedKeyFindings[0]).toMatchObject({ kind: 'CONFLICT', differingFields: ['name'] });
    expect(issues.filter((i) => i.rule_code === 'PREP_CONFLICT').map((i) => i.severity)).toEqual(['error', 'error']);

    await expect(svc.preparePublicationPackage(ctx1, businessId, result.collectionRunId, { targetBlock: 'bo-events' })).rejects.toBeDefined();
    expect(await boCount()).toBe(before);
  });

  it('NORMALIZATION_COLLISION: raw records that differ only by whitespace are reported; raw and prepared hashes are both preserved', async () => {
    const rawA = item(); const rawB = item({ sku: '  K-1 ' });
    const result = await submit([rawA, rawB]);
    expect(result.state).toBe('validated');
    const { details, issues } = await detailsOf(result.collectionRunId);
    const group = details.preparedKeyFindings[0];
    expect(group).toMatchObject({ kind: 'EXACT_DUPLICATE', normalizationCollision: true });
    expect(group.members[0].rawHash).toBe(hashRecord(rawA));
    expect(group.members[1].rawHash).toBe(hashRecord(rawB));
    expect(group.members[0].preparedHash).toBe(group.members[1].preparedHash);
    expect(issues.filter((i) => i.rule_code === 'PREP_NORMALIZATION_COLLISION')).toHaveLength(2);
    const payload = await payloadOf(result.manualSubmissionId);
    expect(payload.preparation.rawRecords[1]).toEqual(rawB); // the raw form is still there verbatim
  });

  it('case-only differences stay distinct and movements are never classified: no findings, run validated', async () => {
    const result = await submit([item({ sku: 'sku-9' }), item({ sku: 'SKU-9' }), wh({ warehouseCode: 'w-9' }), wh({ warehouseCode: 'W-9' }), move(), move(), move({ quantity: 2 })]);
    expect(result.state).toBe('validated');
    expect(result.recordsAccepted).toBe(7);
    const { details, issues } = await detailsOf(result.collectionRunId);
    expect(details.preparedKeyFindings).toBeUndefined();
    expect(issues.filter((i) => i.rule_code.startsWith('PREP_'))).toEqual([]);
  });

  it('findings never contain business values (names, SKUs)', async () => {
    const result = await submit([item({ sku: 'SECRET-SKU', name: 'SECRET-NAME-A' }), item({ sku: 'SECRET-SKU', name: 'SECRET-NAME-B' })]);
    const { details, issues } = await detailsOf(result.collectionRunId);
    const text = JSON.stringify([details.preparedKeyFindings, issues.filter((i) => i.rule_code.startsWith('PREP_'))]);
    expect(text).not.toContain('SECRET');
  });

  it('is deterministic: the same batch submitted twice yields identical groups and hashes', async () => {
    const batch = [item(), wh(), item({ name: 'Other' }), wh({ name: 'Annex' }), item({ sku: 'Z' })];
    const a = await detailsOf((await submit(batch)).collectionRunId);
    const b = await detailsOf((await submit(batch)).collectionRunId);
    expect(JSON.stringify(a.details.preparedKeyFindings)).toBe(JSON.stringify(b.details.preparedKeyFindings));
    expect(a.details.preparedKeyFindings.map((g: { kind: string }) => g.kind)).toEqual(['CONFLICT', 'CONFLICT']);
  });

  it('records rejected by preparation do not take part in key comparison', async () => {
    const result = await submit([item(), item({ name: '' }), item({ sku: 'bad sku!' })]);
    expect(result.state).toBe('quarantined');
    const { details } = await detailsOf(result.collectionRunId);
    expect(details.preparedKeyFindings).toBeUndefined();
  });

  it('tenant and business isolation: findings are unreadable from another tenant or business', async () => {
    const result = await submit([item(), item({ name: 'Different' })]);
    const otherTenant = { ...ctx1, tenantId: '99999999-9999-9999-9999-999999999997', workspaceId: '99999999-9999-9999-9999-999999999996' };
    await expect(svc.listValidationResults(otherTenant, businessId, result.collectionRunId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(svc.listValidationResults(ctx1, '00000000-0000-0000-0000-deadbeef00dd', result.collectionRunId)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('legacy regression: identical and conflicting items on the legacy submission type produce no findings and the old outcome', async () => {
    const result = await submit([item(), item({ name: 'Different' })], 'operations');
    expect(result.state).toBe('validated'); // structural validation only, exactly as before R-01B-2
    const { details, issues } = await detailsOf(result.collectionRunId);
    expect(details.preparedKeyFindings).toBeUndefined();
    expect(issues.filter((i) => i.rule_code.startsWith('PREP_'))).toEqual([]);
    const payload = await payloadOf(result.manualSubmissionId);
    expect(payload.preparation).toBeUndefined();
  });
});
