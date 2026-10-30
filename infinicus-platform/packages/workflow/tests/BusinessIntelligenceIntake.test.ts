import { describe, expect, it } from 'vitest';
import type { BOToBIHandoff } from '@infinicus/handoff-contracts';
import { BO_TO_BI_CONTRACT_VERSION } from '@infinicus/handoff-contracts';
import type { BoToBiIntakeInput, BoToBiIntakeOutcome, TenantContext } from '@infinicus/database';
import { BI_INTAKE_DOMAINS, BiIntakeRejectedError, BusinessIntelligenceIntakeService, biDomainForTargetBlock } from '../src/BusinessIntelligenceIntakeService.js';

const T = '11111111-1111-4111-8111-111111111111';
const W = '22222222-2222-4222-8222-222222222222';
const B = '33333333-3333-4333-8333-333333333333';
const PKG = '44444444-4444-4444-8444-444444444444';
const HID = '55555555-5555-4555-8555-555555555555';
const CID = '66666666-6666-4666-8666-666666666666';
const ctx: TenantContext = { tenantId: T, workspaceId: W, userId: '77777777-7777-4777-8777-777777777777' };

const handoff = (over: Partial<BOToBIHandoff['payload']> = {}, envelope: Partial<BOToBIHandoff> = {}): BOToBIHandoff => ({
  handoffId: HID, sourceLayer: 'BO', sourceBlock: 'BO-RUNTIME', targetLayer: 'BI', targetBlock: 'BI-16', correlationId: CID, lineage: [], status: 'ready',
  createdAt: '2026-10-30T10:00:00.000Z',
  payload: {
    contractVersion: BO_TO_BI_CONTRACT_VERSION, tenantId: T, workspaceId: W, businessId: B, boPublicationPackageId: PKG, packageStatus: 'dispatched', targetBlock: 'BI-16',
    periodStart: '2026-10-01T00:00:00.000Z', periodEnd: '2026-11-01T00:00:00.000Z', recordCount: 42, source: { packageCode: 'inv-2026-10', payloadReference: { k: 'v', n: 1 } },
    schemaVersion: '1.0', idempotencyKey: `bo-to-bi:${PKG}:2`, ...over,
  },
  ...envelope,
});

/** A repository double that records what it was asked and never touches a database. */
function fakeRepo(outcome: BoToBiIntakeOutcome = { outcome: 'VALIDATED', intakePackageId: 'i1', versionNumber: 1, idempotentReplay: false }) {
  const calls: BoToBiIntakeInput[] = [];
  return { calls, repo: { async ingest(_c: TenantContext, input: BoToBiIntakeInput) { calls.push(input); return outcome; } } as never };
}
const reasonsOf = async (p: Promise<unknown>): Promise<readonly string[]> => p.then(() => { throw new Error('expected a refusal'); }, (e: unknown) => { expect(e).toBeInstanceOf(BiIntakeRejectedError); return (e as BiIntakeRejectedError).reasons; });

describe('BI domain of a BI block', () => {
  it('BI-11..BI-18 are the eight domain engines, in the order of the domain list; every other BI block is cross-domain', () => {
    const expected = ['financial', 'sales_revenue', 'customer', 'marketing', 'operations_productivity', 'inventory_supply', 'workforce', 'market_competitive'];
    expect([11, 12, 13, 14, 15, 16, 17, 18].map((n) => biDomainForTargetBlock(`BI-${n}`))).toEqual(expected);
    for (const n of [1, 2, 10, 19, 20, 25]) expect(biDomainForTargetBlock(`BI-${String(n).padStart(2, '0')}`)).toBe('cross_domain');
    expect(BI_INTAKE_DOMAINS).toEqual([...expected, 'cross_domain']);
  });
  it('anything that is not a BI block is not ingestible', () => {
    for (const t of ['BI-00', 'BI-26', 'BI-1', 'bi-16', 'BI-016', 'DT-01', 'BO-RUNTIME', '', ' BI-16', 'BI-16 ']) expect(biDomainForTargetBlock(t), t).toBeNull();
  });
});

describe('BusinessIntelligenceIntakeService: what is refused before anything is persisted', () => {
  const refuse = async (h: unknown, c: TenantContext = ctx) => {
    const f = fakeRepo();
    const reasons = await reasonsOf(new BusinessIntelligenceIntakeService(f.repo).ingest(c, h));
    expect(f.calls, 'the repository must not be reached').toEqual([]);
    return reasons;
  };
  it('malformed handoffs: not an object, wrong layers, wrong status, missing payload, wrong contract version', async () => {
    expect(await refuse(null)).toEqual(['handoff_required']);
    expect(await refuse(handoff({}, { sourceLayer: 'DAL' as never }))).toContain('source_layer_must_be_BO');
    expect(await refuse(handoff({}, { targetLayer: 'DT' as never }))).toContain('target_layer_must_be_BI');
    expect(await refuse(handoff({}, { status: 'failed' as never }))).toContain('handoff_status_must_be_ready');
    expect(await refuse({ ...handoff(), payload: undefined })).toContain('payload_required');
    expect(await refuse(handoff({ contractVersion: '9.9.9' as never }))).toContain('contract_version_unsupported');
  });
  it('a package BO has not made intake-able, an inverted period, a negative count and a forbidden BI conclusion are refused', async () => {
    expect(await refuse(handoff({ packageStatus: 'draft' as never }))).toContain('package_status_not_intakable');
    expect(await refuse(handoff({ periodStart: '2026-11-01T00:00:00.000Z', periodEnd: '2026-10-01T00:00:00.000Z' }))).toContain('period_order_invalid');
    expect(await refuse(handoff({ recordCount: -1 }))).toContain('record_count_invalid');
    expect(await refuse(handoff({ insight: 'x' } as never))).toContain('forbidden_field_insight');
  });
  it('the scope is the caller scope: another tenant or workspace in the handoff is refused, and the handoff can never choose the scope', async () => {
    expect(await refuse(handoff({ tenantId: '99999999-9999-4999-8999-999999999999' }))).toContain('tenant_differs_from_caller');
    expect(await refuse(handoff({ workspaceId: '99999999-9999-4999-8999-999999999999' }))).toContain('workspace_differs_from_caller');
    expect(await refuse(handoff(), { ...ctx, tenantId: '99999999-9999-4999-8999-999999999999' })).toContain('tenant_differs_from_caller');
  });
  it('identifiers must be UUIDs (so a bad one never reaches the database as a raw driver error) and the key must be bound to the package', async () => {
    expect(await refuse(handoff({ businessId: 'biz-1' }))).toContain('business_id_not_a_uuid');
    expect(await refuse(handoff({ boPublicationPackageId: 'p-1', idempotencyKey: 'bo-to-bi:p-1:1' }))).toContain('bo_publication_package_id_not_a_uuid');
    expect(await refuse(handoff({}, { handoffId: 'h-1' }))).toContain('handoff_id_not_a_uuid');
    expect(await refuse(handoff({ idempotencyKey: `bo-to-bi:${CID}:1` }))).toContain('idempotency_key_not_bound_to_the_package');
    expect(await refuse(handoff({ idempotencyKey: 'whatever' }))).toContain('idempotency_key_not_bound_to_the_package');
  });
  it('a target that is not a BI block, or an envelope that disagrees with its payload, is refused', async () => {
    expect(await refuse(handoff({ targetBlock: 'DT-01' }, { targetBlock: 'DT-01' }))).toContain('target_block_is_not_a_bi_block');
    expect(await refuse(handoff({}, { targetBlock: 'BI-12' }))).toContain('envelope_target_block_differs_from_payload');
  });
  it('refusal messages carry reason codes only, never the values supplied', async () => {
    const secret = 'SSN-123-45-6789';
    const f = fakeRepo();
    const error = await new BusinessIntelligenceIntakeService(f.repo).ingest(ctx, handoff({ businessId: secret, targetBlock: secret }, { targetBlock: secret })).then(() => null, (e: Error) => e);
    expect(error).toBeInstanceOf(BiIntakeRejectedError);
    expect((error as Error).message).not.toContain(secret);
  });
});

describe('BusinessIntelligenceIntakeService: what a good handoff asks of the repository', () => {
  it('passes the caller scope, the derived domain and exactly the claims of the handoff, and maps the outcome', async () => {
    const f = fakeRepo({ outcome: 'VALIDATED', intakePackageId: 'i-9', versionNumber: 1, idempotentReplay: false });
    const out = await new BusinessIntelligenceIntakeService(f.repo).ingest(ctx, handoff());
    expect(out).toEqual({ outcome: 'VALIDATED', intakePackageId: 'i-9', domain: 'inventory_supply', versionNumber: 1, idempotentReplay: false });
    expect(f.calls).toEqual([{
      businessId: B, boPublicationPackageId: PKG, boHandoffRecordId: HID, intakeCode: 'bo:inv-2026-10', domain: 'inventory_supply', idempotencyKey: `bo-to-bi:${PKG}:2`,
      schemaVersion: '1.0',
      claimed: { packageCode: 'inv-2026-10', targetBlock: 'BI-16', periodStart: '2026-10-01T00:00:00.000Z', periodEnd: '2026-11-01T00:00:00.000Z', recordCount: 42, payloadReference: { k: 'v', n: 1 }, packageStatus: 'dispatched' },
      correlationId: CID, handoffId: HID, contractVersion: BO_TO_BI_CONTRACT_VERSION,
    }]);
  });
  it('is deterministic: the same handoff always produces the same repository request', async () => {
    const a = fakeRepo(); const b = fakeRepo();
    await new BusinessIntelligenceIntakeService(a.repo).ingest(ctx, handoff());
    await new BusinessIntelligenceIntakeService(b.repo).ingest(ctx, handoff());
    expect(a.calls).toEqual(b.calls);
  });
  it('a rejection recorded by the repository is returned (not thrown) with its reasons; an unknown BO package is refused', async () => {
    const rejected = fakeRepo({ outcome: 'REJECTED', intakePackageId: 'i-1', reasons: ['claimed_record_count_differs_from_bo'], idempotentReplay: false });
    expect(await new BusinessIntelligenceIntakeService(rejected.repo).ingest(ctx, handoff())).toEqual({
      outcome: 'REJECTED', intakePackageId: 'i-1', domain: 'inventory_supply', reasons: ['claimed_record_count_differs_from_bo'], idempotentReplay: false,
    });
    const unknown = fakeRepo({ outcome: 'UNKNOWN_PACKAGE', reasons: ['bo_publication_package_not_found_in_scope'] });
    expect(await reasonsOf(new BusinessIntelligenceIntakeService(unknown.repo).ingest(ctx, handoff()))).toEqual(['bo_publication_package_not_found_in_scope']);
  });
  it('the input handoff is not mutated', async () => {
    const h = handoff(); const snapshot = JSON.stringify(h);
    await new BusinessIntelligenceIntakeService(fakeRepo().repo).ingest(ctx, h);
    expect(JSON.stringify(h)).toBe(snapshot);
  });
});
