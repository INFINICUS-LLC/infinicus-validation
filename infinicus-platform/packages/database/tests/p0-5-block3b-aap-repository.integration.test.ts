/**
 * P0-5 Block 3b - live PostgreSQL proof of AuthorizedActionPackageRepository.
 *
 * The repository stores sealed packages and records lifecycle facts. There is no issuer, BO receipt, event emission or
 * ABA->BO wiring here, and the repository takes already-sealed documents (validation by the contract is the issuer's job).
 *
 * Requires:
 *   DATABASE_URL       - least-privilege application role (RLS enforced): the repository runs as this role
 *   ADMIN_DATABASE_URL - privileged role: builds upstream fixtures and records facts the repository must not (CONSUMED)
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- fixtures deliberately mutate arbitrary paths of a JSON document */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { closePool, createPool, type TenantContext } from '../src/client.js';
import {
  AuthorizedActionPackageRepository, columnsFromDocument, MAX_LIFECYCLE_REASON_LENGTH,
} from '../src/repositories/approved_action/AuthorizedActionPackageRepository.js';
import { ConflictError, NotFoundError, ValidationError } from '../src/repositories/approved_action/errors.js';
import { HOUR, makeFixture, version, type Fixture, type VersionOpts } from './helpers/aapFixtures.js';

const run = Boolean(process.env.DATABASE_URL && process.env.ADMIN_DATABASE_URL);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MS_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

let admin: Pool;
const repo = new AuthorizedActionPackageRepository();

const ctxOf = (f: Fixture): TenantContext => ({ tenantId: f.tenantId, workspaceId: f.workspaceId, userId: randomUUID() });
const docOf = (f: Fixture, o: VersionOpts): any => JSON.parse(version(f, o).package as string);

/** A fixture with its header created through the repository, ready for a document. */
async function withHeader(decisionStatus = 'approved') {
  const f = await makeFixture(admin, decisionStatus);
  const ctx = ctxOf(f);
  const header = await repo.ensureHeader(ctx, { businessId: f.businessId, actionId: f.actionId, decisionId: f.decisionId });
  return { f, ctx, header, id: header.id };
}

describe.runIf(run)('P0-5 Block 3b: AuthorizedActionPackageRepository', () => {
  beforeAll(() => {
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
    createPool({ connectionString: process.env.DATABASE_URL as string });
  });
  afterAll(async () => {
    await admin?.end();
    await closePool();
  });

  describe('ensureHeader', () => {
    it('creates one identity per authorized action and is idempotent', async () => {
      const f = await makeFixture(admin);
      const ctx = ctxOf(f);
      const input = { businessId: f.businessId, actionId: f.actionId, decisionId: f.decisionId };
      const a = await repo.ensureHeader(ctx, input);
      const b = await repo.ensureHeader(ctx, input);
      expect(UUID.test(a.id)).toBe(true);
      expect(b).toEqual(a);
      expect(await repo.getHeaderByActionId(ctx, f.actionId)).toEqual(a);
    });

    it('is safe under concurrency: simultaneous callers get the same identity', async () => {
      const f = await makeFixture(admin);
      const ctx = ctxOf(f);
      const input = { businessId: f.businessId, actionId: f.actionId, decisionId: f.decisionId };
      const ids = await Promise.all(Array.from({ length: 6 }, () => repo.ensureHeader(ctx, input).then((h) => h.id)));
      expect(new Set(ids).size).toBe(1);
    });

    it('refuses to re-point an action to a different decision', async () => {
      const { f, ctx } = await withHeader();
      const other = await makeFixture(admin);
      await expect(repo.ensureHeader(ctx, { businessId: f.businessId, actionId: f.actionId, decisionId: other.decisionId }))
        .rejects.toBeInstanceOf(ConflictError);
    });

    it('rejects malformed ids before touching the database, and an action that does not belong to the decision', async () => {
      const f = await makeFixture(admin);
      const ctx = ctxOf(f);
      await expect(repo.ensureHeader(ctx, { businessId: 'x', actionId: f.actionId, decisionId: f.decisionId })).rejects.toBeInstanceOf(ValidationError);
      const other = await makeFixture(admin);
      await expect(repo.ensureHeader(ctx, { businessId: f.businessId, actionId: f.actionId, decisionId: other.decisionId })).rejects.toThrow();
    });

    it('is confined to the caller tenant', async () => {
      const { f } = await withHeader();
      const stranger = ctxOf(await makeFixture(admin));
      expect(await repo.getHeaderByActionId(stranger, f.actionId)).toBeNull();
    });
  });

  describe('insertVersion / reads', () => {
    it('stores the sealed document exactly and reads it back', async () => {
      const { f, ctx, id } = await withHeader();
      const doc = docOf(f, { packageId: id });
      const stored = await repo.insertVersion(ctx, doc);
      expect(stored.document).toEqual(doc);
      expect(stored.digest).toBe(doc.integrity.digest);
      expect(stored.packageVersion).toBe(1);
      expect(stored.supersedesPackageVersion).toBeNull();
      expect(stored.automationLevel).toBe(2);
      expect(stored.authorizationMode).toBe('HUMAN_APPROVAL');
      expect(stored.issuedAt).toMatch(MS_UTC);
      expect(await repo.getVersion(ctx, id, 1)).toEqual(stored);
      expect(await repo.getLatestVersion(ctx, id)).toEqual(stored);
      expect(await repo.getVersion(ctx, id, 2)).toBeNull();
    });

    it('records ISSUED for a new version and SUPERSEDED on its predecessor', async () => {
      const { f, ctx, id } = await withHeader();
      await repo.insertVersion(ctx, docOf(f, { packageId: id, version: 1 }));
      await repo.insertVersion(ctx, docOf(f, { packageId: id, version: 2 }));
      expect((await repo.listLifecycle(ctx, id, 1)).map((e) => e.state)).toEqual(['ISSUED', 'SUPERSEDED']);
      expect((await repo.listLifecycle(ctx, id, 2)).map((e) => e.state)).toEqual(['ISSUED']);
      expect((await repo.getLatestVersion(ctx, id))?.packageVersion).toBe(2);
    });

    it('is idempotent: replaying the identical package returns the stored row, including after supersession', async () => {
      const { f, ctx, id } = await withHeader();
      const v1 = docOf(f, { packageId: id, version: 1 });
      const v2 = docOf(f, { packageId: id, version: 2 });
      const first = await repo.insertVersion(ctx, v1);
      expect((await repo.insertVersion(ctx, v1)).id).toBe(first.id);
      const second = await repo.insertVersion(ctx, v2);
      expect((await repo.insertVersion(ctx, v2)).id).toBe(second.id);
      expect((await repo.insertVersion(ctx, v1)).id).toBe(first.id);
      expect((await repo.listLifecycle(ctx, id, 1)).map((e) => e.state)).toEqual(['ISSUED', 'SUPERSEDED']);
    });

    it('is safe under concurrency: simultaneous identical inserts store one version', async () => {
      const { f, ctx, id } = await withHeader();
      const doc = docOf(f, { packageId: id });
      const rows = await Promise.all(Array.from({ length: 6 }, () => repo.insertVersion(ctx, doc)));
      expect(new Set(rows.map((r) => r.id)).size).toBe(1);
      expect((await repo.listLifecycle(ctx, id, 1)).filter((e) => e.state === 'ISSUED')).toHaveLength(1);
    });

    it('refuses a different package for an already-stored version', async () => {
      const { f, ctx, id } = await withHeader();
      await repo.insertVersion(ctx, docOf(f, { packageId: id }));
      await expect(repo.insertVersion(ctx, docOf(f, { packageId: id }))).rejects.toBeInstanceOf(ConflictError);
    });

    it('refuses a package whose scope is not the caller scope', async () => {
      const { f, id } = await withHeader();
      const stranger = ctxOf(await makeFixture(admin));
      await expect(repo.insertVersion(stranger, docOf(f, { packageId: id }))).rejects.toBeInstanceOf(ValidationError);
    });

    it.each<[string, (d: any) => void]>([
      ['a missing digest', (d) => { delete d.integrity.digest; }],
      ['a malformed digest', (d) => { d.integrity.digest = 'sha256:ABC'; }],
      ['a non-uuid package id', (d) => { d.identity.packageId = 'nope'; }],
      ['version 0', (d) => { d.identity.packageVersion = 0; }],
      ['a fractional version', (d) => { d.identity.packageVersion = 1.5; }],
      ['level 1', (d) => { d.action.automationLevel.level = 1; }],
      ['an unknown mode', (d) => { d.authorization.mode = 'ANYONE'; }],
      ['a non-millisecond issuedAt', (d) => { d.issuance.issuedAt = '2026-01-01T00:00:00Z'; }],
      ['an UNAVAILABLE expiry', (d) => { d.validity.expiresAt = { state: 'UNAVAILABLE', source: 'x' }; }],
      ['a missing scope', (d) => { delete d.scope; }],
      ['a blank issuer', (d) => { d.issuance.issuerComponent = '  '; }],
    ])('rejects %s before touching the database', async (_name, mutate) => {
      const { f, ctx, id } = await withHeader();
      const doc = docOf(f, { packageId: id });
      mutate(doc);
      await expect(repo.insertVersion(ctx, doc)).rejects.toBeInstanceOf(ValidationError);
    });

    it('rejects non-objects and oversize documents', async () => {
      const { f, ctx, id } = await withHeader();
      for (const bad of [null, 'x', 42, [], undefined]) {
        await expect(repo.insertVersion(ctx, bad)).rejects.toBeInstanceOf(ValidationError);
      }
      const big = docOf(f, { packageId: id });
      big.padding = 'x'.repeat(300 * 1024);
      await expect(repo.insertVersion(ctx, big)).rejects.toBeInstanceOf(ValidationError);
    });

    it('still lets the database refuse what the repository cannot see (unapproved decision)', async () => {
      const { f, ctx, id } = await withHeader('draft');
      await expect(repo.insertVersion(ctx, docOf(f, { packageId: id, decisionStatus: 'draft' }))).rejects.toThrow(/decision is not approved/);
      expect(await repo.getVersion(ctx, id, 1)).toBeNull();
    });

    it('does not expose another tenant\'s package', async () => {
      const { f, ctx, id } = await withHeader();
      await repo.insertVersion(ctx, docOf(f, { packageId: id }));
      const stranger = ctxOf(await makeFixture(admin));
      expect(await repo.getVersion(stranger, id, 1)).toBeNull();
      expect(await repo.getLatestVersion(stranger, id)).toBeNull();
      expect(await repo.listLifecycle(stranger, id, 1)).toEqual([]);
      expect(await repo.getAuthoritativeStatus(stranger, id, 1)).toBeNull();
    });
  });

  describe('getAuthoritativeStatus (derived, database clock)', () => {
    it('answers ISSUED for a live package and echoes the digest', async () => {
      const { f, ctx, id } = await withHeader();
      const doc = docOf(f, { packageId: id });
      await repo.insertVersion(ctx, doc);
      const status = await repo.getAuthoritativeStatus(ctx, id, 1);
      expect(status).toMatchObject({ packageId: id, packageVersion: 1, digest: doc.integrity.digest, lifecycle: 'ISSUED', latestPackageVersion: 1 });
      expect(status?.verifiedAt).toMatch(MS_UTC);
      expect(Math.abs(Date.parse(status!.verifiedAt) - Date.now())).toBeLessThan(5000);
    });

    it('answers SUPERSEDED for the old version and reports the latest version', async () => {
      const { f, ctx, id } = await withHeader();
      await repo.insertVersion(ctx, docOf(f, { packageId: id, version: 1 }));
      await repo.insertVersion(ctx, docOf(f, { packageId: id, version: 2 }));
      expect(await repo.getAuthoritativeStatus(ctx, id, 1)).toMatchObject({ lifecycle: 'SUPERSEDED', latestPackageVersion: 2 });
      expect(await repo.getAuthoritativeStatus(ctx, id, 2)).toMatchObject({ lifecycle: 'ISSUED', latestPackageVersion: 2 });
    });

    it('answers null for an unknown version', async () => {
      const { ctx, id } = await withHeader();
      expect(await repo.getAuthoritativeStatus(ctx, id, 1)).toBeNull();
      await expect(repo.getAuthoritativeStatus(ctx, 'nope', 1)).rejects.toBeInstanceOf(ValidationError);
      await expect(repo.getAuthoritativeStatus(ctx, id, 0)).rejects.toBeInstanceOf(ValidationError);
    });

    it('derives EXPIRED from the database clock even when nobody has recorded it', async () => {
      const { f, ctx, id } = await withHeader();
      const past = new Date(Math.floor(Date.now() / 1000) * 1000 - 2 * HOUR);
      await repo.insertVersion(ctx, docOf(f, { packageId: id, issuedAt: past, expiresAt: new Date(past.getTime() + HOUR) }));
      expect((await repo.listLifecycle(ctx, id, 1)).map((e) => e.state)).toEqual(['ISSUED']);
      expect((await repo.getAuthoritativeStatus(ctx, id, 1))?.lifecycle).toBe('EXPIRED');
    });

    it('answers ISSUED for a package with no expiry bound', async () => {
      const { f, ctx, id } = await withHeader();
      await repo.insertVersion(ctx, docOf(f, { packageId: id, expiresAt: null }));
      expect((await repo.getAuthoritativeStatus(ctx, id, 1))?.lifecycle).toBe('ISSUED');
    });

    it('lets a recorded terminal fact win, including CONSUMED recorded from outside the repository', async () => {
      const { f, ctx, id } = await withHeader();
      await repo.insertVersion(ctx, docOf(f, { packageId: id }));
      await admin.query(
        `INSERT INTO approved_business_action.authorized_action_package_lifecycle_events
           (tenant_id, workspace_id, business_id, package_id, package_version, state, correlation_id, consumption_receipt_id)
         VALUES ($1,$2,$3,$4,1,'CONSUMED',$5,$6)`,
        [f.tenantId, f.workspaceId, f.businessId, id, randomUUID(), randomUUID()],
      );
      expect((await repo.getAuthoritativeStatus(ctx, id, 1))?.lifecycle).toBe('CONSUMED');
    });
  });

  describe('revoke', () => {
    const input = (over: Record<string, unknown> = {}) => ({ actorUserId: 'owner-1', reason: 'wrong target', correlationId: randomUUID(), ...over });

    it('records an attributable, reasoned REVOKED fact and leaves the document untouched', async () => {
      const { f, ctx, id } = await withHeader();
      const stored = await repo.insertVersion(ctx, docOf(f, { packageId: id }));
      const event = await repo.revoke(ctx, id, 1, input());
      expect(event).toMatchObject({ state: 'REVOKED', actorType: 'user', actorId: 'owner-1', reason: 'wrong target' });
      expect((await repo.getAuthoritativeStatus(ctx, id, 1))?.lifecycle).toBe('REVOKED');
      expect(await repo.getVersion(ctx, id, 1)).toEqual(stored);
    });

    it('cannot revoke twice, and cannot revoke after another terminal fact', async () => {
      const { f, ctx, id } = await withHeader();
      await repo.insertVersion(ctx, docOf(f, { packageId: id, version: 1 }));
      await repo.insertVersion(ctx, docOf(f, { packageId: id, version: 2 }));
      await expect(repo.revoke(ctx, id, 1, input())).rejects.toBeInstanceOf(ConflictError); // already SUPERSEDED
      await repo.revoke(ctx, id, 2, input());
      await expect(repo.revoke(ctx, id, 2, input())).rejects.toBeInstanceOf(ConflictError);
    });

    it('cannot revoke after consumption (a BO stop instruction, not a state change)', async () => {
      const { f, ctx, id } = await withHeader();
      await repo.insertVersion(ctx, docOf(f, { packageId: id }));
      await admin.query(
        `INSERT INTO approved_business_action.authorized_action_package_lifecycle_events
           (tenant_id, workspace_id, business_id, package_id, package_version, state, correlation_id, consumption_receipt_id)
         VALUES ($1,$2,$3,$4,1,'CONSUMED',$5,$6)`,
        [f.tenantId, f.workspaceId, f.businessId, id, randomUUID(), randomUUID()],
      );
      await expect(repo.revoke(ctx, id, 1, input())).rejects.toBeInstanceOf(ConflictError);
    });

    it('requires an actor and a bounded, non-blank reason', async () => {
      const { f, ctx, id } = await withHeader();
      await repo.insertVersion(ctx, docOf(f, { packageId: id }));
      await expect(repo.revoke(ctx, id, 1, input({ actorUserId: ' ' }))).rejects.toBeInstanceOf(ValidationError);
      await expect(repo.revoke(ctx, id, 1, input({ reason: '   ' }))).rejects.toBeInstanceOf(ValidationError);
      await expect(repo.revoke(ctx, id, 1, input({ reason: 'x'.repeat(MAX_LIFECYCLE_REASON_LENGTH + 1) }))).rejects.toBeInstanceOf(ValidationError);
      await expect(repo.revoke(ctx, id, 1, input({ correlationId: 'nope' }))).rejects.toBeInstanceOf(ValidationError);
      expect((await repo.getAuthoritativeStatus(ctx, id, 1))?.lifecycle).toBe('ISSUED');
    });

    it('is NotFound for an unknown version and for another tenant', async () => {
      const { f, ctx, id } = await withHeader();
      await repo.insertVersion(ctx, docOf(f, { packageId: id }));
      await expect(repo.revoke(ctx, id, 9, input())).rejects.toBeInstanceOf(NotFoundError);
      const stranger = ctxOf(await makeFixture(admin));
      await expect(repo.revoke(stranger, id, 1, input())).rejects.toBeInstanceOf(NotFoundError);
    });

    it('only one of several simultaneous revocations wins', async () => {
      const { f, ctx, id } = await withHeader();
      await repo.insertVersion(ctx, docOf(f, { packageId: id }));
      const results = await Promise.allSettled(Array.from({ length: 5 }, () => repo.revoke(ctx, id, 1, input())));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected' && r.reason instanceof ConflictError)).toHaveLength(4);
    });
  });

  describe('recordExpiryIfDue (idempotent detection, no scheduler)', () => {
    const past = () => new Date(Math.floor(Date.now() / 1000) * 1000 - 2 * HOUR);

    it('records EXPIRED once the stored expiry has passed, and only once', async () => {
      const { f, ctx, id } = await withHeader();
      const issued = past();
      await repo.insertVersion(ctx, docOf(f, { packageId: id, issuedAt: issued, expiresAt: new Date(issued.getTime() + HOUR) }));
      const first = await repo.recordExpiryIfDue(ctx, id, 1, { correlationId: randomUUID() });
      expect(first.recorded).toBe(true);
      expect(first.recorded && first.event).toMatchObject({ state: 'EXPIRED', actorType: 'system' });
      expect(await repo.recordExpiryIfDue(ctx, id, 1, { correlationId: randomUUID() })).toEqual({ recorded: false, reason: 'ALREADY_TERMINAL' });
      expect((await repo.getAuthoritativeStatus(ctx, id, 1))?.lifecycle).toBe('EXPIRED');
    });

    it('records nothing before the expiry, and nothing for a package with no expiry', async () => {
      const a = await withHeader();
      await repo.insertVersion(a.ctx, docOf(a.f, { packageId: a.id }));
      expect(await repo.recordExpiryIfDue(a.ctx, a.id, 1, { correlationId: randomUUID() })).toEqual({ recorded: false, reason: 'NOT_DUE' });
      const b = await withHeader();
      await repo.insertVersion(b.ctx, docOf(b.f, { packageId: b.id, expiresAt: null }));
      expect(await repo.recordExpiryIfDue(b.ctx, b.id, 1, { correlationId: randomUUID() })).toEqual({ recorded: false, reason: 'NOT_APPLICABLE' });
      expect(await repo.listLifecycle(a.ctx, a.id, 1)).toHaveLength(1);
    });

    it('does not record expiry over an earlier terminal fact', async () => {
      const { f, ctx, id } = await withHeader();
      const issued = past();
      await repo.insertVersion(ctx, docOf(f, { packageId: id, issuedAt: issued, expiresAt: new Date(issued.getTime() + HOUR) }));
      await repo.revoke(ctx, id, 1, { actorUserId: 'owner-1', reason: 'withdrawn', correlationId: randomUUID() });
      expect(await repo.recordExpiryIfDue(ctx, id, 1, { correlationId: randomUUID() })).toEqual({ recorded: false, reason: 'ALREADY_TERMINAL' });
    });

    it('is safe under concurrency: simultaneous detections record one fact', async () => {
      const { f, ctx, id } = await withHeader();
      const issued = past();
      await repo.insertVersion(ctx, docOf(f, { packageId: id, issuedAt: issued, expiresAt: new Date(issued.getTime() + HOUR) }));
      const results = await Promise.all(Array.from({ length: 6 }, () => repo.recordExpiryIfDue(ctx, id, 1, { correlationId: randomUUID() })));
      expect(results.filter((r) => r.recorded)).toHaveLength(1);
      expect((await repo.listLifecycle(ctx, id, 1)).filter((e) => e.state === 'EXPIRED')).toHaveLength(1);
    });

    it('is NotFound for an unknown version', async () => {
      const { ctx, id } = await withHeader();
      await expect(repo.recordExpiryIfDue(ctx, id, 1, { correlationId: randomUUID() })).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});

describe('columnsFromDocument (pure; no database)', () => {
  const fixtureDoc = () => {
    const f = { tenantId: randomUUID(), workspaceId: randomUUID(), businessId: randomUUID(), decisionId: randomUUID(), actionId: randomUUID(), actionVersionId: randomUUID() };
    return { f, doc: JSON.parse(version(f, { packageId: randomUUID(), version: 2 }).package as string) };
  };

  it('reads every queryable column from the sealed document', () => {
    const { f, doc } = fixtureDoc();
    const c = columnsFromDocument(doc);
    expect(c).toMatchObject({
      tenantId: f.tenantId, workspaceId: f.workspaceId, businessId: f.businessId,
      packageVersion: 2, supersedesPackageVersion: 1, automationLevel: 2, authorizationMode: 'HUMAN_APPROVAL',
    });
    expect(c.digest).toBe(doc.integrity.digest);
    expect(c.expiresAt).toBe(doc.validity.expiresAt.value);
  });

  it('reports every problem at once rather than the first', () => {
    expect(() => columnsFromDocument({})).toThrow(/identity\.packageId[\s\S]*scope\.tenantId/);
  });

  it('treats NOT_APPLICABLE expiry as null and rejects any other state', () => {
    const { doc } = fixtureDoc();
    doc.validity.expiresAt = { state: 'NOT_APPLICABLE' };
    expect(columnsFromDocument(doc).expiresAt).toBeNull();
    doc.validity.expiresAt = { state: 'UNAVAILABLE', source: 'x' };
    expect(() => columnsFromDocument(doc)).toThrow(/UNAVAILABLE can never be stored/);
  });
});
