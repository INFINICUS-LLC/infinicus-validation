/**
 * P0-5 Block 3a - live PostgreSQL proof of migration 0176 (AuthorizedActionPackage persistence).
 *
 * Proves the DATABASE invariants only. There is no issuer, repository, BO receipt, event emission or ABA->BO wiring here.
 *
 * Requires:
 *   ADMIN_DATABASE_URL - privileged role (BYPASSRLS / superuser): builds upstream fixtures and inspects state
 *   DATABASE_URL       - least-privilege application role (RLS enforced): used for the tenant-isolation proof
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- fixtures deliberately mutate arbitrary paths of a JSON document */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { HOUR, makeFixture, version, type Fixture, type VersionOpts } from './helpers/aapFixtures.js';

const run = Boolean(process.env.DATABASE_URL && process.env.ADMIN_DATABASE_URL);

const S = 'approved_business_action';
const PKG = `${S}.authorized_action_packages`;
const VER = `${S}.authorized_action_package_versions`;
const LIFE = `${S}.authorized_action_package_lifecycle_events`;

let admin: Pool;
let app: Pool;

const fixture = (decisionStatus = 'approved') => makeFixture(admin, decisionStatus);

async function insert(table: string, cols: Record<string, unknown>, pool: Pool | PoolClient = admin) {
  const keys = Object.keys(cols);
  const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`;
  return (await pool.query(sql, keys.map((k) => cols[k]))).rows[0];
}

const header = (f: Fixture, id = randomUUID(), over: Record<string, unknown> = {}) =>
  insert(PKG, { id, tenant_id: f.tenantId, workspace_id: f.workspaceId, business_id: f.businessId, action_id: f.actionId, decision_id: f.decisionId, ...over });

const addVersion = (f: Fixture, o: VersionOpts) => insert(VER, version(f, o));

const lifecycle = async (packageId: string, v: number) =>
  (await admin.query(`SELECT * FROM ${LIFE} WHERE package_id=$1 AND package_version=$2 ORDER BY occurred_at, created_at`, [packageId, v])).rows;

async function event(f: Fixture, packageId: string, v: number, state: string, extra: Record<string, unknown> = {}) {
  return insert(LIFE, {
    tenant_id: f.tenantId, workspace_id: f.workspaceId, business_id: f.businessId,
    package_id: packageId, package_version: v, state, correlation_id: randomUUID(), ...extra,
  });
}

describe.runIf(run)('P0-5 Block 3a: migration 0176 database invariants', () => {
  beforeAll(() => {
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
    app = new Pool({ connectionString: process.env.DATABASE_URL });
  });
  afterAll(async () => {
    await admin?.end();
    await app?.end();
  });

  describe('header', () => {
    it('accepts the header of an authorized action and nothing else', async () => {
      const f = await fixture();
      const h = await header(f);
      expect(h.action_id).toBe(f.actionId);
      expect(h).not.toHaveProperty('status');
    });

    it('allows exactly one package identity per authorized action', async () => {
      const f = await fixture();
      await header(f);
      await expect(header(f)).rejects.toThrow(/authorized_action_packages_action_unique/);
    });

    it('rejects a decision that is not the one that authorized the action', async () => {
      const f = await fixture();
      const other = await fixture();
      await expect(header(f, randomUUID(), { decision_id: other.decisionId })).rejects.toThrow(/do not match|foreign key/);
    });

    it('rejects a scope that differs from the action scope', async () => {
      const f = await fixture();
      const other = await fixture();
      await expect(header(f, randomUUID(), { business_id: other.businessId })).rejects.toThrow();
    });
  });

  describe('sealed package version', () => {
    it('stores a well-formed package and writes its ISSUED fact in the same statement', async () => {
      const f = await fixture();
      const id = randomUUID();
      await header(f, id);
      const row = await addVersion(f, { packageId: id });
      const events = await lifecycle(id, 1);
      expect(events.map((e) => e.state)).toEqual(['ISSUED']);
      expect(new Date(events[0].occurred_at).getTime()).toBe(new Date(row.issued_at).getTime());
      expect(events[0].actor_id).toBe('aba.package-issuer');
    });

    it('requires the decision to be approved for a human-approved package', async () => {
      for (const status of ['draft', 'rejected', 'superseded']) {
        const f = await fixture(status);
        const id = randomUUID();
        await header(f, id);
        await expect(addVersion(f, { packageId: id })).rejects.toThrow(/decision is not approved/);
      }
    });

    it('requires the document to state the decision status exactly', async () => {
      const f = await fixture('approved');
      const id = randomUUID();
      await header(f, id);
      await expect(addVersion(f, { packageId: id, decisionStatus: 'approved_with_modifications' })).rejects.toThrow(/decision is not approved/);
    });

    it('accepts approved_with_modifications when the document says so', async () => {
      const f = await fixture('approved_with_modifications');
      const id = randomUUID();
      await header(f, id);
      await addVersion(f, { packageId: id, decisionStatus: 'approved_with_modifications' });
    });

    it('rejects an automation level / authorization mode mismatch even when the document agrees with the columns', async () => {
      const f = await fixture();
      const id = randomUUID();
      await header(f, id);
      // Level 3 declared as HUMAN_APPROVAL, and Level 2 declared as RULE_AUTHORIZED: document and columns agree, only the pairing is wrong.
      await expect(addVersion(f, {
        packageId: id, level: 3,
        overrideColumns: { authorization_mode: 'HUMAN_APPROVAL' },
        overrideDocument: (d) => { d.authorization = { mode: 'HUMAN_APPROVAL', decisionStatus: 'approved' }; },
      })).rejects.toThrow(/mode_matches_level/);
      await expect(addVersion(f, {
        packageId: id, level: 2,
        overrideColumns: { authorization_mode: 'RULE_AUTHORIZED' },
        overrideDocument: (d) => { d.authorization = { mode: 'RULE_AUTHORIZED' }; },
      })).rejects.toThrow(/mode_matches_level/);
    });

    it('rejects Level 0, Level 1 and a mode that contradicts the document', async () => {
      const f = await fixture();
      const id = randomUUID();
      await header(f, id);
      for (const level of [0, 1, 5]) {
        await expect(addVersion(f, { packageId: id, overrideColumns: { automation_level: level } })).rejects.toThrow(/automation_level_check|document_identity|mode_matches_level/);
      }
      await expect(addVersion(f, { packageId: id, overrideColumns: { authorization_mode: 'RULE_AUTHORIZED' } })).rejects.toThrow(/document_identity|mode_matches_level/);
    });

    it.each<[string, (doc: Record<string, any>) => void]>([
      ['contractVersion', (d) => { delete d.contractVersion; }],
      ['packageId', (d) => { delete d.identity.packageId; }],
      ['scope', (d) => { delete d.scope; }],
      ['issuedAt', (d) => { delete d.issuance.issuedAt; }],
      ['authorization mode', (d) => { delete d.authorization.mode; }],
      ['correlationId', (d) => { delete d.trace.correlationId; }],
      ['digest', (d) => { delete d.integrity.digest; }],
      ['consumption', (d) => { delete d.consumption; }],
      ['whole document', () => undefined],
    ])('rejects a document with the %s missing (a missing field is never a pass)', async (name, mutate) => {
      const f = await fixture();
      const id = randomUUID();
      await header(f, id);
      const opts: VersionOpts = name === 'whole document'
        ? { packageId: id, overrideColumns: { package: '{}' } }
        : { packageId: id, overrideDocument: mutate };
      await expect(addVersion(f, opts)).rejects.toThrow(/document_identity|document_expiry|violates check|does not match the package header/);
    });

    it('stores a rule-authorized package without a human decision status, and Level 4 as representable', async () => {
      const f = await fixture('draft');
      const id = randomUUID();
      await header(f, id);
      await addVersion(f, { packageId: id, level: 3 });
      const f2 = await fixture('draft');
      const id2 = randomUUID();
      await header(f2, id2);
      await addVersion(f2, { packageId: id2, level: 4 });
    });

    it('rejects a malformed digest and unknown contract / canonical / algorithm versions', async () => {
      const f = await fixture();
      const id = randomUUID();
      await header(f, id);
      await expect(addVersion(f, { packageId: id, overrideColumns: { digest: 'sha256:ABC' } })).rejects.toThrow(/digest_check/);
      await expect(addVersion(f, { packageId: id, overrideColumns: { contract_version: 'aap/2' } })).rejects.toThrow(/contract_version_check/);
      await expect(addVersion(f, { packageId: id, overrideColumns: { canonical_version: 'x' } })).rejects.toThrow(/canonical_version_check/);
      await expect(addVersion(f, { packageId: id, overrideColumns: { digest_algorithm: 'md5' } })).rejects.toThrow(/digest_algorithm_check/);
    });

    it.each<[string, (doc: Record<string, any>) => void]>([
      ['digest', (d) => { d.integrity.digest = `sha256:${'a'.repeat(64)}`; }],
      ['scope', (d) => { d.scope.businessId = randomUUID(); }],
      ['package version', (d) => { d.identity.packageVersion = 7; }],
      ['package id', (d) => { d.identity.packageId = randomUUID(); }],
      ['issuedAt', (d) => { d.issuance.issuedAt = '2001-01-01T00:00:00.000Z'; }],
      ['issuer component', (d) => { d.issuance.issuerComponent = 'someone.else'; }],
      ['automation level', (d) => { d.action.automationLevel.level = 3; }],
      ['authorization mode', (d) => { d.authorization.mode = 'RULE_AUTHORIZED'; }],
      ['correlation', (d) => { d.trace.correlationId = randomUUID(); }],
      ['consumption mode', (d) => { d.consumption.mode = 'MULTI_USE'; }],
      ['contract version', (d) => { d.contractVersion = 'aap/2'; }],
    ])('rejects a document that disagrees with the %s column', async (_name, mutate) => {
      const f = await fixture();
      const id = randomUUID();
      await header(f, id);
      await expect(addVersion(f, { packageId: id, overrideDocument: mutate })).rejects.toThrow(/document_identity|document_supersedes|decision is not approved/);
    });

    it('rejects a document whose action or decision lineage is not the header', async () => {
      const f = await fixture();
      const id = randomUUID();
      await header(f, id);
      await expect(addVersion(f, { packageId: id, overrideDocument: (d) => { d.action.actionId = randomUUID(); } })).rejects.toThrow(/does not match the package header/);
      await expect(addVersion(f, { packageId: id, overrideDocument: (d) => { d.lineage.decision.decisionId = randomUUID(); } })).rejects.toThrow(/does not match the package header/);
    });

    it('rejects an action version that belongs to a different authorized action', async () => {
      const f = await fixture();
      const other = await fixture();
      const id = randomUUID();
      await header(f, id);
      await expect(addVersion(f, { packageId: id, overrideColumns: { action_version_id: other.actionVersionId }, overrideDocument: (d) => { d.action.actionVersionId = other.actionVersionId; } }))
        .rejects.toThrow(/does not match the package header/);
    });

    it('rejects issued_at with sub-millisecond precision', async () => {
      const f = await fixture();
      const id = randomUUID();
      await header(f, id);
      await expect(addVersion(f, { packageId: id, overrideColumns: { issued_at: '2026-01-01T00:00:00.123456Z' } })).rejects.toThrow(/issued_ms|document_identity/);
    });

    describe('expiry', () => {
      it('treats NOT_APPLICABLE as a NULL expires_at and nothing else', async () => {
        const f = await fixture();
        const id = randomUUID();
        await header(f, id);
        await addVersion(f, { packageId: id, expiresAt: null });
        const f2 = await fixture();
        const id2 = randomUUID();
        await header(f2, id2);
        await expect(addVersion(f2, { packageId: id2, expiresAt: null, overrideColumns: { expires_at: new Date(Date.now() + HOUR) } })).rejects.toThrow(/document_expiry/);
      });

      it('rejects a column that disagrees with a VALUE expiry, and an UNAVAILABLE expiry', async () => {
        const f = await fixture();
        const id = randomUUID();
        await header(f, id);
        await expect(addVersion(f, { packageId: id, overrideColumns: { expires_at: new Date(Date.now() + 2 * HOUR) } })).rejects.toThrow(/document_expiry/);
        await expect(addVersion(f, { packageId: id, overrideDocument: (d) => { d.validity.expiresAt = { state: 'UNAVAILABLE', source: 'x' }; } })).rejects.toThrow(/document_expiry/);
      });

      it('rejects an expiry that is not after issuance', async () => {
        const f = await fixture();
        const id = randomUUID();
        await header(f, id);
        const issued = new Date(Math.floor(Date.now() / 1000) * 1000);
        await expect(addVersion(f, { packageId: id, issuedAt: issued, expiresAt: issued })).rejects.toThrow(/expiry_after_issue/);
      });

      it('never lets a package outlive the decision validity', async () => {
        const f = await fixture();
        const id = randomUUID();
        await header(f, id);
        const issued = new Date(Math.floor(Date.now() / 1000) * 1000);
        await expect(addVersion(f, { packageId: id, issuedAt: issued, expiresAt: new Date(issued.getTime() + 2 * HOUR), decisionValidUntil: new Date(issued.getTime() + HOUR) }))
          .rejects.toThrow(/expiry_within_decision/);
        await expect(addVersion(f, { packageId: id, issuedAt: issued, expiresAt: null, decisionValidUntil: new Date(issued.getTime() + HOUR) }))
          .rejects.toThrow(/expiry_within_decision/);
        await addVersion(f, { packageId: id, issuedAt: issued, expiresAt: new Date(issued.getTime() + HOUR), decisionValidUntil: new Date(issued.getTime() + HOUR) });
      });
    });

    it('rejects a duplicate version number and a duplicate digest', async () => {
      const f = await fixture();
      const id = randomUUID();
      await header(f, id);
      const v1 = await addVersion(f, { packageId: id });
      await expect(addVersion(f, { packageId: id })).rejects.toThrow(/versions_key|duplicate/);
      await expect(addVersion(f, { packageId: id, version: 2, overrideColumns: { digest: v1.digest }, overrideDocument: (d) => { d.integrity.digest = v1.digest; } }))
        .rejects.toThrow(/digest_unique/);
    });
  });

  describe('supersession', () => {
    it('adds version N+1 against N, atomically recording SUPERSEDED on N', async () => {
      const f = await fixture();
      const id = randomUUID();
      await header(f, id);
      await addVersion(f, { packageId: id, version: 1 });
      await addVersion(f, { packageId: id, version: 2 });
      expect((await lifecycle(id, 1)).map((e) => e.state)).toEqual(['ISSUED', 'SUPERSEDED']);
      expect((await lifecycle(id, 1))[1].superseded_by_package_version).toBe(2);
      expect((await lifecycle(id, 2)).map((e) => e.state)).toEqual(['ISSUED']);
    });

    it('forces a linear chain: no version 1 with a predecessor, no gap, no skipping', async () => {
      const f = await fixture();
      const id = randomUUID();
      await header(f, id);
      await expect(addVersion(f, { packageId: id, version: 2 })).rejects.toThrow(/supersedes_fk|foreign key/);
      await addVersion(f, { packageId: id, version: 1 });
      await expect(addVersion(f, { packageId: id, version: 3, supersedes: 1 })).rejects.toThrow(/supersedes_chain/);
      await expect(addVersion(f, { packageId: id, version: 2, supersedes: null })).rejects.toThrow(/supersedes_chain/);
    });

    it('rejects a document whose supersedes link disagrees with the column', async () => {
      const f = await fixture();
      const id = randomUUID();
      await header(f, id);
      await addVersion(f, { packageId: id, version: 1 });
      await expect(addVersion(f, { packageId: id, version: 2, overrideDocument: (d) => { d.identity.supersedes = null; } })).rejects.toThrow(/document_supersedes/);
    });

    it.each(['REVOKED', 'CONSUMED'])('cannot supersede a version that is already %s', async (state) => {
      const f = await fixture();
      const id = randomUUID();
      await header(f, id);
      await addVersion(f, { packageId: id, version: 1 });
      await event(f, id, 1, state, state === 'REVOKED'
        ? { actor_type: 'user', actor_id: 'owner', reason: 'withdrawn' }
        : { consumption_receipt_id: randomUUID() });
      await expect(addVersion(f, { packageId: id, version: 2 })).rejects.toThrow(/already has terminal state/);
    });
  });

  describe('lifecycle', () => {
    async function issued(f: Fixture, over: VersionOpts = { packageId: '' }) {
      const id = randomUUID();
      await header(f, id);
      await addVersion(f, { ...over, packageId: id });
      return id;
    }

    it('stamps facts with the database clock; a writer cannot backdate or postdate them', async () => {
      const f = await fixture();
      const id = await issued(f);
      const before = Date.now() - 2000;
      const e = await event(f, id, 1, 'REVOKED', { actor_type: 'user', actor_id: 'owner', reason: 'wrong target', occurred_at: '2001-01-01T00:00:00Z' });
      expect(new Date(e.occurred_at).getTime()).toBeGreaterThan(before);
    });

    it('requires an actor and a reason to revoke', async () => {
      const f = await fixture();
      const id = await issued(f);
      await expect(event(f, id, 1, 'REVOKED')).rejects.toThrow(/revoked_shape/);
      await expect(event(f, id, 1, 'REVOKED', { actor_type: 'user', actor_id: 'owner', reason: '   ' })).rejects.toThrow(/revoked_shape/);
      await event(f, id, 1, 'REVOKED', { actor_type: 'user', actor_id: 'owner', reason: 'withdrawn' });
    });

    it('allows at most one terminal fact per version, so revoke-after-consume is not a state change', async () => {
      const f = await fixture();
      const id = await issued(f);
      await event(f, id, 1, 'CONSUMED', { consumption_receipt_id: randomUUID() });
      await expect(event(f, id, 1, 'REVOKED', { actor_type: 'user', actor_id: 'owner', reason: 'late' })).rejects.toThrow(/one_terminal/);
      await expect(event(f, id, 1, 'CONSUMED', { consumption_receipt_id: randomUUID() })).rejects.toThrow(/one_terminal/);
    });

    it('has exactly one ISSUED fact, written only by the version insert', async () => {
      const f = await fixture();
      const id = await issued(f);
      await expect(event(f, id, 1, 'ISSUED')).rejects.toThrow(/one_issued/);
    });

    it('requires a consumption receipt reference to consume, and forbids it on any other state', async () => {
      const f = await fixture();
      const id = await issued(f);
      await expect(event(f, id, 1, 'CONSUMED')).rejects.toThrow(/consumed_shape/);
      await expect(event(f, id, 1, 'REVOKED', { actor_type: 'user', actor_id: 'owner', reason: 'x', consumption_receipt_id: randomUUID() })).rejects.toThrow(/consumed_shape/);
    });

    it('records SUPERSEDED only for the immediately following version', async () => {
      const f = await fixture();
      const id = await issued(f);
      await expect(event(f, id, 1, 'SUPERSEDED', { superseded_by_package_version: 2 })).rejects.toThrow(/superseded_by_fk|foreign key/);
      await expect(event(f, id, 1, 'SUPERSEDED')).rejects.toThrow(/superseded_shape/);
      await expect(event(f, id, 1, 'REVOKED', { actor_type: 'user', actor_id: 'o', reason: 'x', superseded_by_package_version: 1 })).rejects.toThrow(/superseded_shape/);
    });

    it('records EXPIRED only after the package expiry on the database clock', async () => {
      const f = await fixture();
      const future = await issued(f);
      await expect(event(f, future, 1, 'EXPIRED')).rejects.toThrow(/before the package expiry/);

      const f2 = await fixture();
      const none = await issued(f2, { packageId: '', expiresAt: null });
      await expect(event(f2, none, 1, 'EXPIRED')).rejects.toThrow(/before the package expiry/);

      const f3 = await fixture();
      const past = new Date(Math.floor(Date.now() / 1000) * 1000 - 2 * HOUR);
      const lapsed = await issued(f3, { packageId: '', issuedAt: past, expiresAt: new Date(past.getTime() + HOUR) });
      const e = await event(f3, lapsed, 1, 'EXPIRED');
      expect(e.state).toBe('EXPIRED');
    });

    it('never consumes a package that has expired', async () => {
      const f = await fixture();
      const past = new Date(Math.floor(Date.now() / 1000) * 1000 - 2 * HOUR);
      const id = await issued(f, { packageId: '', issuedAt: past, expiresAt: new Date(past.getTime() + HOUR) });
      await expect(event(f, id, 1, 'CONSUMED', { consumption_receipt_id: randomUUID() })).rejects.toThrow(/expired package cannot be consumed/);
    });

    it('rejects a fact for a version that does not exist or crosses scope', async () => {
      const f = await fixture();
      const other = await fixture();
      const id = await issued(f);
      await expect(event(f, randomUUID(), 1, 'REVOKED', { actor_type: 'user', actor_id: 'o', reason: 'x' })).rejects.toThrow();
      await expect(event(other, id, 1, 'REVOKED', { actor_type: 'user', actor_id: 'o', reason: 'x' })).rejects.toThrow();
    });

    it('rejects unknown states', async () => {
      const f = await fixture();
      const id = await issued(f);
      await expect(event(f, id, 1, 'EXECUTED')).rejects.toThrow(/state_check/);
      await expect(event(f, id, 1, 'EXECUTABLE')).rejects.toThrow(/state_check/);
    });
  });

  describe('append-only', () => {
    it.each([PKG, VER, LIFE])('rejects UPDATE and DELETE on %s, even for a privileged role', async (table) => {
      const f = await fixture();
      const id = randomUUID();
      await header(f, id);
      await addVersion(f, { packageId: id });
      await expect(admin.query(`UPDATE ${table} SET created_at = now()`)).rejects.toThrow(/append-only/);
      await expect(admin.query(`DELETE FROM ${table}`)).rejects.toThrow(/append-only/);
    });
  });

  describe('row level security', () => {
    async function asTenant<T>(tenantId: string, workspaceId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
      const c = await app.connect();
      try {
        await c.query('BEGIN');
        await c.query("SELECT set_config('app.tenant_id', $1, true), set_config('app.workspace_id', $2, true)", [tenantId, workspaceId]);
        const out = await fn(c);
        await c.query('COMMIT');
        return out;
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      } finally {
        c.release();
      }
    }

    it('confines all three tables to the tenant and workspace', async () => {
      const a = await fixture();
      const b = await fixture();
      const ida = randomUUID();
      await header(a, ida);
      await addVersion(a, { packageId: ida });

      for (const table of [PKG, VER, LIFE]) {
        const own = await asTenant(a.tenantId, a.workspaceId, (c) => c.query(`SELECT 1 FROM ${table} WHERE tenant_id=$1`, [a.tenantId]));
        expect(own.rowCount).toBeGreaterThan(0);
        const foreign = await asTenant(b.tenantId, b.workspaceId, (c) => c.query(`SELECT 1 FROM ${table} WHERE tenant_id=$1`, [a.tenantId]));
        expect(foreign.rowCount).toBe(0);
      }
    });

    it('sees nothing without a tenant context, and cannot write into another tenant', async () => {
      const a = await fixture();
      const b = await fixture();
      const ida = randomUUID();
      await header(a, ida);
      // Fail closed: with no tenant context the predicate cannot be evaluated (error) or matches nothing (zero rows).
      const noContext = await app.query(`SELECT 1 FROM ${PKG}`).then((r) => r.rowCount, (e: Error) => e.message);
      expect(noContext === 0 || /uuid|row-level security/.test(String(noContext))).toBe(true);
      await expect(
        asTenant(b.tenantId, b.workspaceId, (c) =>
          insert(PKG, { tenant_id: a.tenantId, workspace_id: a.workspaceId, business_id: a.businessId, action_id: a.actionId, decision_id: a.decisionId }, c)),
      ).rejects.toThrow(/row-level security|permission|action\/decision\/scope do not match/);
    });
  });
});
