/**
 * P0-5 Block 3e - live PostgreSQL proof of the Business Operations package intake boundary (migration 0180).
 * Requires DATABASE_URL (least-privilege app role, RLS enforced) and ADMIN_DATABASE_URL (fixtures / inspection).
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- tests mutate arbitrary JSON documents */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { AuthorizedActionIntakeRepository, closePool, createPool } from '@infinicus/database';
import type { AuthoritativePackageStatusProvider, AuthoritativeStatusAnswer, AuthoritativeStatusRequest, AuthorizedActionPackageV1 } from '@infinicus/handoff-contracts';
import {
  AuthorizedActionIntakeService, PackageIntakeRefusedError, PRODUCTION_BO_CAPABILITIES, explicitCapabilities,
  type BoIntakeContext,
} from '../src/index.js';
import { MIN, answerFor, makeWorld, na, sealedPackage, type World } from './helpers/intakeFixture.js';

const run = Boolean(process.env.DATABASE_URL && process.env.ADMIN_DATABASE_URL);
const S = 'business_operations';
const TEST_CAPABILITY = explicitCapabilities(['inventory_reorder_policy_update@1']);
const MAX_AGE = 10_000;

let admin: Pool;
let world: World;
const ctxOf = (w: World, businessId = w.businessId): BoIntakeContext => ({ tenantId: w.tenantId, workspaceId: w.workspaceId, userId: randomUUID(), businessId });

class StubProvider implements AuthoritativePackageStatusProvider {
  calls = 0;
  constructor(private readonly respond: (pkg: AuthoritativeStatusRequest) => AuthoritativeStatusAnswer | null | Promise<AuthoritativeStatusAnswer | null>) {}
  async getStatus(request: AuthoritativeStatusRequest): Promise<AuthoritativeStatusAnswer | null> {
    this.calls += 1;
    return this.respond(request);
  }
}

/** A provider that answers about `pkg` (optionally altered). */
const providerFor = (pkg: AuthorizedActionPackageV1, over?: Parameters<typeof answerFor>[1]) => new StubProvider(() => answerFor(pkg, over));
const service = (provider: AuthoritativePackageStatusProvider, capabilities = TEST_CAPABILITY) =>
  new AuthorizedActionIntakeService({ statusProvider: provider, statusMaxAgeMs: MAX_AGE, capabilities });
const count = async (sql: string, params: unknown[]): Promise<number> => Number((await admin.query(sql, params)).rows[0].n);
const receipts = (pkg: AuthorizedActionPackageV1) => count(`SELECT count(*) n FROM ${S}.authorized_action_receipts WHERE package_id=$1 AND package_version=$2`, [pkg.identity.packageId, pkg.identity.packageVersion]);
const claims = (pkg: AuthorizedActionPackageV1) => count(`SELECT count(*) n FROM ${S}.authorized_action_claims WHERE package_id=$1 AND package_version=$2`, [pkg.identity.packageId, pkg.identity.packageVersion]);
const attempts = async (pkg: AuthorizedActionPackageV1): Promise<{ outcome: string; refusal_codes: string[] }[]> =>
  (await admin.query(`SELECT outcome, refusal_codes FROM ${S}.authorized_action_intake_attempts WHERE package_id=$1 ORDER BY evaluated_at, id`, [pkg.identity.packageId])).rows;

async function refused(p: Promise<unknown>): Promise<PackageIntakeRefusedError> {
  try { await p; } catch (e) {
    expect(e).toBeInstanceOf(PackageIntakeRefusedError);
    return e as PackageIntakeRefusedError;
  }
  throw new Error('expected the intake to be refused');
}

describe.runIf(run)('P0-5 Block 3e: BO authorized-action intake', () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
    createPool({ connectionString: process.env.DATABASE_URL as string });
    world = await makeWorld(admin);
  });
  afterAll(async () => {
    await admin?.end();
    await closePool();
  });

  describe('happy path (test capability)', () => {
    it('validates, receives (verbatim) and atomically claims a package', async () => {
      const pkg = sealedPackage(world);
      const r = await service(providerFor(pkg)).intake(ctxOf(world), { package: pkg });
      expect(r.outcome).toBe('CLAIMED');
      const row = (await admin.query(`SELECT * FROM ${S}.authorized_action_receipts WHERE id=$1`, [r.receiptId])).rows[0];
      expect(row.package).toEqual(JSON.parse(JSON.stringify(pkg)));
      expect(row).toMatchObject({
        package_id: pkg.identity.packageId, package_version: 1, tenant_id: world.tenantId, workspace_id: world.workspaceId, business_id: world.businessId,
        contract_version: 'aap/1', canonical_version: 'aap-canonical/1', digest_algorithm: 'sha256', digest: pkg.integrity.digest,
      });
      expect(row.validated_at.getTime()).toBeLessThanOrEqual(row.received_at.getTime());
      const claim = (await admin.query(`SELECT * FROM ${S}.authorized_action_claims WHERE id=$1`, [r.claimId])).rows[0];
      expect(claim).toMatchObject({ receipt_id: r.receiptId, digest: pkg.integrity.digest, package_version: 1 });
      expect(claim.claimed_at.getTime()).toBeGreaterThanOrEqual(row.received_at.getTime());
      expect((await attempts(pkg)).map((a) => a.outcome)).toEqual(['CLAIMED']);
    });

    it('the production capability registry does NOT claim inventory_reorder_policy_update@1 (no execution adapter until P0-6)', () => {
      expect(PRODUCTION_BO_CAPABILITIES.supports('inventory_reorder_policy_update', '1')).toBe(false);
      expect(PRODUCTION_BO_CAPABILITIES.supports('anything', '1')).toBe(false);
    });
  });

  describe('refusals before any receipt', () => {
    it('refuses a package whose digest does not match its content', async () => {
      const pkg = sealedPackage(world);
      const tampered: any = JSON.parse(JSON.stringify(pkg));
      tampered.trace.correlationId = randomUUID(); // a content change that is otherwise semantically valid: only the digest can catch it
      const e = await refused(service(providerFor(pkg)).intake(ctxOf(world), { package: tampered }));
      expect(e.codes).toEqual(['DIGEST_MISMATCH']);
      expect(await receipts(pkg)).toBe(0);
      expect((await attempts(pkg)).map((a) => a.outcome)).toEqual(['REFUSED']);
    });

    it.each([[null], ['text'], [{}], [[]], [{ contractVersion: 'aap/9' }]])('refuses a malformed package %j', async (bad) => {
      const provider = new StubProvider(() => null);
      await refused(service(provider).intake(ctxOf(world), { package: bad }));
      expect(provider.calls).toBe(0);
    });

    it('refuses a package for another tenant', async () => {
      const other = await makeWorld(admin);
      const pkg = sealedPackage(other);
      const e = await refused(service(providerFor(pkg)).intake(ctxOf(world), { package: pkg }));
      expect(e.codes).toEqual(['SCOPE_MISMATCH']);
      expect(await receipts(pkg)).toBe(0);
    });

    it('refuses a package for another workspace of the same tenant', async () => {
      const pkg = sealedPackage(world, { scope: { tenantId: world.tenantId, workspaceId: randomUUID(), businessId: world.businessId } });
      expect((await refused(service(providerFor(pkg)).intake(ctxOf(world), { package: pkg }))).codes).toEqual(['SCOPE_MISMATCH']);
    });

    it('refuses a package for another business of the same workspace', async () => {
      const pkg = sealedPackage(world);
      const e = await refused(service(providerFor(pkg)).intake(ctxOf(world, world.otherBusinessId), { package: pkg }));
      expect(e.codes).toEqual(['SCOPE_MISMATCH']);
      expect(await receipts(pkg)).toBe(0);
    });

    it('refuses when the status cannot be obtained (null, or a provider that throws)', async () => {
      for (const respond of [() => null, () => { throw new Error('down'); }]) {
        const pkg = sealedPackage(world);
        const e = await refused(service(new StubProvider(respond as any)).intake(ctxOf(world), { package: pkg }));
        expect(e.codes).toEqual(['STATUS_UNAVAILABLE']);
        expect(await receipts(pkg)).toBe(0);
      }
    });

    it('refuses a stale status answer', async () => {
      const pkg = sealedPackage(world);
      const stale = new Date(Date.now() - MIN).toISOString();
      const e = await refused(service(providerFor(pkg, { status: { verifiedAt: stale }, authority: { verifiedAt: stale } })).intake(ctxOf(world), { package: pkg }));
      expect(e.codes).toEqual(['STATUS_UNVERIFIED']);
      expect(await receipts(pkg)).toBe(0);
    });

    it('refuses a status answer from the future', async () => {
      const pkg = sealedPackage(world);
      const future = new Date(Date.now() + MIN).toISOString();
      expect((await refused(service(providerFor(pkg, { status: { verifiedAt: future } })).intake(ctxOf(world), { package: pkg }))).codes).toEqual(['STATUS_UNVERIFIED']);
    });

    it.each([
      ['digest', (p: AuthorizedActionPackageV1) => ({ status: { digest: `sha256:${'0'.repeat(64)}` } })],
      ['package id', (p: AuthorizedActionPackageV1) => ({ status: { packageId: randomUUID() } })],
      ['package version', (p: AuthorizedActionPackageV1) => ({ status: { packageVersion: 2, latestPackageVersion: 2 } })],
    ])('refuses a status answer about a different %s and stores no receipt', async (_name, over) => {
      const pkg = sealedPackage(world);
      const e = await refused(service(providerFor(pkg, over(pkg) as any)).intake(ctxOf(world), { package: pkg }));
      expect(e.codes).toEqual(['STATUS_UNVERIFIED']);
      expect(await receipts(pkg)).toBe(0);
    });

    it('refuses a malformed status answer', async () => {
      const pkg = sealedPackage(world);
      const e = await refused(service(new StubProvider(() => ({ status: { lifecycle: 'WHATEVER' } } as any))).intake(ctxOf(world), { package: pkg }));
      expect(e.codes).toEqual(['STATUS_UNVERIFIED']);
    });
  });

  describe('received but not executable (identity verified, no claim)', () => {
    it.each([
      ['revoked', { status: { lifecycle: 'REVOKED' } }, 'PACKAGE_REVOKED'],
      ['superseded', { status: { lifecycle: 'SUPERSEDED', latestPackageVersion: 2 } }, 'PACKAGE_SUPERSEDED'],
      ['consumed elsewhere (ABA and BO disagree: fail closed)', { status: { lifecycle: 'CONSUMED' } }, 'PACKAGE_ALREADY_CONSUMED'],
      ['expired per ABA', { status: { lifecycle: 'EXPIRED' } }, 'PACKAGE_EXPIRED'],
      ['not the current version', { status: { latestPackageVersion: 2 } }, 'PACKAGE_NOT_CURRENT_VERSION'],
      ['authority revoked after issuance', { authority: { state: 'REVOKED' } }, 'AUTHORITY_REVOKED'],
      ['authority unverifiable', { authority: { state: 'UNVERIFIABLE' } }, 'AUTHORITY_UNVERIFIABLE'],
      ['authority answer stale', { authority: { verifiedAt: new Date(Date.now() - MIN).toISOString() } }, 'AUTHORITY_UNVERIFIABLE'],
    ] as const)('refuses a package that is %s', async (_name, over, code) => {
      const pkg = sealedPackage(world);
      const e = await refused(service(providerFor(pkg, over as any)).intake(ctxOf(world), { package: pkg }));
      expect(e.codes).toEqual([code]);
      expect(e.receiptId).not.toBeNull();
      expect(await receipts(pkg)).toBe(1);
      expect(await claims(pkg)).toBe(0);
      expect((await attempts(pkg)).map((a) => [a.outcome, a.refusal_codes])).toEqual([['REFUSED', [code]]]);
    });

    it('refuses a package whose own expiry has passed', async () => {
      const pkg = sealedPackage(world, { issuedOffset: -30 * MIN, windowStartOffset: -20 * MIN, windowEndOffset: -MIN });
      const e = await refused(service(providerFor(pkg)).intake(ctxOf(world), { package: pkg }));
      expect(e.codes).toContain('PACKAGE_EXPIRED');
      expect(await claims(pkg)).toBe(0);
    });

    it('refuses a package whose execution window has not opened', async () => {
      const pkg = sealedPackage(world, { windowStartOffset: 30 * MIN, windowEndOffset: 90 * MIN });
      const e = await refused(service(providerFor(pkg)).intake(ctxOf(world), { package: pkg }));
      expect(e.codes).toEqual(['EXECUTION_WINDOW_NOT_OPEN']);
      expect(await claims(pkg)).toBe(0);
    });

    it('with the PRODUCTION capability registry the package is received but never claimable (no adapter yet)', async () => {
      const pkg = sealedPackage(world);
      const productionLike = new AuthorizedActionIntakeService({ statusProvider: providerFor(pkg), statusMaxAgeMs: MAX_AGE });
      const e = await refused(productionLike.intake(ctxOf(world), { package: pkg }));
      expect(e.codes).toEqual(['ACTION_TYPE_UNSUPPORTED_BY_EXECUTOR']);
      expect(await receipts(pkg)).toBe(1);
      expect(await claims(pkg)).toBe(0);
    });

    it('a later fully valid delivery of a received-but-unclaimed package can still be claimed once it becomes executable', async () => {
      const pkg = sealedPackage(world);
      await refused(service(providerFor(pkg, { authority: { state: 'UNVERIFIABLE' } })).intake(ctxOf(world), { package: pkg }));
      const r = await service(providerFor(pkg)).intake(ctxOf(world), { package: pkg });
      expect(r.outcome).toBe('CLAIMED');
      expect(await receipts(pkg)).toBe(1);
      expect((await attempts(pkg)).map((a) => a.outcome)).toEqual(['REFUSED', 'CLAIMED']);
    });
  });

  describe('idempotency, collision and concurrency', () => {
    it('an exact replay returns the existing claim without a second claim and without asking ABA again', async () => {
      const pkg = sealedPackage(world);
      const provider = providerFor(pkg);
      const first = await service(provider).intake(ctxOf(world), { package: pkg });
      const again = await service(provider).intake(ctxOf(world), { package: pkg });
      expect(again.outcome).toBe('REPLAYED');
      expect(again.claimId).toBe(first.claimId);
      expect(again.receiptId).toBe(first.receiptId);
      expect(provider.calls).toBe(1);
      expect(await claims(pkg)).toBe(1);
      expect(await receipts(pkg)).toBe(1);
      expect((await attempts(pkg)).map((a) => a.outcome)).toEqual(['CLAIMED', 'REPLAYED']);
    });

    it('a replay is served even if ABA now says the package is consumed (BO is canonical for consumption)', async () => {
      const pkg = sealedPackage(world);
      await service(providerFor(pkg)).intake(ctxOf(world), { package: pkg });
      const r = await service(providerFor(pkg, { status: { lifecycle: 'CONSUMED' } })).intake(ctxOf(world), { package: pkg });
      expect(r.outcome).toBe('REPLAYED');
    });

    it('rejects a different payload for the same package id and version (hard conflict), whether or not it was claimed', async () => {
      const claimedPkg = sealedPackage(world);
      await service(providerFor(claimedPkg)).intake(ctxOf(world), { package: claimedPkg });
      const forged = sealedPackage(world, { packageId: claimedPkg.identity.packageId, parameters: { reorderPoint: 1, reorderQuantity: 1 } });
      expect(forged.integrity.digest).not.toBe(claimedPkg.integrity.digest);
      const e = await refused(service(providerFor(forged)).intake(ctxOf(world), { package: forged }));
      expect(e.codes).toEqual(['PAYLOAD_COLLISION']);
      expect(await receipts(claimedPkg)).toBe(1);
      expect(await claims(claimedPkg)).toBe(1);

      const unclaimed = sealedPackage(world);
      await refused(service(providerFor(unclaimed, { status: { lifecycle: 'REVOKED' } })).intake(ctxOf(world), { package: unclaimed }));
      const forged2 = sealedPackage(world, { packageId: unclaimed.identity.packageId, parameters: { reorderPoint: 2, reorderQuantity: 2 } });
      expect((await refused(service(providerFor(forged2)).intake(ctxOf(world), { package: forged2 }))).codes).toEqual(['PAYLOAD_COLLISION']);
      const stored = (await admin.query(`SELECT digest FROM ${S}.authorized_action_receipts WHERE package_id=$1`, [unclaimed.identity.packageId])).rows;
      expect(stored.map((r) => r.digest)).toEqual([unclaimed.integrity.digest]);
    });

    it('a forged delivery that ABA does not vouch for cannot occupy a package identity', async () => {
      const real = sealedPackage(world);
      const forged = sealedPackage(world, { packageId: real.identity.packageId, parameters: { reorderPoint: 7, reorderQuantity: 7 } });
      // ABA vouches only for the real package, so the forgery is refused before any receipt exists...
      await refused(service(providerFor(real)).intake(ctxOf(world), { package: forged }));
      expect(await receipts(real)).toBe(0);
      // ...and the real package is still receivable and claimable afterwards.
      expect((await service(providerFor(real)).intake(ctxOf(world), { package: real })).outcome).toBe('CLAIMED');
    });

    it('concurrent deliveries of one package produce exactly one claim; every other caller sees a replay', async () => {
      for (let round = 0; round < 3; round += 1) {
        const pkg = sealedPackage(world);
        const results = await Promise.allSettled(Array.from({ length: 8 }, () => service(providerFor(pkg)).intake(ctxOf(world), { package: pkg })));
        expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
        const outcomes = results.map((r) => (r as PromiseFulfilledResult<any>).value.outcome);
        expect(outcomes.filter((o) => o === 'CLAIMED')).toHaveLength(1);
        expect(outcomes.filter((o) => o === 'REPLAYED')).toHaveLength(7);
        expect(new Set(results.map((r) => (r as PromiseFulfilledResult<any>).value.claimId)).size).toBe(1);
        expect(await claims(pkg)).toBe(1);
        expect(await receipts(pkg)).toBe(1);
      }
    });

    it('different package versions are independent single-use claims', async () => {
      const v1 = sealedPackage(world);
      const v2 = sealedPackage(world, { packageId: v1.identity.packageId, version: 2, supersedes: { packageId: v1.identity.packageId, packageVersion: 1 } });
      expect((await service(providerFor(v1)).intake(ctxOf(world), { package: v1 })).outcome).toBe('CLAIMED');
      expect((await service(providerFor(v2)).intake(ctxOf(world), { package: v2 })).outcome).toBe('CLAIMED');
      expect(await claims(v1)).toBe(1);
      expect(await claims(v2)).toBe(1);
      expect((await service(providerFor(v1)).intake(ctxOf(world), { package: v1 })).outcome).toBe('REPLAYED');
    });
  });

  describe('database guarantees (defence in depth)', () => {
    it('receipts, claims and attempts are immutable: UPDATE, DELETE and TRUNCATE are rejected', async () => {
      const pkg = sealedPackage(world);
      await service(providerFor(pkg)).intake(ctxOf(world), { package: pkg });
      for (const t of ['authorized_action_receipts', 'authorized_action_claims', 'authorized_action_intake_attempts']) {
        await expect(admin.query(`UPDATE ${S}.${t} SET correlation_id = gen_random_uuid() WHERE tenant_id = $1`, [world.tenantId])).rejects.toThrow(/append-only/);
        await expect(admin.query(`DELETE FROM ${S}.${t} WHERE tenant_id = $1`, [world.tenantId])).rejects.toThrow(/append-only/);
        await expect(admin.query(`TRUNCATE ${S}.${t}`)).rejects.toThrow(/append-only|referenced in a foreign key/);
      }
    });

    it('the database refuses a second claim for the same package version even if the application tried', async () => {
      const pkg = sealedPackage(world);
      const r = await service(providerFor(pkg)).intake(ctxOf(world), { package: pkg });
      await expect(admin.query(
        `INSERT INTO ${S}.authorized_action_claims (tenant_id, workspace_id, business_id, receipt_id, package_id, package_version, digest, status_verified_at, correlation_id)
         VALUES ($1,$2,$3,$4,$5,1,$6,date_trunc('milliseconds', now()),gen_random_uuid())`,
        [world.tenantId, world.workspaceId, world.businessId, r.receiptId, pkg.identity.packageId, pkg.integrity.digest],
      )).rejects.toThrow(/authorized_action_claims_single_use|duplicate key/);
    });

    it('the database refuses a second receipt for the same package id and version', async () => {
      const pkg = sealedPackage(world);
      const insert = () => admin.query(
        `INSERT INTO ${S}.authorized_action_receipts (tenant_id, workspace_id, business_id, package_id, package_version, contract_version, canonical_version,
           digest_algorithm, digest, package, validated_at, status_verified_at, correlation_id)
         VALUES ($1,$2,$3,$4,1,'aap/1','aap-canonical/1','sha256',$5,$6::jsonb,date_trunc('milliseconds', now()),date_trunc('milliseconds', now()),gen_random_uuid())`,
        [world.tenantId, world.workspaceId, world.businessId, pkg.identity.packageId, pkg.integrity.digest, JSON.stringify(pkg)],
      );
      await insert();
      await expect(insert()).rejects.toThrow(/authorized_action_receipts_package_key|duplicate key/);
      expect(await receipts(pkg)).toBe(1);
    });

    it('a claim must belong to the same tenant, workspace and business as its receipt', async () => {
      const pkg = sealedPackage(world);
      const r = await service(providerFor(pkg)).intake(ctxOf(world), { package: pkg });
      const other = await makeWorld(admin);
      await expect(admin.query(
        `INSERT INTO ${S}.authorized_action_claims (tenant_id, workspace_id, business_id, receipt_id, package_id, package_version, digest, status_verified_at, correlation_id)
         VALUES ($1,$2,$3,$4,$5,2,$6,date_trunc('milliseconds', now()),gen_random_uuid())`,
        [other.tenantId, other.workspaceId, other.businessId, r.receiptId, pkg.identity.packageId, pkg.integrity.digest],
      )).rejects.toThrow(/foreign key|authorized_action_claims_receipt_fk/);
    });

    it('the database refuses to claim an expired package whatever the application decided', async () => {
      const pkg = sealedPackage(world, { issuedOffset: -30 * MIN, windowStartOffset: -20 * MIN, windowEndOffset: -MIN });
      await expect(new AuthorizedActionIntakeRepository().receiveAndClaim(ctxOf(world), {
        businessId: world.businessId, document: pkg, correlationId: randomUUID(),
        evaluate: () => ({ identityVerified: true, refusalCodes: [], statusVerifiedAt: new Date().toISOString() }),
      })).rejects.toThrow(/expired/);
      // atomic: the receipt written earlier in the same transaction was rolled back with the failed claim
      expect(await receipts(pkg)).toBe(0);
    });

    it('the database refuses to claim before the execution window opens', async () => {
      const pkg = sealedPackage(world, { windowStartOffset: 30 * MIN, windowEndOffset: 90 * MIN });
      await expect(new AuthorizedActionIntakeRepository().receiveAndClaim(ctxOf(world), {
        businessId: world.businessId, document: pkg, correlationId: randomUUID(),
        evaluate: () => ({ identityVerified: true, refusalCodes: [], statusVerifiedAt: new Date().toISOString() }),
      })).rejects.toThrow(/window has not opened/);
      expect(await receipts(pkg)).toBe(0);
    });

    it('receipt columns must agree with the stored document', async () => {
      const pkg = sealedPackage(world);
      await expect(admin.query(
        `INSERT INTO ${S}.authorized_action_receipts (tenant_id, workspace_id, business_id, package_id, package_version, contract_version, canonical_version,
           digest_algorithm, digest, package, validated_at, status_verified_at, correlation_id)
         VALUES ($1,$2,$3,$4,1,'aap/1','aap-canonical/1','sha256',$5,$6::jsonb,date_trunc('milliseconds', now()),date_trunc('milliseconds', now()),gen_random_uuid())`,
        [world.tenantId, world.workspaceId, world.businessId, randomUUID(), pkg.integrity.digest, JSON.stringify(pkg)],
      )).rejects.toThrow(/document_identity/);
    });

    it('RLS: another tenant can neither see nor use this tenant\'s receipts and claims', async () => {
      const pkg = sealedPackage(world);
      await service(providerFor(pkg)).intake(ctxOf(world), { package: pkg });
      const repo = new AuthorizedActionIntakeRepository();
      const other = await makeWorld(admin);
      expect(await repo.getReceipt(ctxOf(world), pkg.identity.packageId, 1)).not.toBeNull();
      expect(await repo.getReceipt(ctxOf(other), pkg.identity.packageId, 1)).toBeNull();
      expect(await repo.getClaim(ctxOf(other), pkg.identity.packageId, 1)).toBeNull();
      const same = await repo.getClaim(ctxOf(world), pkg.identity.packageId, 1);
      expect(same?.digest).toBe(pkg.integrity.digest);
    });
  });

  describe('no side effects', () => {
    it('does not mutate inventory, produce execution evidence, emit events or touch ABA storage', async () => {
      // an existing inventory policy for this business, written by fixture
      const itemId = randomUUID(); const whId = randomUUID(); const balId = randomUUID();
      const c = await admin.connect();
      try {
        await c.query('BEGIN');
        await c.query("SET LOCAL session_replication_role = 'replica'");
        await c.query(`INSERT INTO business_operations.inventory_balances (id, tenant_id, workspace_id, business_id, inventory_item_id, warehouse_id, quantity_on_hand, reorder_point, reorder_quantity)
                       VALUES ($1,$2,$3,$4,$5,$6,100,3,7)`, [balId, world.tenantId, world.workspaceId, world.businessId, itemId, whId]);
        await c.query('COMMIT');
      } finally { c.release(); }
      const snapshot = async () => ({
        balance: (await admin.query('SELECT reorder_point, reorder_quantity, quantity_on_hand, version, updated_at FROM business_operations.inventory_balances WHERE id=$1', [balId])).rows[0],
        movements: await count('SELECT count(*) n FROM business_operations.inventory_movements WHERE tenant_id=$1', [world.tenantId]),
        businessEvents: await count('SELECT count(*) n FROM business_operations.business_events WHERE tenant_id=$1', [world.tenantId]),
        outbox: await count('SELECT count(*) n FROM events.outbox_events WHERE tenant_id=$1', [world.tenantId]),
        ledger: await count('SELECT count(*) n FROM events.business_event_ledger WHERE tenant_id=$1', [world.tenantId]),
        aba: await count(
          `SELECT coalesce(sum((xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM approved_business_action.%I WHERE tenant_id = %L', table_name, $1::text), false, true, '')))[1]::text::int), 0) n
             FROM information_schema.tables WHERE table_schema = 'approved_business_action' AND table_type = 'BASE TABLE'`, [world.tenantId]),
      });
      const before = await snapshot();
      const pkg = sealedPackage(world, { parameters: { reorderPoint: 999, reorderQuantity: 888 } });
      expect((await service(providerFor(pkg)).intake(ctxOf(world), { package: pkg })).outcome).toBe('CLAIMED');
      expect(await snapshot()).toEqual(before);
      expect(before.balance).toMatchObject({ reorder_point: '3.0000', reorder_quantity: '7.0000' });
    });
  });
});
