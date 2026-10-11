/**
 * P0-5 Block 3c-2 - live PostgreSQL proof of migration 0178, ActionTypeRegistryRepository and AutomationLevelPolicyRepository.
 *
 * Proves: the ABA-governed action-type registry (definitions validated by the database, immutable, DRAFT -> ACTIVE ->
 * RETIRED) and the automation-level policy store (versioned, enable/disable facts, Level 2 only, one enabled version per
 * level and scope). The registry ships EMPTY and no policy is seeded. No issuer, no BO, no events, no route wiring.
 *
 * Requires:
 *   DATABASE_URL       - least-privilege application role (RLS enforced): the repositories run as this role
 *   ADMIN_DATABASE_URL - privileged role: builds scopes/users and inspects state
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- fixtures deliberately build arbitrary JSON documents */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { closePool, createPool, type TenantContext } from '../src/client.js';
import { ActionTypeRegistryRepository, toActionTypeContract } from '../src/repositories/approved_action/ActionTypeRegistryRepository.js';
import { AutomationLevelPolicyRepository } from '../src/repositories/approved_action/AutomationLevelPolicyRepository.js';
import { ConflictError, NotFoundError, ValidationError } from '../src/repositories/approved_action/errors.js';
import { makeScope, makeUser, type Scope } from './helpers/aapFixtures.js';

const run = Boolean(process.env.DATABASE_URL && process.env.ADMIN_DATABASE_URL);
const S = 'approved_business_action';
const DEFS = `${S}.action_type_definitions`;
const STATUS = `${S}.action_type_status_events`;
const POLICIES = `${S}.automation_level_policies`;
const VERSIONS = `${S}.automation_level_policy_versions`;
const ENABLEMENT = `${S}.automation_level_policy_enablement_events`;
const MS_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

let admin: Pool;
let user: string;
const types = new ActionTypeRegistryRepository();
const policies = new AutomationLevelPolicyRepository();
const ctxOf = (s: Scope): TenantContext => ({ tenantId: s.tenantId, workspaceId: s.workspaceId, userId: user });
const cid = () => randomUUID();

const defInput = (over: Record<string, unknown> = {}): any => ({
  code: 'adjust_price', schemaVersion: '1.0', targetKinds: ['product'],
  parameters: { price: { type: 'decimal_string', required: true }, channel: { type: 'enum', required: false, values: ['email', 'sms'] } },
  governanceImpact: { price: ['COST', 'RISK'] }, applicability: { budget: 'NOT_APPLICABLE_ALLOWED' },
  definedByUserId: user, correlationId: cid(), ...over,
});
const change = (over: Record<string, unknown> = {}): any => ({ actorUserId: user, reason: 'owner decision', correlationId: cid(), ...over });
const policyInput = (over: Record<string, unknown> = {}): any => ({
  policyCode: `p_${randomUUID().slice(0, 8)}`, automationLevel: 2, description: 'Human approval, system execution.',
  createdByUserId: user, correlationId: cid(), ...over,
});

/** A fresh scope per test keeps definitions, policies and enablement independent without touching the shared business table. */
const freshScope = () => makeScope(admin);

describe.runIf(run)('P0-5 Block 3c-2: action-type registry and automation-level policy (migration 0178)', () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
    createPool({ connectionString: process.env.DATABASE_URL as string });
    user = await makeUser(admin);
  });
  afterAll(async () => {
    await admin?.end();
    await closePool();
  });

  it('ships empty: nothing is seeded, so nothing can be authorized yet', async () => {
    const s = await freshScope();
    expect(await types.listActive(ctxOf(s))).toEqual([]);
    expect(await policies.getEnablement(ctxOf(s))).toEqual({ automationLevels: [], effective: [] });
    expect(await policies.getEffectivePolicy(ctxOf(s), 2)).toBeNull();
    for (const table of [DEFS, STATUS, POLICIES, VERSIONS, ENABLEMENT]) {
      expect((await admin.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [s.tenantId])).rows[0].n).toBe(0);
    }
  });

  describe('action types', () => {
    it('defines a DRAFT action type that cannot be used until it is activated', async () => {
      const s = await freshScope();
      const def = await types.define(ctxOf(s), defInput());
      expect(def).toMatchObject({ code: 'adjust_price', schemaVersion: '1.0', targetKinds: ['product'], definedByUserId: user });
      expect(def.createdAt).toMatch(MS_UTC);
      expect((await types.get(ctxOf(s), 'adjust_price', '1.0'))?.status).toBe('DRAFT');
      expect(await types.resolveActive(ctxOf(s), 'adjust_price', '1.0')).toBeNull();
      expect(await types.listActive(ctxOf(s))).toEqual([]);
    });

    it('is idempotent, and refuses a different definition at the same schema version', async () => {
      const s = await freshScope();
      const first = await types.define(ctxOf(s), defInput());
      expect((await types.define(ctxOf(s), defInput({ correlationId: cid() }))).id).toBe(first.id);
      const reordered = defInput({ parameters: { channel: { values: ['email', 'sms'], required: false, type: 'enum' }, price: { required: true, type: 'decimal_string' } } });
      expect((await types.define(ctxOf(s), reordered)).id).toBe(first.id);
      await expect(types.define(ctxOf(s), defInput({ targetKinds: ['product', 'bundle'] }))).rejects.toBeInstanceOf(ConflictError);
      expect((await types.define(ctxOf(s), defInput({ schemaVersion: '1.1', targetKinds: ['product', 'bundle'] }))).schemaVersion).toBe('1.1');
    });

    it('is safe under concurrency: simultaneous identical definitions store one row', async () => {
      for (let round = 0; round < 4; round += 1) {
        const s = await freshScope();
        const input = defInput();
        const rows = await Promise.all(Array.from({ length: 8 }, () => types.define(ctxOf(s), input)));
        expect(new Set(rows.map((r) => r.id)).size).toBe(1);
      }
    });

    it('moves DRAFT -> ACTIVE -> RETIRED, resolving only ACTIVE types', async () => {
      const s = await freshScope();
      const def = await types.define(ctxOf(s), defInput());
      const active = await types.activate(ctxOf(s), def.id, { actorUserId: user, correlationId: cid() });
      expect(active.status).toBe('ACTIVE');
      expect((await types.resolveActive(ctxOf(s), 'adjust_price', '1.0'))?.id).toBe(def.id);
      expect((await types.listActive(ctxOf(s))).map((d) => d.id)).toEqual([def.id]);
      expect((await types.activate(ctxOf(s), def.id, { actorUserId: user, correlationId: cid() })).status).toBe('ACTIVE');
      expect((await admin.query(`SELECT count(*)::int AS n FROM ${STATUS} WHERE definition_id = $1`, [def.id])).rows[0].n).toBe(1);

      expect((await types.retire(ctxOf(s), def.id, change())).status).toBe('RETIRED');
      expect(await types.resolveActive(ctxOf(s), 'adjust_price', '1.0')).toBeNull();
      expect(await types.listActive(ctxOf(s))).toEqual([]);
      expect((await types.retire(ctxOf(s), def.id, change())).status).toBe('RETIRED');
      await expect(types.activate(ctxOf(s), def.id, { actorUserId: user, correlationId: cid() })).rejects.toBeInstanceOf(ConflictError);
    });

    it('refuses to retire a DRAFT, requires a reason to retire, and reports unknown ids', async () => {
      const s = await freshScope();
      const def = await types.define(ctxOf(s), defInput());
      await expect(types.retire(ctxOf(s), def.id, change())).rejects.toBeInstanceOf(ConflictError);
      await types.activate(ctxOf(s), def.id, { actorUserId: user, correlationId: cid() });
      await expect(types.retire(ctxOf(s), def.id, change({ reason: undefined }))).rejects.toBeInstanceOf(ValidationError);
      await expect(types.retire(ctxOf(s), def.id, change({ reason: '   ' }))).rejects.toBeInstanceOf(ValidationError);
      await expect(types.activate(ctxOf(s), randomUUID(), { actorUserId: user, correlationId: cid() })).rejects.toBeInstanceOf(NotFoundError);
      await expect(types.activate(ctxOf(s), 'nope', { actorUserId: user, correlationId: cid() })).rejects.toBeInstanceOf(ValidationError);
    });

    it('is safe under concurrency: simultaneous activations record one fact', async () => {
      const s = await freshScope();
      const def = await types.define(ctxOf(s), defInput());
      await Promise.all(Array.from({ length: 8 }, () => types.activate(ctxOf(s), def.id, { actorUserId: user, correlationId: cid() })));
      expect((await admin.query(`SELECT count(*)::int AS n FROM ${STATUS} WHERE definition_id = $1`, [def.id])).rows[0].n).toBe(1);
    });

    it('exposes a definition as the contract ActionTypeContract shape', async () => {
      const s = await freshScope();
      const def = await types.define(ctxOf(s), defInput());
      expect(toActionTypeContract(def)).toEqual({
        code: 'adjust_price', schemaVersion: '1.0', targetKinds: ['product'],
        parameters: defInput().parameters, governanceImpact: { price: ['COST', 'RISK'] }, applicability: { budget: 'NOT_APPLICABLE_ALLOWED' },
      });
    });

    it.each<[string, Record<string, unknown>, RegExp]>([
      ['an upper-case code', { code: 'Adjust' }, /code must match/],
      ['a non-numeric schema version', { schemaVersion: 'v1' }, /schemaVersion must be dotted numeric/],
      ['no target kinds', { targetKinds: [] }, /at least one target kind/],
      ['no parameters', { parameters: {} }, /at least one parameter/],
      ['an unknown parameter type', { parameters: { p: { type: 'blob', required: true } } }, /unknown type/],
      ['an enum without values', { parameters: { p: { type: 'enum', required: true, values: [] } } }, /needs unique values/],
      ['an empty numeric range', { parameters: { p: { type: 'integer', required: true, min: 5, max: 1 } } }, /range for p is empty/],
      ['impact on an undeclared parameter', { governanceImpact: { nope: ['COST'] } }, /undeclared parameter nope/],
      ['impact with an unknown dimension', { governanceImpact: { price: ['VIBES'] } }, /unknown governance dimension/],
      ['applicability for an unknown field', { applicability: { nope: 'REQUIRED' } }, /unknown field nope/],
      ['an invalid applicability rule', { applicability: { budget: 'MAYBE' } }, /rule for budget is invalid/],
    ])('rejects a definition with %s, naming the problem', async (_name, over, message) => {
      const s = await freshScope();
      await expect(types.define(ctxOf(s), defInput(over))).rejects.toThrow(message);
      await expect(types.define(ctxOf(s), defInput(over))).rejects.toBeInstanceOf(ValidationError);
      expect(await types.get(ctxOf(s), over.code as string ?? 'adjust_price', (over.schemaVersion as string) ?? '1.0')).toBeNull();
    });

    it('rejects malformed input before the database, and an unknown definer', async () => {
      const s = await freshScope();
      await expect(types.define(ctxOf(s), defInput({ definedByUserId: 'x' }))).rejects.toBeInstanceOf(ValidationError);
      await expect(types.define(ctxOf(s), defInput({ parameters: [] }))).rejects.toBeInstanceOf(ValidationError);
      await expect(types.define(ctxOf(s), defInput({ targetKinds: 'product' }))).rejects.toBeInstanceOf(ValidationError);
      await expect(types.define(ctxOf(s), defInput({ definedByUserId: randomUUID() }))).rejects.toThrow();
    });

    it('holds the database validator to the shared golden cases (and never accepts what the contract rejects)', async () => {
      const file = resolve(__dirname, '../../handoff-contracts/tests/fixtures/action-type-golden-cases.json');
      const { cases } = JSON.parse(readFileSync(file, 'utf8')) as { cases: { name: string; definition: any; contractValid: boolean; dbValid: boolean }[] };
      expect(cases.length).toBeGreaterThanOrEqual(25);
      for (const c of cases) {
        const d = c.definition;
        const problems = (await admin.query<{ p: string[] }>(
          `SELECT ${S}.aap_action_type_problems($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb) AS p`,
          [d.code, d.schemaVersion, JSON.stringify(d.targetKinds), JSON.stringify(d.parameters), JSON.stringify(d.governanceImpact), JSON.stringify(d.applicability)],
        )).rows[0].p;
        expect({ name: c.name, valid: problems.length === 0 }).toEqual({ name: c.name, valid: c.dbValid });
        if (c.dbValid) expect(c.contractValid).toBe(true);
      }
      // and the repository accepts exactly the database-valid ones
      for (const c of cases.filter((x) => x.dbValid).slice(0, 6)) {
        const s = await freshScope();
        const d = c.definition;
        const stored = await types.define(ctxOf(s), { ...d, definedByUserId: user, correlationId: cid() });
        expect(stored.code).toBe(d.code);
      }
    });

    it('enforces the validator even for a direct write that bypasses the repository', async () => {
      const s = await freshScope();
      const insert = (parameters: unknown) => admin.query(
        `INSERT INTO ${DEFS} (tenant_id, workspace_id, code, schema_version, target_kinds, parameters, defined_by_user_id, correlation_id)
         VALUES ($1,$2,'direct','1','["t"]'::jsonb,$3::jsonb,$4,$5)`,
        [s.tenantId, s.workspaceId, JSON.stringify(parameters), user, cid()]);
      await expect(insert({ p: { type: 'blob', required: true } })).rejects.toThrow(/invalid definition/);
      await expect(insert({})).rejects.toThrow(/invalid definition/);
      await insert({ p: { type: 'boolean', required: true } });
    });

    it('guards status transitions directly: no re-activation, no retirement of a DRAFT, a reason to retire', async () => {
      const s = await freshScope();
      const def = await types.define(ctxOf(s), defInput());
      const event = (state: string, reason: string | null = null) => admin.query(
        `INSERT INTO ${STATUS} (tenant_id, workspace_id, definition_id, state, actor_user_id, reason, correlation_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [s.tenantId, s.workspaceId, def.id, state, user, reason, cid()]);
      await expect(event('RETIRED', 'x')).rejects.toThrow(/only an ACTIVE action type can be retired/);
      await event('ACTIVE');
      await expect(event('ACTIVE')).rejects.toThrow(/activated once|one_active/);
      await expect(event('RETIRED')).rejects.toThrow(/retired_reason/);
      await event('RETIRED', 'superseded by 2.0');
      await expect(event('RETIRED', 'again')).rejects.toThrow(/one_retired/);
    });

    it('stamps facts with the database clock and rejects UPDATE and DELETE for every role', async () => {
      const s = await freshScope();
      const def = await types.define(ctxOf(s), defInput());
      const ev = (await admin.query(
        `INSERT INTO ${STATUS} (tenant_id, workspace_id, definition_id, state, actor_user_id, correlation_id, occurred_at)
         VALUES ($1,$2,$3,'ACTIVE',$4,$5,'2001-01-01T00:00:00Z') RETURNING occurred_at`, [s.tenantId, s.workspaceId, def.id, user, cid()])).rows[0];
      expect(Math.abs(new Date(ev.occurred_at).getTime() - Date.now())).toBeLessThan(5000);
      for (const table of [DEFS, STATUS]) {
        await expect(admin.query(`UPDATE ${table} SET created_at = now() WHERE tenant_id = $1`, [s.tenantId])).rejects.toThrow(/append-only/);
        await expect(admin.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [s.tenantId])).rejects.toThrow(/append-only/);
      }
    });

    it('is invisible to other tenants and cannot be written into another tenant', async () => {
      const a = await freshScope();
      const b = await freshScope();
      const def = await types.define(ctxOf(a), defInput());
      await types.activate(ctxOf(a), def.id, { actorUserId: user, correlationId: cid() });
      expect(await types.get(ctxOf(b), 'adjust_price', '1.0')).toBeNull();
      expect(await types.getById(ctxOf(b), def.id)).toBeNull();
      expect(await types.listActive(ctxOf(b))).toEqual([]);
      await expect(types.activate(ctxOf(b), def.id, { actorUserId: user, correlationId: cid() })).rejects.toBeInstanceOf(NotFoundError);
      // the same code and version can exist independently in another scope
      expect((await types.define(ctxOf(b), defInput())).id).not.toBe(def.id);
    });
  });

  describe('automation-level policy', () => {
    it('creates a policy with version 1, NOT enabled, and is idempotent', async () => {
      const s = await freshScope();
      const input = policyInput();
      const { policy, version } = await policies.createPolicy(ctxOf(s), input);
      expect(policy).toMatchObject({ policyCode: input.policyCode, automationLevel: 2 });
      expect(version).toMatchObject({ policyId: policy.id, automationLevel: 2, versionNumber: 1, supersedesVersion: null });
      expect(version.createdAt).toMatch(MS_UTC);
      expect(await policies.getEnablement(ctxOf(s))).toEqual({ automationLevels: [], effective: [] });
      const again = await policies.createPolicy(ctxOf(s), { ...input, correlationId: cid() });
      expect(again.policy.id).toBe(policy.id);
      expect(again.version.id).toBe(version.id);
      await expect(policies.createPolicy(ctxOf(s), { ...input, description: 'Different.' })).rejects.toBeInstanceOf(ConflictError);
      await expect(policies.createPolicy(ctxOf(s), { ...input, automationLevel: 3 })).rejects.toBeInstanceOf(ConflictError);
      expect((await policies.getPolicyByCode(ctxOf(s), input.policyCode))?.id).toBe(policy.id);
      expect((await policies.getVersion(ctxOf(s), version.id))?.id).toBe(version.id);
    });

    it('rejects Levels 0 and 1, malformed codes and unknown creators', async () => {
      const s = await freshScope();
      for (const level of [0, 1, 5, '2']) await expect(policies.createPolicy(ctxOf(s), policyInput({ automationLevel: level }))).rejects.toBeInstanceOf(ValidationError);
      await expect(policies.createPolicy(ctxOf(s), policyInput({ policyCode: 'Bad-Code' }))).rejects.toThrow();
      await expect(policies.createPolicy(ctxOf(s), policyInput({ description: ' ' }))).rejects.toBeInstanceOf(ValidationError);
      await expect(policies.createPolicy(ctxOf(s), policyInput({ createdByUserId: randomUUID() }))).rejects.toThrow();
    });

    it('enables Level 2 and exposes the enablement and the governed policy reference; disabling reverses it', async () => {
      const s = await freshScope();
      const { policy, version } = await policies.createPolicy(ctxOf(s), policyInput());
      const effective = await policies.enable(ctxOf(s), version.id, change());
      expect(effective).toMatchObject({ automationLevel: 2, policyId: policy.id, policyVersionId: version.id, versionNumber: 1 });
      expect(await policies.getEnablement(ctxOf(s))).toEqual({ automationLevels: [2], effective: [effective] });
      expect(await policies.getEffectivePolicy(ctxOf(s), 2)).toEqual(effective);
      expect(await policies.getEffectivePolicy(ctxOf(s), 3)).toBeNull();
      await policies.enable(ctxOf(s), version.id, change()); // idempotent
      expect((await admin.query(`SELECT count(*)::int AS n FROM ${ENABLEMENT} WHERE policy_version_id = $1`, [version.id])).rows[0].n).toBe(1);

      await policies.disable(ctxOf(s), version.id, change());
      await policies.disable(ctxOf(s), version.id, change()); // idempotent
      expect(await policies.getEnablement(ctxOf(s))).toEqual({ automationLevels: [], effective: [] });
      await policies.enable(ctxOf(s), version.id, change({ reason: 're-enabled after review' }));
      expect((await policies.getEnablement(ctxOf(s))).automationLevels).toEqual([2]);
    });

    it('can define Levels 3 and 4 but refuses to enable them', async () => {
      const s = await freshScope();
      for (const level of [3, 4] as const) {
        const { version } = await policies.createPolicy(ctxOf(s), policyInput({ automationLevel: level }));
        await expect(policies.enable(ctxOf(s), version.id, change())).rejects.toThrow(/only Level 2 can be enabled/);
        await expect(policies.enable(ctxOf(s), version.id, change())).rejects.toBeInstanceOf(ValidationError);
      }
      expect(await policies.getEnablement(ctxOf(s))).toEqual({ automationLevels: [], effective: [] });
    });

    it('requires an actor and a reason to change enablement, and reports unknown versions', async () => {
      const s = await freshScope();
      const { version } = await policies.createPolicy(ctxOf(s), policyInput());
      await expect(policies.enable(ctxOf(s), version.id, change({ reason: '  ' }))).rejects.toBeInstanceOf(ValidationError);
      await expect(policies.enable(ctxOf(s), version.id, change({ actorUserId: 'x' }))).rejects.toBeInstanceOf(ValidationError);
      await expect(policies.enable(ctxOf(s), version.id, change({ actorUserId: randomUUID() }))).rejects.toThrow();
      await expect(policies.enable(ctxOf(s), randomUUID(), change())).rejects.toBeInstanceOf(NotFoundError);
      expect(await policies.getEnablement(ctxOf(s))).toEqual({ automationLevels: [], effective: [] });
    });

    it('versions a policy linearly; only the latest version can be enabled, and one version per level at a time', async () => {
      const s = await freshScope();
      const { policy, version: v1 } = await policies.createPolicy(ctxOf(s), policyInput());
      const input = { description: 'Tightened scope.', specification: { note: 'v2' }, createdByUserId: user, correlationId: cid() };
      const v2 = await policies.addVersion(ctxOf(s), policy.id, input);
      expect(v2).toMatchObject({ versionNumber: 2, supersedesVersion: 1, specification: { note: 'v2' } });
      expect((await policies.addVersion(ctxOf(s), policy.id, { ...input, correlationId: cid() })).id).toBe(v2.id); // idempotent
      expect((await policies.listVersions(ctxOf(s), policy.id)).map((v) => v.versionNumber)).toEqual([1, 2]);

      await expect(policies.enable(ctxOf(s), v1.id, change())).rejects.toThrow(/only the latest version of a policy can be enabled/);
      await policies.enable(ctxOf(s), v2.id, change());
      const v3 = await policies.addVersion(ctxOf(s), policy.id, { ...input, description: 'Third.' });
      await expect(policies.enable(ctxOf(s), v3.id, change())).rejects.toThrow(/another policy version is already enabled for Level 2/);
      await policies.disable(ctxOf(s), v2.id, change());
      await policies.enable(ctxOf(s), v3.id, change());
      expect((await policies.getEffectivePolicy(ctxOf(s), 2))?.versionNumber).toBe(3);
      await expect(policies.addVersion(ctxOf(s), randomUUID(), input)).rejects.toBeInstanceOf(NotFoundError);
    });

    it('allows one enabled version per level and scope across different policies, and independent scopes', async () => {
      const a = await freshScope();
      const b = await freshScope();
      const p1 = await policies.createPolicy(ctxOf(a), policyInput());
      const p2 = await policies.createPolicy(ctxOf(a), policyInput());
      await policies.enable(ctxOf(a), p1.version.id, change());
      await expect(policies.enable(ctxOf(a), p2.version.id, change())).rejects.toThrow(/already enabled for Level 2/);
      const other = await policies.createPolicy(ctxOf(b), policyInput());
      await policies.enable(ctxOf(b), other.version.id, change());
      expect((await policies.getEffectivePolicy(ctxOf(a), 2))?.policyId).toBe(p1.policy.id);
      expect((await policies.getEffectivePolicy(ctxOf(b), 2))?.policyId).toBe(other.policy.id);
    });

    it('is safe under concurrency: simultaneous enables of one version record one fact; competing policies yield one winner', async () => {
      const a = await freshScope();
      const { version } = await policies.createPolicy(ctxOf(a), policyInput());
      await Promise.all(Array.from({ length: 8 }, () => policies.enable(ctxOf(a), version.id, change())));
      expect((await admin.query(`SELECT count(*)::int AS n FROM ${ENABLEMENT} WHERE policy_version_id = $1`, [version.id])).rows[0].n).toBe(1);

      for (let round = 0; round < 4; round += 1) {
        const s = await freshScope();
        const versions = await Promise.all(Array.from({ length: 5 }, () => policies.createPolicy(ctxOf(s), policyInput())));
        const results = await Promise.allSettled(versions.map((v) => policies.enable(ctxOf(s), v.version.id, change())));
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        expect((await policies.getEnablement(ctxOf(s))).effective).toHaveLength(1);
      }
    });

    it('guards enablement directly, even for a write that bypasses the repository', async () => {
      const s = await freshScope();
      const l3 = await policies.createPolicy(ctxOf(s), policyInput({ automationLevel: 3 }));
      const l2 = await policies.createPolicy(ctxOf(s), policyInput());
      const raw = (versionId: string, state: string, reason: string | null = 'because') => admin.query(
        `INSERT INTO ${ENABLEMENT} (tenant_id, workspace_id, policy_version_id, state, actor_user_id, reason, correlation_id, occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'2001-01-01T00:00:00Z')`, [s.tenantId, s.workspaceId, versionId, state, user, reason, cid()]);
      await expect(raw(l3.version.id, 'ENABLED')).rejects.toThrow(/only Level 2 can be enabled/);
      await expect(raw(l2.version.id, 'DISABLED')).rejects.toThrow(/only an enabled policy version can be disabled/);
      await expect(raw(l2.version.id, 'ENABLED', null)).rejects.toThrow(/reason/);
      await expect(raw(l2.version.id, 'ENABLED', '  ')).rejects.toThrow(/reason/);
      await raw(l2.version.id, 'ENABLED');
      await expect(raw(l2.version.id, 'ENABLED')).rejects.toThrow(/already enabled/);
      const stamped = (await admin.query(`SELECT occurred_at FROM ${ENABLEMENT} WHERE policy_version_id = $1`, [l2.version.id])).rows[0];
      expect(Math.abs(new Date(stamped.occurred_at).getTime() - Date.now())).toBeLessThan(5000);
    });

    it('keeps the policy version chain linear and tied to the policy level, even for direct writes', async () => {
      const s = await freshScope();
      const { policy } = await policies.createPolicy(ctxOf(s), policyInput());
      const raw = (over: Record<string, unknown>) => {
        const cols: Record<string, unknown> = {
          tenant_id: s.tenantId, workspace_id: s.workspaceId, policy_id: policy.id, automation_level: 2, version_number: 2,
          supersedes_version: 1, description: 'd', specification: '{}', created_by_user_id: user, correlation_id: cid(), ...over,
        };
        const keys = Object.keys(cols);
        return admin.query(`INSERT INTO ${VERSIONS} (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`, keys.map((k) => cols[k]));
      };
      await expect(raw({ version_number: 3, supersedes_version: 1 })).rejects.toThrow(/chain/);
      await expect(raw({ version_number: 2, supersedes_version: null })).rejects.toThrow(/chain/);
      await expect(raw({ automation_level: 3 })).rejects.toThrow(/level_fk|foreign key/);
      await expect(raw({ specification: '[]' })).rejects.toThrow(/spec_object/);
      await expect(raw({ version_number: 1, supersedes_version: null })).rejects.toThrow(/versions_key|duplicate/);
      await raw({});
    });

    it('rejects UPDATE and DELETE for every role and isolates tenants', async () => {
      const a = await freshScope();
      const b = await freshScope();
      const { policy, version } = await policies.createPolicy(ctxOf(a), policyInput());
      await policies.enable(ctxOf(a), version.id, change());
      for (const table of [POLICIES, VERSIONS, ENABLEMENT]) {
        await expect(admin.query(`UPDATE ${table} SET created_at = now() WHERE tenant_id = $1`, [a.tenantId])).rejects.toThrow(/append-only/);
        await expect(admin.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [a.tenantId])).rejects.toThrow(/append-only/);
      }
      expect(await policies.getVersion(ctxOf(b), version.id)).toBeNull();
      expect(await policies.getPolicyByCode(ctxOf(b), policy.policyCode)).toBeNull();
      expect(await policies.listVersions(ctxOf(b), policy.id)).toEqual([]);
      expect(await policies.getEnablement(ctxOf(b))).toEqual({ automationLevels: [], effective: [] });
      await expect(policies.enable(ctxOf(b), version.id, change())).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});
