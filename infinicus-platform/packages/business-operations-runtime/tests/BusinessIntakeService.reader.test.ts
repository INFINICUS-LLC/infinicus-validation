/**
 * V-07 residual: BusinessIntakeService takes the published package, its submissions and its provenance from the DAL-owned PublicationIntakeReader, and
 * keeps every check it made when it ran its own SQL. The reader and the delivery repository are stubs here, so each check is proven on its own: a
 * mutation that drops one of them must fail a test. Only the transaction wrapper is real (DATABASE_URL), no Data Acquisition row is touched.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, createPool, type TenantContext } from '@infinicus/database';
import type { PublicationIntakeReader, PublicationDeliveryRepository, PublicationPackageForIntake } from '@infinicus/database';
import { DAL_TO_BO_CONTRACT_VERSION, type DALToBOHandoff } from '@infinicus/handoff-contracts';
import { BusinessIntakeService } from '../src/intake/BusinessIntakeService.js';
import { BusinessIntakeRejectedError } from '../src/errors.js';
import type { OperationalCommandExecutor } from '../src/OperationalCommandExecutor.js';

const RUN = !!process.env.DATABASE_URL;
const T = '42222222-4200-4000-8000-000000000001';
const W = '42222222-4200-4000-8000-000000000002';
const U = '42222222-4200-4000-8000-000000000003';
const B = '42222222-4200-4000-8000-000000000004';
const PKG = '42222222-4200-4000-8000-000000000005';
const RUNID = '42222222-4200-4000-8000-000000000006';
const ctx: TenantContext = { tenantId: T, workspaceId: W, userId: U };

const handoff = (over: { recordCount?: number } = {}): DALToBOHandoff => ({
  handoffId: '42222222-4200-4000-8000-000000000007', sourceLayer: 'DAL', sourceBlock: 'DA-24', targetLayer: 'BO', targetBlock: 'BO-1', correlationId: 'c', lineage: [],
  status: 'ready', createdAt: '2026-10-22T00:00:00.000Z',
  payload: {
    contractVersion: DAL_TO_BO_CONTRACT_VERSION, tenantId: T, workspaceId: W, businessId: B, publicationPackageId: PKG, packageType: 'operations_data', packageVersion: '1',
    targetLayer: 'business_operations', targetBlock: 'BO-1', status: 'published', publishedAt: '2026-10-22T00:00:00.000Z', recordCount: over.recordCount ?? 0,
    source: { sourceSystem: 'INFINICUS_DA', dataReference: { collectionRunId: RUNID } }, schemaReferenceId: null,
    quality: { qualityScore: 0.95, reliabilityScore: 0.95 }, provenanceReferenceIds: over.recordCount ? ['p'] : [], consentReferenceIds: [], limitations: [], warnings: [],
    idempotencyKey: 'dal-to-bo:k',
  },
}) as unknown as DALToBOHandoff;

const goodPackage = (over: Partial<PublicationPackageForIntake> = {}): PublicationPackageForIntake => ({
  tenantId: T, workspaceId: W, businessId: B, status: 'published', targetLayer: 'business_operations', recordCount: 0, dataReference: { collectionRunId: RUNID }, ...over,
});

interface Harness { service: BusinessIntakeService; calls: string[] }
function harness(o: {
  failRecording?: boolean;
  pkg?: PublicationPackageForIntake | null; submissions?: { id: string; payload: unknown }[]; provenance?: { id: string; recordReference: string }[]; alreadyDelivered?: boolean;
}): Harness {
  const calls: string[] = [];
  const reader = {
    async lockPackageOn() { calls.push('lock'); return o.pkg === undefined ? goodPackage() : o.pkg; },
    async submissionsForCollectionRunOn() { calls.push('submissions'); return o.submissions ?? [{ id: 's1', payload: { records: [] } }]; },
    async provenanceForCollectionRunOn() { calls.push('provenance'); return o.provenance ?? []; },
  } as unknown as PublicationIntakeReader;
  const deliveries = {
    async beginLayerAttemptOn() { calls.push('begin'); return { deliveryId: 'd1', alreadyDelivered: o.alreadyDelivered ?? false }; },
    async markLayerDeliveredOn() { calls.push('delivered'); },
    async recordLayerFailure(_c: unknown, _p: unknown, _l: unknown, reason: string) {
      calls.push(`failed:${reason}`);
      if (o.failRecording) throw new Error('could not record');
    },
  } as unknown as PublicationDeliveryRepository;
  const executor = { async executeOn() { calls.push('execute'); throw new Error('no command expected'); } } as unknown as OperationalCommandExecutor;
  const service = new BusinessIntakeService(undefined, executor, undefined, undefined, deliveries, reader);
  return { service, calls };
}
const reject = async (h: Harness, hand = handoff()) => {
  const error = await h.service.processHandoff(ctx, hand).then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(BusinessIntakeRejectedError);
  return (error as Error).message;
};

describe.runIf(RUN)('BusinessIntakeService reads Data Acquisition only through the DAL-owned PublicationIntakeReader', () => {
  beforeAll(() => { createPool({ connectionString: process.env.DATABASE_URL! }); });
  afterAll(async () => { await closePool(); });

  it('happy path: locks the package, begins the delivery AFTER the lock, reads submissions and provenance, then acknowledges once', async () => {
    const h = harness({});
    const r = await h.service.processHandoff(ctx, handoff());
    expect(r).toMatchObject({ publicationPackageId: PKG, deliveryId: 'd1', idempotentReplay: false, acceptedRecordCount: 0, commandCount: 0 });
    expect(h.calls).toEqual(['lock', 'begin', 'submissions', 'provenance', 'delivered']);
  });

  it('an unknown package is rejected and Data Acquisition is told of the failure; nothing else is read', async () => {
    const h = harness({ pkg: null });
    expect(await reject(h)).toMatch(/not found/);
    expect(h.calls).toEqual(['lock', expect.stringMatching(/^failed:BusinessIntakeRejectedError/)]);
  });

  it('a package of another tenant or workspace is rejected (defence in depth beyond RLS) before any delivery is begun', async () => {
    for (const pkg of [goodPackage({ tenantId: B }), goodPackage({ workspaceId: B })]) {
      const h = harness({ pkg });
      expect(await reject(h)).toMatch(/scope mismatch/);
      expect(h.calls).not.toContain('begin');
    }
  });

  it('a package of another business is rejected, including a package with no business', async () => {
    for (const pkg of [goodPackage({ businessId: W }), goodPackage({ businessId: null })]) {
      const h = harness({ pkg });
      expect(await reject(h)).toMatch(/business scope mismatch/);
      expect(h.calls).not.toContain('begin');
    }
  });

  it('a package that is not published, or is for another layer, is rejected', async () => {
    for (const pkg of [goodPackage({ status: 'revoked' }), goodPackage({ targetLayer: 'business_intelligence' })]) {
      const h = harness({ pkg });
      expect(await reject(h)).toMatch(/not published for Business Operations/);
      expect(h.calls).not.toContain('begin');
    }
  });

  it('a handoff record count that differs from the persisted package is rejected', async () => {
    const h = harness({ pkg: goodPackage({ recordCount: 3 }) });
    expect(await reject(h)).toMatch(/record count does not match/);
    expect(h.calls).not.toContain('begin');
  });

  it('a package already delivered to BO is an idempotent replay: nothing is read or executed beyond the lock', async () => {
    const h = harness({ alreadyDelivered: true });
    const r = await h.service.processHandoff(ctx, handoff());
    expect(r).toMatchObject({ idempotentReplay: true, commandCount: 0 });
    expect(h.calls).toEqual(['lock', 'begin']);
  });

  it('a package without a collection run reference is rejected after the attempt began, and the failure is reported to Data Acquisition', async () => {
    const h = harness({ pkg: goodPackage({ dataReference: {} }) });
    expect(await reject(h)).toMatch(/no collectionRunId/);
    expect(h.calls).toEqual(['lock', 'begin', expect.stringMatching(/^failed:/)]);
  });

  it('if Data Acquisition cannot record the failure, the caller still receives the ORIGINAL rejection, never the recording error', async () => {
    const h = harness({ pkg: goodPackage({ recordCount: 5 }), failRecording: true });
    expect(await reject(h)).toMatch(/record count does not match/);
    expect(h.calls.some((c) => c.startsWith('failed:'))).toBe(true);
  });

  it('a collection run with no submission is rejected', async () => {
    const h = harness({ submissions: [] });
    expect(await reject(h)).toMatch(/No manual submission/);
    expect(h.calls).not.toContain('delivered');
  });

  it('a record without provenance (rejected by Data Acquisition) is never delivered: the accepted count then differs from the handoff and the intake is rejected', async () => {
    const h = harness({ pkg: goodPackage({ recordCount: 1 }), submissions: [{ id: 's1', payload: { records: [{ any: 1 }] } }], provenance: [] });
    expect(await reject(h, handoff({ recordCount: 1 }))).toMatch(/Accepted-record count mismatch/);
    expect(h.calls).not.toContain('execute');
    expect(h.calls).not.toContain('delivered');
  });

  it('a submission payload without a records array is rejected', async () => {
    const h = harness({ submissions: [{ id: 's1', payload: { nope: true } }] });
    expect(await reject(h)).toMatch(/records array/);
  });
});
