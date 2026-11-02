/** T3 isolated identity/replay policy verification; proposed BO publication evidence remains inactive. */
import { describe, expect, it } from 'vitest';
import { buildInventoryMovementEvidence, computeEvidenceDigest, deriveEvidenceId, verifyInventoryMovementEvidence, type RawInventoryMovementRow } from '../src/index.js';

const tenantId='11111111-1111-4111-8111-111111111111';
const workspaceId='22222222-2222-4222-8222-222222222222';
const businessId='33333333-3333-4333-8333-333333333333';
const packageId='44444444-4444-4444-8444-444444444444';
const correlationId='55555555-5555-4555-8555-555555555555';
const altCorrelation='66666666-6666-4666-8666-666666666666';
const period={periodStart:'2026-01-01T00:00:00.000Z',periodEnd:'2026-02-01T00:00:00.000Z'};
const row:RawInventoryMovementRow={
id:'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',tenant_id:tenantId,workspace_id:workspaceId,business_id:businessId,
inventory_item_id:'bbbbbbbb-bbbb-4bbb-8bbb-000000000001',warehouse_id:'cccccccc-cccc-4ccc-8ccc-000000000001',
movement_type:'receipt',quantity:'10.5000',reference_type:'manual',reference_id:'dddddddd-dddd-4ddd-8ddd-000000000001',
unit_cost:'2.2500',unit_cost_currency:'USD',occurred_at:'2026-01-11T08:30:00.123456Z',
correlation_id:'eeeeeeee-eeee-4eee-8eee-000000000001',
};
const build=(opts:{packageId?:string|null;correlationId?:string;rows?:RawInventoryMovementRow[];businessId?:string}={})=>{
 const value=buildInventoryMovementEvidence({scope:{tenantId,workspaceId,businessId:opts.businessId??businessId},period,boPublicationPackageId:opts.packageId===undefined?packageId:opts.packageId,correlationId:opts.correlationId??correlationId,rows:opts.rows??[row]});
 if(!value.ok) throw Error(`fixture failure: ${value.code}`);
 return value.value;
};

describe('BO-PUB-DEV-02A-R4 T3: immutable identity and replay invariants (pure, proposed)',()=>{
 it('same scoped header/body and different request correlation replay identically',()=>{
  const first=build(), replay=build({correlationId:altCorrelation});
  expect(first.digest.value).toBe(replay.digest.value);
  expect(first.evidenceId).toBe(replay.evidenceId);
  expect(first.provenance.correlationId).not.toBe(replay.provenance.correlationId);
  expect(verifyInventoryMovementEvidence(first).ok).toBe(true);
  expect(verifyInventoryMovementEvidence(replay).ok).toBe(true);
 });
 it('binding identical records to a different package changes deterministic identity',()=>{
  const first=build(), other=build({packageId:'77777777-7777-4777-8777-777777777777'});
  expect(other.evidenceId).not.toBe(first.evidenceId);
  expect(other.digest.value).not.toBe(first.digest.value);
 });
 it('same package with changed record content changes identity and must be a future storage conflict',()=>{
  const original=build(), modified=build({rows:[{...row,quantity:'12.0000'}]});
  expect(modified.digest.value).not.toBe(original.digest.value);
  expect(modified.evidenceId).not.toBe(original.evidenceId);
 });
 it('digest and evidence-id integrity fail closed against mismatched or forged values',()=>{
  const original=build();
  const forged=structuredClone(original);
  forged.evidenceId=deriveEvidenceId('0'.repeat(64));
  expect(verifyInventoryMovementEvidence(forged).ok).toBe(false);
  const forgedDigest=structuredClone(original);
  forgedDigest.digest.value=computeEvidenceDigest({...original,recordCount:0});
  expect(verifyInventoryMovementEvidence(forgedDigest).ok).toBe(false);
 });
 it('different business scope cannot produce valid evidence using a foreign row',()=>{
  const rejected=buildInventoryMovementEvidence({scope:{tenantId,workspaceId,businessId:'88888888-8888-4888-8888-888888888888'},period,boPublicationPackageId:packageId,correlationId,rows:[row]});
  expect(rejected.ok).toBe(false);
 });
});
