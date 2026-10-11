/**
 * P0-5 Block 3c-3 - live PostgreSQL proof of migration 0179 and AuthorizedActionBoundaryRepository.
 *
 * Proves: the execution boundaries (window, preconditions, budget, rollback, monitoring) and the simulation reference of an
 * authorized action are stored in the aap/1 Governed shapes, tied to the action's immutable capture and an ACTIVE action
 * type, with NOT_APPLICABLE permitted only where the action type's applicability says so. No issuer, no BO, no events,
 * no route wiring, no data.
 *
 * Requires:
 *   DATABASE_URL       - least-privilege application role (RLS enforced): the repositories run as this role
 *   ADMIN_DATABASE_URL - privileged role: builds fixtures and inspects state
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- fixtures deliberately build arbitrary JSON documents */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { closePool, createPool, type TenantContext } from '../src/client.js';
import { ActionTypeRegistryRepository } from '../src/repositories/approved_action/ActionTypeRegistryRepository.js';
import { AuthorizedActionBoundaryRepository, toPackageBoundaryParts } from '../src/repositories/approved_action/AuthorizedActionBoundaryRepository.js';
import { AuthorizedActionCaptureRepository } from '../src/repositories/approved_action/AuthorizedActionCaptureRepository.js';
import { ValidationError } from '../src/repositories/approved_action/errors.js';
import { HOUR, iso, makeCaptureFixture, makeWorld, plainCaptureInput, type CaptureFixture, type World } from './helpers/aapFixtures.js';

const run = Boolean(process.env.DATABASE_URL && process.env.ADMIN_DATABASE_URL);
const S = 'approved_business_action';
const BOUNDARIES = `${S}.authorized_action_boundaries`;
const MS_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ALL_ALLOWED = { executionWindow: 'NOT_APPLICABLE_ALLOWED', preconditions: 'NOT_APPLICABLE_ALLOWED', budget: 'NOT_APPLICABLE_ALLOWED', rollback: 'NOT_APPLICABLE_ALLOWED', monitoring: 'NOT_APPLICABLE_ALLOWED' };
const FIVE = ['executionWindow', 'preconditions', 'budget', 'rollback', 'monitoring'] as const;

let admin: Pool;
let worldA: World;
let worldB: World;
const types = new ActionTypeRegistryRepository();
const captures = new AuthorizedActionCaptureRepository();
const boundaries = new AuthorizedActionBoundaryRepository();
const ctxOf = (f: CaptureFixture): TenantContext => ({ tenantId: f.tenantId, workspaceId: f.workspaceId, userId: f.userId });
const cid = () => randomUUID();
const G = <V>(value: V) => ({ state: 'VALUE' as const, value });
const NA = (code = 'NOT_NEEDED', statement = 'not applicable here') => ({ state: 'NOT_APPLICABLE' as const, reason: { code, statement } });

interface Ready { f: CaptureFixture; ctx: TenantContext; captureId: string; code: string; definitionId: string }

/** A fixture whose action has its capture and an ACTIVE (by default) action type with the given applicability. */
async function ready(opts: { applicability?: Record<string, string>; activate?: boolean; retire?: boolean; world?: World } = {}): Promise<Ready> {
  const f = await makeCaptureFixture(admin, 'approved', opts.world ?? worldA);
  const ctx = ctxOf(f);
  const code = `t_${randomUUID().replace(/-/g, '').slice(0, 14)}`;
  const def = await types.define(ctx, {
    code, schemaVersion: '1', targetKinds: ['product'], parameters: { price: { type: 'number', required: true } },
    governanceImpact: {}, applicability: opts.applicability ?? {}, definedByUserId: f.userId, correlationId: cid(),
  });
  if (opts.activate !== false) await types.activate(ctx, def.id, { actorUserId: f.userId, correlationId: cid() });
  if (opts.retire) await types.retire(ctx, def.id, { actorUserId: f.userId, reason: 'superseded', correlationId: cid() });
  const capture = await captures.recordCapture(ctx, { ...plainCaptureInput(f), actionType: { code, schemaVersion: '1' } });
  return { f, ctx, captureId: capture.id, code, definitionId: def.id };
}

const input = (r: Ready, over: Record<string, unknown> = {}): any => ({
  businessId: r.f.businessId, actionId: r.f.actionId, captureId: r.captureId,
  executionWindow: G({ startsAt: iso(new Date(Date.now() + HOUR)), endsAt: iso(new Date(Date.now() + 8 * HOUR)) }),
  preconditions: G([{ code: 'stock_available', operator: 'gte', operand: 1 }]),
  budget: G({ amount: '250.00', currency: 'USD' }),
  rollback: G({ instructions: 'Restore the previous price from the price history.' }),
  monitoring: G({ metrics: [{ metricCode: 'units_sold', target: 100, unit: 'units' }] }),
  simulationRun: G(randomUUID()),
  authoredByUserId: r.f.userId, correlationId: cid(), ...over,
});

describe.runIf(run)('P0-5 Block 3c-3: execution boundaries (migration 0179)', () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
    createPool({ connectionString: process.env.DATABASE_URL as string });
    worldA = await makeWorld(admin);
    worldB = await makeWorld(admin);
  });
  afterAll(async () => {
    await admin?.end();
    await closePool();
  });

  describe('storage', () => {
    it('stores the governed boundaries and exposes them where the contract places them', async () => {
      const r = await ready();
      const i = input(r);
      const stored = await boundaries.recordBoundaries(r.ctx, i);
      expect(stored).toMatchObject({ actionId: r.f.actionId, captureId: r.captureId, boundaryVersion: 1, supersedesBoundaryVersion: null, authoredByUserId: r.f.userId });
      expect(stored.authoredAt).toMatch(MS_UTC);
      expect(Math.abs(Date.parse(stored.authoredAt) - Date.now())).toBeLessThan(5000);
      for (const field of [...FIVE, 'simulationRun'] as const) expect(stored[field]).toEqual(i[field]);
      expect(await boundaries.getCurrent(r.ctx, r.f.actionId)).toEqual(stored);
      expect(await boundaries.getVersion(r.ctx, r.f.actionId, 1)).toEqual(stored);
      expect(await boundaries.getVersion(r.ctx, r.f.actionId, 2)).toBeNull();
      expect(toPackageBoundaryParts(stored)).toEqual({
        action: { executionWindow: i.executionWindow, preconditions: i.preconditions, budget: i.budget, rollback: i.rollback, monitoring: i.monitoring },
        lineage: { simulationRunId: i.simulationRun },
      });
    });

    it('stamps the time with the database clock', async () => {
      const r = await ready();
      const stored = await boundaries.recordBoundaries(r.ctx, input(r));
      const row = (await admin.query(`SELECT authored_at FROM ${BOUNDARIES} WHERE id = $1`, [stored.id])).rows[0];
      expect(new Date(row.authored_at).toISOString()).toBe(stored.authoredAt);
    });

    it('is idempotent for identical boundaries (new correlation, reordered keys) and versions a real change linearly', async () => {
      const r = await ready();
      const i = input(r);
      const v1 = await boundaries.recordBoundaries(r.ctx, i);
      expect((await boundaries.recordBoundaries(r.ctx, { ...i, correlationId: cid() })).id).toBe(v1.id);
      const reordered = { ...i, budget: G({ currency: 'USD', amount: '250.00' }) };
      expect((await boundaries.recordBoundaries(r.ctx, reordered)).id).toBe(v1.id);
      const v2 = await boundaries.recordBoundaries(r.ctx, { ...i, budget: G({ amount: '300.00', currency: 'USD' }) });
      expect(v2).toMatchObject({ boundaryVersion: 2, supersedesBoundaryVersion: 1 });
      const v3 = await boundaries.recordBoundaries(r.ctx, { ...i, budget: G({ amount: '300.00', currency: 'USD' }), rollback: G({ instructions: 'Different plan.' }) });
      expect(v3).toMatchObject({ boundaryVersion: 3, supersedesBoundaryVersion: 2 });
      expect((await boundaries.listVersions(r.ctx, r.f.actionId)).map((v) => v.boundaryVersion)).toEqual([1, 2, 3]);
      expect((await boundaries.getCurrent(r.ctx, r.f.actionId))?.id).toBe(v3.id);
      // re-stating an older version is a change from the current one: it becomes a new version, never a rewrite
      expect((await boundaries.recordBoundaries(r.ctx, i)).boundaryVersion).toBe(4);
    });

    it('is safe under concurrency: identical writes store one version, different ones stay linear', async () => {
      for (let round = 0; round < 4; round += 1) {
        const r = await ready();
        const i = input(r);
        const rows = await Promise.all(Array.from({ length: 8 }, () => boundaries.recordBoundaries(r.ctx, i)));
        expect(new Set(rows.map((x) => x.id)).size).toBe(1);
      }
      const r = await ready();
      await Promise.all(Array.from({ length: 5 }, (_v, n) => boundaries.recordBoundaries(r.ctx, input(r, { budget: G({ amount: `${n + 1}`, currency: 'USD' }) }))));
      const versions = await boundaries.listVersions(r.ctx, r.f.actionId);
      expect(versions.map((v) => v.boundaryVersion)).toEqual([1, 2, 3, 4, 5]);
      expect(versions.map((v) => v.supersedesBoundaryVersion)).toEqual([null, 1, 2, 3, 4]);
    });
  });

  describe('capture and action type', () => {
    it("requires the action's own capture", async () => {
      const r = await ready();
      const noCapture = await makeCaptureFixture(admin, 'approved', worldA);
      await expect(boundaries.recordBoundaries(ctxOf(noCapture), input({ ...r, f: noCapture, captureId: randomUUID() } as Ready))).rejects.toThrow(/no capture/);
      // another action's capture
      const other = await ready();
      await expect(boundaries.recordBoundaries(r.ctx, input(r, { captureId: other.captureId }))).rejects.toThrow(/no capture, or the capture is not/);
      await expect(boundaries.recordBoundaries(r.ctx, input(r, { captureId: randomUUID() }))).rejects.toThrow();
    });

    it('requires an ACTIVE action type: a draft, a retired or an absent definition cannot be authorized', async () => {
      const draft = await ready({ activate: false });
      await expect(boundaries.recordBoundaries(draft.ctx, input(draft))).rejects.toThrow(/no ACTIVE action type definition/);
      const retired = await ready({ retire: true });
      await expect(boundaries.recordBoundaries(retired.ctx, input(retired))).rejects.toThrow(/no ACTIVE action type definition/);
      const f = await makeCaptureFixture(admin, 'approved', worldA);
      const ctx = ctxOf(f);
      const capture = await captures.recordCapture(ctx, { ...plainCaptureInput(f), actionType: { code: 'never_defined', schemaVersion: '1' } });
      await expect(boundaries.recordBoundaries(ctx, input({ f, ctx, captureId: capture.id } as Ready))).rejects.toThrow(/no ACTIVE action type definition/);
      expect(await boundaries.getCurrent(draft.ctx, draft.f.actionId)).toBeNull();
    });

    it('lets a retired action type stop NEW boundaries without touching existing ones', async () => {
      const r = await ready();
      const v1 = await boundaries.recordBoundaries(r.ctx, input(r));
      await types.retire(r.ctx, r.definitionId, { actorUserId: r.f.userId, reason: 'replaced by 2.0', correlationId: cid() });
      await expect(boundaries.recordBoundaries(r.ctx, input(r, { budget: G({ amount: '1', currency: 'USD' }) }))).rejects.toThrow(/no ACTIVE action type definition/);
      expect(await boundaries.getCurrent(r.ctx, r.f.actionId)).toEqual(v1);
    });
  });

  describe('applicability (NOT_APPLICABLE only where the action type allows it)', () => {
    it.each(FIVE)('rejects a NOT_APPLICABLE %s when the action type does not list it (fail closed)', async (field) => {
      const r = await ready({ applicability: {} });
      await expect(boundaries.recordBoundaries(r.ctx, input(r, { [field]: NA() }))).rejects.toThrow(`requires ${field}; NOT_APPLICABLE is not permitted`);
      await expect(boundaries.recordBoundaries(r.ctx, input(r, { [field]: NA() }))).rejects.toBeInstanceOf(ValidationError);
    });

    it.each(FIVE)('rejects a NOT_APPLICABLE %s when the action type explicitly says REQUIRED', async (field) => {
      const r = await ready({ applicability: { [field]: 'REQUIRED' } });
      await expect(boundaries.recordBoundaries(r.ctx, input(r, { [field]: NA() }))).rejects.toThrow(/NOT_APPLICABLE is not permitted/);
    });

    it('accepts NOT_APPLICABLE for exactly the fields the action type allows, preserving the reasons', async () => {
      const r = await ready({ applicability: { budget: 'NOT_APPLICABLE_ALLOWED', monitoring: 'NOT_APPLICABLE_ALLOWED' } });
      const stored = await boundaries.recordBoundaries(r.ctx, input(r, { budget: NA('NO_SPEND', 'a price change spends nothing'), monitoring: NA('NOT_MONITORABLE') }));
      expect(stored.budget).toEqual(NA('NO_SPEND', 'a price change spends nothing'));
      expect(stored.monitoring).toEqual(NA('NOT_MONITORABLE'));
      await expect(boundaries.recordBoundaries(r.ctx, input(r, { rollback: NA() }))).rejects.toThrow(/requires rollback/);
    });

    it('accepts every field as NOT_APPLICABLE when all are allowed, and the simulation reference is never gated', async () => {
      const r = await ready({ applicability: ALL_ALLOWED });
      const stored = await boundaries.recordBoundaries(r.ctx, input(r, {
        executionWindow: NA(), preconditions: NA(), budget: NA(), rollback: NA(), monitoring: NA(), simulationRun: NA('NOT_SIMULATION_BACKED', 'no simulation'),
      }));
      expect(stored.simulationRun).toEqual(NA('NOT_SIMULATION_BACKED', 'no simulation'));
      const none = await ready({ applicability: {} });
      expect((await boundaries.recordBoundaries(none.ctx, input(none, { simulationRun: NA('NOT_SIMULATION_BACKED', 'no simulation') }))).simulationRun.state).toBe('NOT_APPLICABLE');
    });
  });

  describe('shapes', () => {
    it.each<[string, Record<string, unknown>, RegExp]>([
      ['a window ending before it starts', { executionWindow: G({ startsAt: iso(new Date(Date.now() + 2 * HOUR)), endsAt: iso(new Date(Date.now() + HOUR)) }) }, /must end after it starts/],
      ['no preconditions', { preconditions: G([]) }, /between 1 and 500/],
      ['an unknown operator', { preconditions: G([{ code: 'a', operator: 'approx', operand: 1 }]) }, /known operator/],
      ['a negative budget', { budget: G({ amount: '-5', currency: 'USD' }) }, /non-negative decimal/],
      ['a lower-case currency', { budget: G({ amount: '5', currency: 'usd' }) }, /three-letter currency/],
      ['blank rollback instructions', { rollback: G({ instructions: '  ' }) }, /non-blank instructions/],
      ['no monitoring metrics', { monitoring: G({ metrics: [] }) }, /between 1 and 500 metrics/],
      ['a non-uuid simulation run', { simulationRun: G('run-1') }, /lowercase UUID/],
      ['a lower-case NOT_APPLICABLE code', { budget: NA('no_spend') }, /budget must be VALUE or a governed NOT_APPLICABLE/],
    ])('rejects %s, naming the problem', async (_name, over, message) => {
      const r = await ready({ applicability: ALL_ALLOWED });
      await expect(boundaries.recordBoundaries(r.ctx, input(r, over))).rejects.toThrow(message);
      await expect(boundaries.recordBoundaries(r.ctx, input(r, over))).rejects.toBeInstanceOf(ValidationError);
      expect(await boundaries.getCurrent(r.ctx, r.f.actionId)).toBeNull();
    });

    it('rejects UNAVAILABLE and malformed input before the database', async () => {
      const r = await ready();
      for (const field of [...FIVE, 'simulationRun']) {
        await expect(boundaries.recordBoundaries(r.ctx, input(r, { [field]: { state: 'UNAVAILABLE', source: 'x' } }))).rejects.toThrow(/UNAVAILABLE can never be stored/);
      }
      await expect(boundaries.recordBoundaries(r.ctx, input(r, { actionId: 'x' }))).rejects.toBeInstanceOf(ValidationError);
      await expect(boundaries.recordBoundaries(r.ctx, input(r, { captureId: 'x' }))).rejects.toBeInstanceOf(ValidationError);
      await expect(boundaries.recordBoundaries(r.ctx, input(r, { authoredByUserId: randomUUID() }))).rejects.toThrow();
    });

    it('bounds the size of preconditions and monitoring', async () => {
      const r = await ready();
      const many = Array.from({ length: 400 }, (_v, n) => ({ code: `c${n}`, operator: 'eq', operand: 'x'.repeat(250) }));
      await expect(boundaries.recordBoundaries(r.ctx, input(r, { preconditions: G(many) }))).rejects.toThrow();
      await expect(boundaries.recordBoundaries(r.ctx, input(r, { preconditions: G(Array.from({ length: 501 }, (_v, n) => ({ code: `c${n}`, operator: 'eq', operand: 1 }))) }))).rejects.toThrow(/between 1 and 500/);
    });

    it('holds the database validator to the shared golden cases (and never accepts what the contract rejects)', async () => {
      const file = resolve(__dirname, '../../handoff-contracts/tests/fixtures/boundary-golden-cases.json');
      const { cases } = JSON.parse(readFileSync(file, 'utf8')) as { cases: { field: string; name: string; value: any; contractValid: boolean; dbValid: boolean }[] };
      expect(cases.length).toBeGreaterThanOrEqual(55);
      const valid = {
        executionWindow: G({ startsAt: '2026-12-01T09:00:00.000Z', endsAt: null }), preconditions: G([{ code: 'a', operator: 'eq', operand: 1 }]),
        budget: G({ amount: '1', currency: 'USD' }), rollback: G({ instructions: 'x' }), monitoring: G({ metrics: [{ metricCode: 'm', target: null, unit: null }] }),
        simulationRun: G('5f1c8a52-0c36-4f4d-8a3b-1f7d4a2e9b10'),
      } as Record<string, unknown>;
      expect((await admin.query<{ p: string[] }>(
        `SELECT ${S}.aap_boundary_problems($1::jsonb,$2::jsonb,$3::jsonb,$4::jsonb,$5::jsonb,$6::jsonb) AS p`,
        ['executionWindow', 'preconditions', 'budget', 'rollback', 'monitoring', 'simulationRun'].map((k) => JSON.stringify(valid[k])),
      )).rows[0].p).toEqual([]);
      const mismatches: string[] = [];
      for (const c of cases) {
        const doc = { ...valid, [c.field]: c.value };
        const problems = (await admin.query<{ p: string[] }>(
          `SELECT ${S}.aap_boundary_problems($1::jsonb,$2::jsonb,$3::jsonb,$4::jsonb,$5::jsonb,$6::jsonb) AS p`,
          ['executionWindow', 'preconditions', 'budget', 'rollback', 'monitoring', 'simulationRun'].map((k) => JSON.stringify(doc[k])),
        )).rows[0].p;
        if ((problems.length === 0) !== c.dbValid) mismatches.push(`${c.field}: ${c.name}`);
        if (c.dbValid && !c.contractValid) mismatches.push(`DB accepts what the contract rejects: ${c.field}: ${c.name}`);
      }
      expect(mismatches).toEqual([]);
    });
  });

  describe('database guards hold even without the repository', () => {
    async function raw(r: Ready, over: Record<string, unknown>) {
      const base = input(r);
      const cols: Record<string, unknown> = {
        tenant_id: r.f.tenantId, workspace_id: r.f.workspaceId, business_id: r.f.businessId, action_id: r.f.actionId, capture_id: r.captureId,
        boundary_version: 1, supersedes_boundary_version: null,
        execution_window: JSON.stringify(base.executionWindow), preconditions: JSON.stringify(base.preconditions), budget: JSON.stringify(base.budget),
        rollback: JSON.stringify(base.rollback), monitoring: JSON.stringify(base.monitoring), simulation_run: JSON.stringify(base.simulationRun),
        authored_by_user_id: r.f.userId, correlation_id: cid(), ...over,
      };
      const keys = Object.keys(cols);
      return admin.query(`INSERT INTO ${BOUNDARIES} (${keys.join(',')}) VALUES (${keys.map((_, n) => `$${n + 1}`).join(',')})`, keys.map((k) => cols[k]));
    }

    it('enforces the shape validator and the applicability rule on a direct write', async () => {
      const r = await ready();
      await expect(raw(r, { budget: JSON.stringify(G({ amount: 'x', currency: 'USD' })) })).rejects.toThrow(/invalid boundaries/);
      await expect(raw(r, { budget: JSON.stringify(NA('NO_SPEND')) })).rejects.toThrow(/requires budget; NOT_APPLICABLE is not permitted/);
      await expect(raw(r, { simulation_run: JSON.stringify({ state: 'UNAVAILABLE' }) })).rejects.toThrow(/invalid boundaries/);
      await raw(r, {});
    });

    it('keeps the version chain linear and unique', async () => {
      const r = await ready();
      await expect(raw(r, { boundary_version: 2, supersedes_boundary_version: 1 })).rejects.toThrow(/supersedes_fk|foreign key/);
      await raw(r, {});
      await expect(raw(r, { boundary_version: 3, supersedes_boundary_version: 1 })).rejects.toThrow(/chain/);
      await expect(raw(r, { boundary_version: 2, supersedes_boundary_version: null })).rejects.toThrow(/chain/);
      await expect(raw(r, {})).rejects.toThrow(/boundaries_key|duplicate/);
    });

    it('rejects UPDATE and DELETE for every role and stamps the clock whatever the writer says', async () => {
      const r = await ready();
      await raw(r, { authored_at: '2001-01-01T00:00:00Z' });
      const row = (await admin.query(`SELECT authored_at FROM ${BOUNDARIES} WHERE action_id = $1`, [r.f.actionId])).rows[0];
      expect(Math.abs(new Date(row.authored_at).getTime() - Date.now())).toBeLessThan(5000);
      await expect(admin.query(`UPDATE ${BOUNDARIES} SET created_at = now() WHERE action_id = $1`, [r.f.actionId])).rejects.toThrow(/append-only/);
      await expect(admin.query(`DELETE FROM ${BOUNDARIES} WHERE action_id = $1`, [r.f.actionId])).rejects.toThrow(/append-only/);
    });
  });

  describe('tenant isolation', () => {
    it('is invisible to other tenants and cannot be written into another tenant', async () => {
      const r = await ready();
      await boundaries.recordBoundaries(r.ctx, input(r));
      const stranger = await ready({ world: worldB });
      expect(await boundaries.getCurrent(stranger.ctx, r.f.actionId)).toBeNull();
      expect(await boundaries.getVersion(stranger.ctx, r.f.actionId, 1)).toBeNull();
      expect(await boundaries.listVersions(stranger.ctx, r.f.actionId)).toEqual([]);
      await expect(boundaries.recordBoundaries(stranger.ctx, input(r))).rejects.toThrow();
    });
  });
});
