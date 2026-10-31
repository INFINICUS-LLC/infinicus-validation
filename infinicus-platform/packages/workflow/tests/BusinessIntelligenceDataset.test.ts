import { describe, expect, it } from 'vitest';
import { datasetCodeFor, schemaReferenceOf, type IntakeDatasetRepository, type TenantContext } from '@infinicus/database';
import { BusinessIntelligenceDatasetService, IntakeNotMaterializableError } from '../src/BusinessIntelligenceDatasetService.js';

const ctx: TenantContext = { tenantId: '11111111-1111-4111-8111-111111111111', workspaceId: '22222222-2222-4222-8222-222222222222', userId: '33333333-3333-4333-8333-333333333333' };

describe('dataset identity and shape', () => {
  it('a BI block always lands in the same dataset code', () => {
    expect(datasetCodeFor('BI-16')).toBe('bo-bi-16');
    expect(datasetCodeFor('BI-01')).toBe('bo-bi-01');
    expect(datasetCodeFor('BI-16')).toBe(datasetCodeFor('BI-16'));
  });
  it('the schema reference lists field names and primitive types only, sorted, never values, whatever the key order', () => {
    const a = schemaReferenceOf({ rows: 42, table: 'secret-table-name', complete: true, note: null });
    const b = schemaReferenceOf({ note: null, complete: true, table: 'secret-table-name', rows: 42 });
    expect(a).toEqual(b);
    expect(a).toEqual({ contract: 'bo-publication-reference/1', fields: [{ name: 'complete', type: 'boolean' }, { name: 'note', type: 'null' }, { name: 'rows', type: 'number' }, { name: 'table', type: 'string' }] });
    expect(JSON.stringify(a)).not.toContain('secret-table-name');
    expect(schemaReferenceOf({})).toEqual({ contract: 'bo-publication-reference/1', fields: [] });
  });
});

describe('BusinessIntelligenceDatasetService', () => {
  const fake = () => { const calls: string[] = []; return { calls, repo: { async materialize(_c: TenantContext, id: string) { calls.push(id); return { datasetId: 'd', datasetCode: 'bo-bi-16', datasetVersionId: 'v', versionNumber: 1, domain: 'inventory_supply', effectiveStart: new Date(0), effectiveEnd: new Date(1), recordCount: 1, idempotentReplay: false }; } } as unknown as IntakeDatasetRepository }; };
  it('refuses anything that is not a UUID before the repository is reached', async () => {
    for (const bad of ['', 'x', 'not-a-uuid', '123', undefined as unknown as string, null as unknown as string, 5 as unknown as string]) {
      const f = fake();
      await expect(new BusinessIntelligenceDatasetService(f.repo).materialize(ctx, bad)).rejects.toMatchObject({ reason: 'intake_package_id_not_a_uuid' });
      expect(f.calls).toEqual([]);
    }
  });
  it('passes a canonical lower-case id to the repository (upper case is accepted as the same id)', async () => {
    const f = fake(); const id = '44444444-4444-4444-8444-44444444ABCD';
    await new BusinessIntelligenceDatasetService(f.repo).materialize(ctx, id);
    expect(f.calls).toEqual([id.toLowerCase()]);
  });
  it('the refusal carries a reason code and no value', async () => {
    const error = await new BusinessIntelligenceDatasetService(fake().repo).materialize(ctx, 'SSN-123-45-6789').then(() => null, (e: Error) => e);
    expect(error).toBeInstanceOf(IntakeNotMaterializableError);
    expect((error as Error).message).not.toContain('SSN-123-45-6789');
  });
});
