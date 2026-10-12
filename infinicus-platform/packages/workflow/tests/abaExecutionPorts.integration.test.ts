/**
 * P0-6a - live PostgreSQL proof of the ABA-owned execution-boundary ports (status provider, package source, consumption recorder).
 * Requires DATABASE_URL (app role, RLS) and ADMIN_DATABASE_URL (fixtures / inspection / simulated post-issuance changes).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { AutomationLevelPolicyRepository, AuthorizedActionPackageRepository, closePool, createPool } from '@infinicus/database';
import { validateForExecution, validateForExecutionAfterClaim, canonicalActionTypeRegistry } from '@infinicus/handoff-contracts';
import type { AuthoritativeStatusRequest } from '@infinicus/handoff-contracts';
import { AbaAuthorizedActionPackageSource, AbaPackageConsumptionRecorder, AbaPackageStatusProvider, AuthorizedActionPackageIssuer } from '../src/index.js';
import { G, HOUR, S, iso, makeIssuable, makeWorld, type FixtureOptions, type IssuableFixture } from './helpers/issuanceFixture.js';

const run = Boolean(process.env.DATABASE_URL && process.env.ADMIN_DATABASE_URL);
const MS_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe.runIf(run)('P0-6a: ABA execution-boundary ports', () => {
  let admin: Pool;
  const issuer = new AuthorizedActionPackageIssuer();
  const packages = new AuthorizedActionPackageRepository();
  const policies = new AutomationLevelPolicyRepository();
  const ACTOR = randomUUID();
  const provider = new AbaPackageStatusProvider({ actorUserId: ACTOR });
  const source = new AbaAuthorizedActionPackageSource({ actorUserId: ACTOR });
  const recorder = new AbaPackageConsumptionRecorder({ actorUserId: ACTOR });

  beforeAll(() => {
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
    createPool({ connectionString: process.env.DATABASE_URL as string });
  });
  afterAll(async () => { await admin?.end(); await closePool(); });

  interface Issued { f: IssuableFixture; request: AuthoritativeStatusRequest; packageId: string; digest: string; document: Record<string, unknown> }
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  /** A package whose validity bound passes in about five seconds (the stored expiry cannot be edited: it must equal the sealed document). */
  const issuedExpiring = (): Promise<Issued> => issued({ validUntil: new Date(Date.now() + 5000) });
  async function issued(o: FixtureOptions = {}): Promise<Issued> {
    const f = await makeIssuable(admin, await makeWorld(admin), o);
    const r = await issuer.issue(f.ctx, { actionId: f.actionId });
    const scope = { tenantId: f.world.tenantId, workspaceId: f.world.workspaceId, businessId: f.businessId };
    return {
      f, packageId: r.package.identity.packageId, digest: r.package.integrity.digest, document: r.package as unknown as Record<string, unknown>,
      request: { packageId: r.package.identity.packageId, packageVersion: 1, digest: r.package.integrity.digest, scope },
    };
  }
  const events = async (i: Issued) => (await admin.query(`SELECT state, consumption_receipt_id FROM ${S}.authorized_action_package_lifecycle_events WHERE package_id=$1 ORDER BY created_at`, [i.packageId])).rows;
  /** Simulates the approver authority being revoked AFTER issuance (a fixture-only privileged write; triggers off). */
  async function revokeApproverAuthority(i: Issued): Promise<void> {
    const c = await admin.connect();
    try {
      await c.query('BEGIN'); await c.query("SET LOCAL session_replication_role = 'replica'");
      await c.query(`UPDATE ${S}.approver_assignments SET status='revoked' WHERE id=$1`, [i.f.assignmentId]);
      await c.query(`INSERT INTO ${S}.approval_authority_scopes (tenant_id, workspace_id, business_id, assignment_version_id, scope_type, scope_value, created_at) VALUES ($1,$2,$3,$4,'provenance',$5,now())`,
        [i.f.world.tenantId, i.f.world.workspaceId, i.f.businessId, i.f.assignmentVersionId,
          JSON.stringify({ action: 'revoke', state: 'revoked', source: 'manual-admin', businessId: i.f.businessId, assignmentId: i.f.assignmentId, reason: 'left the company' })]);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }

  describe('AbaPackageStatusProvider', () => {
    it('answers ISSUED + CURRENT from one authoritative read, echoing id, version and digest, on the database clock', async () => {
      const i = await issued();
      const a = await provider.getStatus(i.request);
      expect(a).not.toBeNull();
      expect(a!.status).toEqual({
        packageId: i.packageId, packageVersion: 1, digest: i.digest, lifecycle: 'ISSUED', latestPackageVersion: 1,
        verifiedAt: a!.status.verifiedAt, consumptionReceiptId: null,
      });
      expect(a!.status.verifiedAt).toMatch(MS_UTC);
      expect(a!.authority).toEqual({ state: 'CURRENT', verifiedAt: a!.status.verifiedAt });
      expect(Math.abs(Date.now() - Date.parse(a!.status.verifiedAt))).toBeLessThan(5000);
    });

    it('is never cached: every call reads current state and a later change is visible at once', async () => {
      const i = await issued();
      expect((await provider.getStatus(i.request))!.authority.state).toBe('CURRENT');
      await revokeApproverAuthority(i);
      expect((await provider.getStatus(i.request))!.authority.state).toBe('REVOKED');
    });

    it('authority revoked after issuance: REVOKED while the package lifecycle is still ISSUED (two separate facts)', async () => {
      const i = await issued();
      await revokeApproverAuthority(i);
      const a = (await provider.getStatus(i.request))!;
      expect([a.status.lifecycle, a.authority.state]).toEqual(['ISSUED', 'REVOKED']);
    });

    it('ruling O-7: disabling the applicable Level 2 policy after issuance makes authority REVOKED (fail closed)', async () => {
      const i = await issued();
      const effective = (await policies.getEffectivePolicy(i.f.ctx, 2))!;
      await policies.disable(i.f.ctx, effective.policyVersionId, { actorUserId: i.f.approverUserId, reason: 'withdrawn', correlationId: randomUUID() });
      const a = (await provider.getStatus(i.request))!;
      expect([a.status.lifecycle, a.authority.state]).toEqual(['ISSUED', 'REVOKED']);
    });

    it('reports every lifecycle state: REVOKED, CONSUMED (with the receipt) and EXPIRED', { timeout: 30_000 }, async () => {
      const revoked = await issued();
      await packages.revoke(revoked.f.ctx, revoked.packageId, 1, { actorUserId: revoked.f.approverUserId, reason: 'mistake', correlationId: randomUUID() });
      expect((await provider.getStatus(revoked.request))!.status.lifecycle).toBe('REVOKED');

      const consumed = await issued();
      const receiptId = randomUUID();
      await recorder.recordConsumed({ ...consumed.request, receiptId });
      expect((await provider.getStatus(consumed.request))!.status).toMatchObject({ lifecycle: 'CONSUMED', consumptionReceiptId: receiptId });

      const expiring = await issuedExpiring();
      await sleep(5600);
      expect((await provider.getStatus(expiring.request))!.status.lifecycle).toBe('EXPIRED');
    });

    it('returns null for anything it cannot vouch for: other scope, wrong digest, unknown id/version, malformed request', async () => {
      const i = await issued();
      const other = await issued();
      const bad: unknown[] = [
        { ...i.request, scope: { ...i.request.scope, businessId: other.f.businessId } },
        { ...i.request, scope: { ...i.request.scope, workspaceId: other.f.world.workspaceId } },
        { ...i.request, scope: other.request.scope },
        { ...i.request, digest: `sha256:${'0'.repeat(64)}` },
        { ...i.request, digest: other.digest },
        { ...i.request, packageId: randomUUID() },
        { ...i.request, packageId: other.packageId },
        { ...i.request, packageVersion: 2 },
        { ...i.request, packageVersion: 0 },
        { ...i.request, packageVersion: 1.5 },
        { ...i.request, digest: 'nope' },
        { ...i.request, scope: { tenantId: 'x', workspaceId: 'y', businessId: 'z' } },
        { ...i.request, scope: undefined },
        null, undefined, 'x',
      ];
      for (const r of bad) expect(await provider.getStatus(r as AuthoritativeStatusRequest)).toBeNull();
    });

    it('authority is UNVERIFIABLE when the approval facts cannot be loaded (never inferred as CURRENT)', async () => {
      const i = await issued();
      const blind = new AbaPackageStatusProvider({ actorUserId: ACTOR, issuance: { loadSources: async () => null } });
      expect((await blind.getStatus(i.request))!.authority.state).toBe('UNVERIFIABLE');
    });

    it('rejects (rather than answering) on an infrastructure failure, so BO refuses', async () => {
      const i = await issued();
      const broken = new AbaPackageStatusProvider({ actorUserId: ACTOR, packages: { getVersion: async () => { throw new Error('db down'); }, getAuthoritativeStatus: async () => null } });
      await expect(broken.getStatus(i.request)).rejects.toThrow('db down');
    });

    it('requires an ABA system actor (no default identity)', () => {
      expect(() => new AbaPackageStatusProvider({ actorUserId: '' })).toThrow();
      expect(() => new AbaAuthorizedActionPackageSource({ actorUserId: 'x' })).toThrow();
      expect(() => new AbaPackageConsumptionRecorder({ actorUserId: undefined as unknown as string })).toThrow();
    });

    it('its answer drives the contract checks end to end: executable before the claim, and after the claim only for the claim\'s receipt', async () => {
      const i = await issued({ window: G({ startsAt: iso(new Date(Date.now() - HOUR)), endsAt: iso(new Date(Date.now() + 8 * HOUR)) }) });
      const caps = { supports: () => true };
      const pre = (await provider.getStatus(i.request))!;
      const ctxFor = (status: typeof pre.status) => ({ actionTypes: canonicalActionTypeRegistry(), capabilities: caps, now: new Date().toISOString(), scope: i.request.scope, status, statusMaxAgeMs: 5000 });
      expect(validateForExecution(i.document, ctxFor(pre.status)).valid).toBe(true);

      const receiptId = randomUUID();
      await recorder.recordConsumed({ ...i.request, receiptId });
      const post = (await provider.getStatus(i.request))!;
      expect(validateForExecution(i.document, ctxFor(post.status)).errors.map((e) => e.code)).toEqual(['PACKAGE_ALREADY_CONSUMED']);
      expect(validateForExecutionAfterClaim(i.document, { ...ctxFor(post.status), consumptionReceiptId: receiptId }).valid).toBe(true);
      expect(validateForExecutionAfterClaim(i.document, { ...ctxFor(post.status), consumptionReceiptId: randomUUID() }).errors.map((e) => e.code)).toEqual(['PACKAGE_ALREADY_CONSUMED']);
    });
  });

  describe('AbaAuthorizedActionPackageSource', () => {
    it('returns the sealed document and stored digest for the exact id, version and scope', async () => {
      const i = await issued();
      const got = await source.get({ packageId: i.packageId, packageVersion: 1, scope: i.request.scope });
      expect(got).toEqual({ document: i.document, digest: i.digest });
    });

    it('returns null for another scope, unknown version or malformed request, and discloses nothing', async () => {
      const i = await issued();
      const other = await issued();
      for (const r of [
        { packageId: i.packageId, packageVersion: 1, scope: other.request.scope },
        { packageId: i.packageId, packageVersion: 1, scope: { ...i.request.scope, businessId: other.f.businessId } },
        { packageId: i.packageId, packageVersion: 2, scope: i.request.scope },
        { packageId: 'x', packageVersion: 1, scope: i.request.scope },
        null,
      ]) expect(await source.get(r as never)).toBeNull();
    });

    it('is read-only: it writes no lifecycle fact and no audit', async () => {
      const i = await issued();
      const before = (await events(i)).length;
      await source.get({ packageId: i.packageId, packageVersion: 1, scope: i.request.scope });
      expect((await events(i)).length).toBe(before);
    });
  });

  describe('AbaPackageConsumptionRecorder (the R-5 mirror; BO\'s claim stays canonical)', () => {
    it('records CONSUMED with the BO receipt, exactly once, and is idempotent for the same receipt', async () => {
      const i = await issued();
      const receiptId = randomUUID();
      const first = await recorder.recordConsumed({ ...i.request, receiptId });
      expect(first.outcome).toBe('RECORDED');
      const again = await recorder.recordConsumed({ ...i.request, receiptId });
      expect(again.outcome).toBe('ALREADY_RECORDED');
      expect(await events(i)).toEqual([{ state: 'ISSUED', consumption_receipt_id: null }, { state: 'CONSUMED', consumption_receipt_id: receiptId }]);
    });

    it('a different receipt for an already-consumed version is NOT_RECORDABLE(OTHER_RECEIPT) and changes nothing', async () => {
      const i = await issued();
      await recorder.recordConsumed({ ...i.request, receiptId: randomUUID() });
      expect(await recorder.recordConsumed({ ...i.request, receiptId: randomUUID() })).toEqual({ outcome: 'NOT_RECORDABLE', reason: 'OTHER_RECEIPT' });
      expect((await events(i)).filter((e) => e.state === 'CONSUMED')).toHaveLength(1);
    });

    it('a revoked version cannot be mirrored (another terminal fact won); an expired one cannot either', { timeout: 30_000 }, async () => {
      const r = await issued();
      await packages.revoke(r.f.ctx, r.packageId, 1, { actorUserId: r.f.approverUserId, reason: 'mistake', correlationId: randomUUID() });
      expect(await recorder.recordConsumed({ ...r.request, receiptId: randomUUID() })).toEqual({ outcome: 'NOT_RECORDABLE', reason: 'OTHER_TERMINAL_STATE' });

      const e = await issuedExpiring();
      await sleep(5600);
      expect(await recorder.recordConsumed({ ...e.request, receiptId: randomUUID() })).toEqual({ outcome: 'NOT_RECORDABLE', reason: 'EXPIRED' });
    });

    it('refuses an unknown package, another scope, a wrong digest and malformed input - and writes nothing', async () => {
      const i = await issued();
      const other = await issued();
      const receiptId = randomUUID();
      const notFound = { outcome: 'NOT_RECORDABLE', reason: 'NOT_FOUND' };
      expect(await recorder.recordConsumed({ ...i.request, packageId: randomUUID(), receiptId })).toEqual(notFound);
      expect(await recorder.recordConsumed({ ...i.request, scope: other.request.scope, receiptId })).toEqual(notFound);
      expect(await recorder.recordConsumed({ ...i.request, receiptId: 'nope' })).toEqual(notFound);
      expect(await recorder.recordConsumed({ ...i.request, digest: `sha256:${'1'.repeat(64)}`, receiptId })).toEqual({ outcome: 'NOT_RECORDABLE', reason: 'DIGEST_MISMATCH' });
      expect(await events(i)).toEqual([{ state: 'ISSUED', consumption_receipt_id: null }]);
    });

    it('concurrent mirrors of one claim record exactly one fact; competing receipts record exactly one winner', async () => {
      const same = await issued();
      const receiptId = randomUUID();
      const outcomes = await Promise.all(Array.from({ length: 8 }, () => recorder.recordConsumed({ ...same.request, receiptId })));
      expect(outcomes.filter((o) => o.outcome === 'RECORDED')).toHaveLength(1);
      expect(outcomes.filter((o) => o.outcome === 'ALREADY_RECORDED')).toHaveLength(7);

      const race = await issued();
      const results = await Promise.all(Array.from({ length: 8 }, () => recorder.recordConsumed({ ...race.request, receiptId: randomUUID() })));
      expect(results.filter((o) => o.outcome === 'RECORDED')).toHaveLength(1);
      expect(results.filter((o) => o.outcome === 'NOT_RECORDABLE')).toHaveLength(7);
      expect((await events(race)).filter((e) => e.state === 'CONSUMED')).toHaveLength(1);
    });

    it('does not alter the sealed package document or its digest', async () => {
      const i = await issued();
      await recorder.recordConsumed({ ...i.request, receiptId: randomUUID() });
      const got = await source.get({ packageId: i.packageId, packageVersion: 1, scope: i.request.scope });
      expect(got).toEqual({ document: i.document, digest: i.digest });
    });
  });
});
