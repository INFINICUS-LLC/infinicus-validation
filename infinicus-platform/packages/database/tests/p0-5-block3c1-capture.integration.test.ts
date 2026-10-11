/**
 * P0-5 Block 3c-1 - live PostgreSQL proof of migration 0177 and AuthorizedActionCaptureRepository.
 *
 * Proves: the immutable decision-time capture (original, delta, final) with the final set re-derived by the database,
 * and the accountable-owner assignment chain bound to Identity/Tenancy. No issuer, no package, no events, no BO receipt,
 * no wiring into the approval route.
 *
 * Requires:
 *   DATABASE_URL       - least-privilege application role (RLS enforced): the repository runs as this role
 *   ADMIN_DATABASE_URL - privileged role: builds upstream fixtures and inspects state
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- fixtures deliberately mutate arbitrary paths of JSON documents */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { closePool, createPool, type TenantContext } from '../src/client.js';
import { AuthorizedActionCaptureRepository, toAccountableOwnerShape } from '../src/repositories/approved_action/AuthorizedActionCaptureRepository.js';
import { ConflictError, ValidationError } from '../src/repositories/approved_action/errors.js';
import {
  HOUR, iso, makeCaptureFixture, makeMembership, makeUser, makeWorld, modifiedCaptureInput, ownerInput, plainCaptureInput, type CaptureFixture, type World,
} from './helpers/aapFixtures.js';

const run = Boolean(process.env.DATABASE_URL && process.env.ADMIN_DATABASE_URL);
const MS_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CAPTURES = 'approved_business_action.authorized_action_captures';
const OWNERS = 'approved_business_action.authorized_action_owner_assignments';

let admin: Pool;
/** Shared worlds keep the shared database small: each test still gets its own decision, action and users. B is the "other tenant". */
let worldA: World;
let worldB: World;
const mk = (status = 'approved') => makeCaptureFixture(admin, status, worldA);
const repo = new AuthorizedActionCaptureRepository();
const ctxOf = (f: CaptureFixture): TenantContext => ({ tenantId: f.tenantId, workspaceId: f.workspaceId, userId: f.userId });

describe.runIf(run)('P0-5 Block 3c-1: capture and owner assignment (migration 0177)', () => {
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

  describe('capture: storage and idempotency', () => {
    it('stores a plain approval and reads it back, stamped with the database clock', async () => {
      const f = await mk();
      const input = plainCaptureInput(f);
      const stored = await repo.recordCapture(ctxOf(f), input);
      expect(stored).toMatchObject({
        actionId: f.actionId, decisionId: f.decisionId, decisionStatus: 'approved',
        actionType: { code: 'adjust_price', schemaVersion: '1.0' }, target: { kind: 'product', id: 'sku-123' },
      });
      expect(stored.finalParameters).toEqual(input.finalParameters);
      expect(stored.proposed).toEqual(input.proposed);
      expect(stored.capturedAt).toMatch(MS_UTC);
      expect(Math.abs(Date.parse(stored.capturedAt) - Date.now())).toBeLessThan(5000);
      expect(await repo.getCaptureByActionId(ctxOf(f), f.actionId)).toEqual(stored);
      expect(await repo.requireCapture(ctxOf(f), f.actionId)).toEqual(stored);
    });

    it('stores an approved-with-modifications capture whose final set is the original with the delta applied', async () => {
      const f = await mk('approved_with_modifications');
      const stored = await repo.recordCapture(ctxOf(f), modifiedCaptureInput(f));
      expect(stored.finalParameters).toEqual({ price: 12, tags: ['a', 'b'], limit: 5 });
      expect(stored.modification.state).toBe('VALUE');
    });

    it('ignores a caller-supplied time: the capture is stamped by the database', async () => {
      const f = await mk();
      const stored = await repo.recordCapture(ctxOf(f), plainCaptureInput(f));
      const row = (await admin.query(`SELECT captured_at FROM ${CAPTURES} WHERE id = $1`, [stored.id])).rows[0];
      expect(new Date(row.captured_at).toISOString()).toBe(stored.capturedAt);
    });

    it('is idempotent: an identical capture (even with a new correlation id) returns the stored row', async () => {
      const f = await mk();
      const input = plainCaptureInput(f);
      const first = await repo.recordCapture(ctxOf(f), input);
      const again = await repo.recordCapture(ctxOf(f), { ...input, correlationId: randomUUID() });
      expect(again.id).toBe(first.id);
    });

    it('treats parameter key order as irrelevant when recognizing a replay', async () => {
      const f = await mk();
      const input = plainCaptureInput(f);
      const first = await repo.recordCapture(ctxOf(f), input);
      const reordered = { ...input, finalParameters: { tags: ['a', 'b'], channel: 'email', price: 10 } };
      reordered.proposed = { ...input.proposed, value: { ...input.proposed.value, parameters: { channel: 'email', price: 10, tags: ['a', 'b'] } } };
      expect((await repo.recordCapture(ctxOf(f), reordered)).id).toBe(first.id);
    });

    it('refuses a different capture for the same action (captures are immutable)', async () => {
      const f = await mk();
      const input = plainCaptureInput(f);
      await repo.recordCapture(ctxOf(f), input);
      const other = { ...input, target: { kind: 'product', id: 'sku-999' } };
      await expect(repo.recordCapture(ctxOf(f), other)).rejects.toBeInstanceOf(ConflictError);
    });

    it('is safe under concurrency: simultaneous identical captures store one row (repeated rounds)', async () => {
      for (let round = 0; round < 6; round += 1) {
        const f = await mk();
        const input = plainCaptureInput(f);
        const rows = await Promise.all(Array.from({ length: 10 }, () => repo.recordCapture(ctxOf(f), input)));
        expect(new Set(rows.map((r) => r.id)).size).toBe(1);
        expect((await admin.query(`SELECT count(*)::int AS n FROM ${CAPTURES} WHERE action_id = $1`, [f.actionId])).rows[0].n).toBe(1);
      }
    });
  });

  describe('capture: the database re-derives the final set', () => {
    async function rejects(mutate: (i: any, f: CaptureFixture) => void, message: RegExp, base: 'plain' | 'modified' = 'modified') {
      const f = await mk(base === 'plain' ? 'approved' : 'approved_with_modifications');
      const input = base === 'plain' ? plainCaptureInput(f) : modifiedCaptureInput(f);
      mutate(input, f);
      await expect(repo.recordCapture(ctxOf(f), input)).rejects.toThrow(message);
      await expect(repo.recordCapture(ctxOf(f), input)).rejects.toBeInstanceOf(ValidationError);
      expect(await repo.getCaptureByActionId(ctxOf(f), f.actionId)).toBeNull();
    }

    it('rejects a final set that is not the original with the delta applied', async () => {
      await rejects((i) => { i.finalParameters = { price: 99, tags: ['a', 'b'], limit: 5 }; }, /not the original with the recorded delta applied/);
      await rejects((i) => { i.finalParameters = { price: 12, tags: ['a', 'b'] }; }, /not the original with the recorded delta applied/);
      await rejects((i) => { i.finalParameters = { price: 12, tags: ['a', 'b'], limit: 5, extra: true }; }, /not the original with the recorded delta applied/);
    });

    it('rejects a plain approval whose final set differs from the proposed set', async () => {
      await rejects((i) => { i.finalParameters = { price: 11, channel: 'email', tags: ['a', 'b'] }; }, /exactly the proposed parameters/, 'plain');
    });

    it('rejects a plain approval that carries a modification or an evaluation', async () => {
      await rejects((i, f) => { i.modification = modifiedCaptureInput(f).modification; }, /plain approval carries no modification/, 'plain');
      await rejects((i, f) => { i.modificationEvaluation = modifiedCaptureInput(f).modificationEvaluation; }, /plain approval carries no modification/, 'plain');
    });

    it('rejects approved_with_modifications without a structured delta, or without the original it modifies', async () => {
      await rejects((i) => { i.modification = { state: 'NOT_APPLICABLE', reason: { code: 'X', statement: 'y' } }; }, /requires a structured modification delta/);
      await rejects((i) => { i.proposed = { state: 'NOT_APPLICABLE', reason: { code: 'X', statement: 'y' } }; }, /needs the original proposed parameter set/);
    });

    it.each<[string, (changes: any[]) => any[], RegExp]>([
      ['a parameter changed twice', (c) => [...c, { parameter: 'price', operation: 'SET', before: 12, after: 13 }], /changed more than once/],
      ['a SET that does not change the value', () => [{ parameter: 'price', operation: 'SET', before: 10, after: 10 }], /must change the value/],
      ['a SET whose before is not the original value', () => [{ parameter: 'price', operation: 'SET', before: 7, after: 12 }], /requires the original value as before/],
      ['a SET with no before', () => [{ parameter: 'price', operation: 'SET', after: 12 }], /requires the original value as before/],
      ['a SET of a parameter that does not exist', () => [{ parameter: 'nope', operation: 'SET', before: 1, after: 2 }], /requires the original value as before/],
      ['an ADD of a parameter that already exists', () => [{ parameter: 'price', operation: 'ADD', after: 12 }], /ADD of price requires a parameter absent/],
      ['an ADD with a before', () => [{ parameter: 'limit', operation: 'ADD', before: 1, after: 5 }], /ADD of limit requires/],
      ['a REMOVE whose before is wrong', () => [{ parameter: 'channel', operation: 'REMOVE', before: 'sms' }], /REMOVE of channel requires/],
      ['a REMOVE with an after', () => [{ parameter: 'channel', operation: 'REMOVE', before: 'email', after: 'x' }], /REMOVE of channel requires/],
      ['an unknown operation', () => [{ parameter: 'price', operation: 'REPLACE', before: 10, after: 12 }], /unknown operation/],
      ['a nameless change', () => [{ operation: 'ADD', after: 1 }], /needs a parameter name/],
      ['an empty change list', () => [], /at least one change/],
    ])('rejects %s', async (_name, build, message) => {
      await rejects((i) => { i.modification.value.changes = build(i.modification.value.changes); }, message);
    });

    it('applies an ADD of an explicit null and a nested value exactly', async () => {
      const f = await mk('approved_with_modifications');
      const input = modifiedCaptureInput(f);
      input.modification.value.changes = [
        { parameter: 'limit', operation: 'ADD', after: null },
        { parameter: 'schedule', operation: 'ADD', after: { days: ['mon', 'tue'], hour: 9 } },
      ];
      input.finalParameters = { price: 10, channel: 'email', tags: ['a', 'b'], limit: null, schedule: { days: ['mon', 'tue'], hour: 9 } };
      const stored = await repo.recordCapture(ctxOf(f), input);
      expect(stored.finalParameters).toEqual(input.finalParameters);
    });
  });

  describe('capture: decision relationship and document shapes', () => {
    async function rejectsOn(f: CaptureFixture, input: any, message: RegExp) {
      await expect(repo.recordCapture(ctxOf(f), input)).rejects.toThrow(message);
    }

    it('requires an approved decision and the exact status', async () => {
      for (const status of ['draft', 'rejected', 'superseded']) {
        const f = await mk(status);
        await rejectsOn(f, plainCaptureInput(f), /the decision is not approved/);
      }
      const f = await mk('approved');
      await rejectsOn(f, { ...modifiedCaptureInput(f) }, /the decision is not approved/);
    });

    it('requires the decision version and the action to belong to the decision', async () => {
      const f = await mk();
      const other = await mk();
      await rejectsOn(f, { ...plainCaptureInput(f), decisionVersionId: other.decisionVersionId }, /decision version does not belong/);
      await rejectsOn(f, { ...plainCaptureInput(f), decisionId: other.decisionId, decisionVersionId: other.decisionVersionId }, /action\/decision\/scope do not match/);
    });

    it.each<[string, (i: any) => void, RegExp]>([
      ['a non-ADI source', (i) => { i.proposed.value.source.layer = 'SIM'; }, /ADI source/],
      ['a non-uuid source record', (i) => { i.proposed.value.source.recordId = 'nope'; }, /ADI source/],
      ['parameters that are not an object', (i) => { i.proposed.value.parameters = [1]; }, /parameters object/],
      ['a NOT_APPLICABLE without a reason', (i) => { i.modification = { state: 'NOT_APPLICABLE' }; }, /reason code and statement/],
      ['a NOT_APPLICABLE with a blank statement', (i) => { i.modification = { state: 'NOT_APPLICABLE', reason: { code: 'X', statement: ' ' } }; }, /reason code and statement/],
    ])('rejects %s', async (_name, mutate, message) => {
      const f = await mk();
      const input = plainCaptureInput(f);
      mutate(input);
      await expect(repo.recordCapture(ctxOf(f), input)).rejects.toThrow(message);
    });

    it.each<[string, (i: any, f: CaptureFixture) => void, RegExp]>([
      ['a blank reason', (i) => { i.modification.value.reason = '  '; }, /needs a reason/],
      ['a non-uuid modifier', (i) => { i.modification.value.modifiedByUserId = 'nope'; }, /needs a reason/],
      ['a non-millisecond timestamp', (i) => { i.modification.value.modifiedAt = '2026-01-01T00:00:00Z'; }, /needs a reason/],
      ['a modification dated in the future', (i) => { i.modification.value.modifiedAt = iso(new Date(Date.now() + 2 * HOUR)); }, /dated after the capture/],
      ['evidence with an unknown dimension', (i) => { i.modificationEvaluation.value.evidence[0].dimension = 'VIBES'; }, /malformed governance evidence/],
      ['evidence that did not pass', (i) => { i.modificationEvaluation.value.evidence[0].result = 'FAILED'; }, /malformed governance evidence/],
      ['evidence that predates the modification', (i) => { i.modificationEvaluation.value.evidence[0].evaluatedAt = iso(new Date(Date.now() - 24 * HOUR)); }, /predates the modification/],
      ['an evaluation without evidence', (i) => { i.modificationEvaluation.value.evidence = []; }, /basis and at least one piece of evidence/],
      ['an unknown evaluation basis', (i) => { i.modificationEvaluation.value.basis = 'GUESS'; }, /basis and at least one piece of evidence/],
    ])('rejects a modification with %s', async (_name, mutate, message) => {
      const f = await mk('approved_with_modifications');
      const input = modifiedCaptureInput(f);
      mutate(input, f);
      await expect(repo.recordCapture(ctxOf(f), input)).rejects.toThrow(message);
    });

    it('rejects UNAVAILABLE and malformed inputs before touching the database', async () => {
      const f = await mk();
      const ctx = ctxOf(f);
      const base = plainCaptureInput(f);
      await expect(repo.recordCapture(ctx, { ...base, proposed: { state: 'UNAVAILABLE', source: 'x' } })).rejects.toThrow(/UNAVAILABLE can never be stored/);
      await expect(repo.recordCapture(ctx, { ...base, actionId: 'x' })).rejects.toBeInstanceOf(ValidationError);
      await expect(repo.recordCapture(ctx, { ...base, decisionStatus: 'rejected' })).rejects.toBeInstanceOf(ValidationError);
      await expect(repo.recordCapture(ctx, { ...base, finalParameters: [1] })).rejects.toBeInstanceOf(ValidationError);
      await expect(repo.recordCapture(ctx, { ...base, actionType: { code: ' ', schemaVersion: '1' } })).rejects.toBeInstanceOf(ValidationError);
      await expect(repo.recordCapture(ctx, { ...base, actionType: { code: 'x', schemaVersion: 'v1' } })).rejects.toThrow();
    });

    it('bounds the size of the final parameters', async () => {
      const f = await mk();
      const input = plainCaptureInput(f);
      const big = { blob: 'x'.repeat(70 * 1024) };
      input.finalParameters = big;
      input.proposed.value.parameters = big;
      await expect(repo.recordCapture(ctxOf(f), input)).rejects.toThrow();
    });
  });

  describe('capture: append-only and tenant isolation', () => {
    it('rejects UPDATE and DELETE even for a privileged role', async () => {
      const f = await mk();
      await repo.recordCapture(ctxOf(f), plainCaptureInput(f));
      await expect(admin.query(`UPDATE ${CAPTURES} SET target_id = 'x'`)).rejects.toThrow(/append-only/);
      await expect(admin.query(`DELETE FROM ${CAPTURES}`)).rejects.toThrow(/append-only/);
    });

    it('does not expose a capture to another tenant, and another tenant cannot record one for it', async () => {
      const f = await mk();
      await repo.recordCapture(ctxOf(f), plainCaptureInput(f));
      const stranger = await makeCaptureFixture(admin, 'approved', worldB);
      expect(await repo.getCaptureByActionId(ctxOf(stranger), f.actionId)).toBeNull();
      await expect(repo.requireCapture(ctxOf(stranger), f.actionId)).rejects.toThrow(/not found/);
      await expect(repo.recordCapture(ctxOf(stranger), plainCaptureInput(f))).rejects.toThrow();
    });
  });

  describe('database guards hold even without the repository', () => {
    async function rawOwner(f: CaptureFixture, over: Record<string, unknown>) {
      const cols: Record<string, unknown> = {
        tenant_id: f.tenantId, workspace_id: f.workspaceId, business_id: f.businessId, action_id: f.actionId,
        assignment_version: 1, supersedes_assignment_version: null, owner_user_id: f.ownerUserId, owner_membership_id: f.ownerMembershipId,
        role_code: 'lead', assigned_by_user_id: f.userId, due_at: null,
        due_not_applicable_reason: JSON.stringify({ code: 'X', statement: 'y' }), escalation_policy_ref: 'p',
        escalation_not_applicable_reason: null, correlation_id: randomUUID(), ...over,
      };
      const keys = Object.keys(cols);
      return admin.query(`INSERT INTO ${OWNERS} (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`, keys.map((k) => cols[k]));
    }

    it('keeps the owner version chain linear: no gaps, no skipped predecessors, no version 1 with a predecessor', async () => {
      const f = await mk();
      await expect(rawOwner(f, { assignment_version: 2, supersedes_assignment_version: 1 })).rejects.toThrow(/supersedes_fk|foreign key/);
      await rawOwner(f, {});
      await expect(rawOwner(f, { assignment_version: 3, supersedes_assignment_version: 1 })).rejects.toThrow(/chain/);
      await expect(rawOwner(f, { assignment_version: 2, supersedes_assignment_version: null })).rejects.toThrow(/chain/);
      await expect(rawOwner(f, { assignment_version: 1 })).rejects.toThrow(/owner_assignments_key|duplicate/);
    });

    it('requires exactly one of a due date and a governed NOT_APPLICABLE reason (and the same for escalation)', async () => {
      const f = await mk();
      const due = new Date(Date.now() + 24 * HOUR);
      await expect(rawOwner(f, { due_at: due })).rejects.toThrow(/due_exactly_one/);
      await expect(rawOwner(f, { due_not_applicable_reason: null })).rejects.toThrow(/due_exactly_one/);
      await expect(rawOwner(f, { escalation_not_applicable_reason: JSON.stringify({ code: 'X', statement: 'y' }) })).rejects.toThrow(/escalation_exactly_one/);
      await expect(rawOwner(f, { escalation_policy_ref: null })).rejects.toThrow(/escalation_exactly_one/);
      await expect(rawOwner(f, { due_not_applicable_reason: JSON.stringify({ code: '', statement: 'y' }) })).rejects.toThrow(/reason_shapes/);
    });

    it('allows one capture per action even when written directly', async () => {
      const f = await mk();
      await repo.recordCapture(ctxOf(f), plainCaptureInput(f));
      const row = (await admin.query(`SELECT * FROM ${CAPTURES} WHERE action_id = $1`, [f.actionId])).rows[0];
      delete row.id;
      const keys = Object.keys(row);
      const values = keys.map((k) => (typeof row[k] === 'object' && row[k] !== null && !(row[k] instanceof Date) ? JSON.stringify(row[k]) : row[k]));
      await expect(admin.query(`INSERT INTO ${CAPTURES} (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`, values))
        .rejects.toThrow(/captures_action_unique/);
    });
  });

  describe('owner assignment', () => {
    it('assigns version 1 with provenance and exposes the contract accountableOwner shape', async () => {
      const f = await mk();
      const input = ownerInput(f);
      const a = await repo.assignOwner(ctxOf(f), input);
      expect(a).toMatchObject({ assignmentVersion: 1, supersedesAssignmentVersion: null, roleCode: 'operations_lead', assignedByUserId: f.userId });
      expect(a.owner).toEqual({ userId: f.ownerUserId, membershipId: f.ownerMembershipId });
      expect(a.assignedAt).toMatch(MS_UTC);
      expect(a.dueAt).toEqual({ state: 'VALUE', value: input.dueAt.value });
      expect(toAccountableOwnerShape(a)).toEqual({
        identity: { userId: f.ownerUserId, membershipId: f.ownerMembershipId },
        roleCode: 'operations_lead',
        assignment: { assignmentId: a.id, assignedByUserId: f.userId, assignedAt: a.assignedAt },
        dueAt: a.dueAt,
        escalationPolicy: { state: 'VALUE', value: { ref: 'policy:default-escalation' } },
      });
      expect(await repo.getCurrentOwner(ctxOf(f), f.actionId)).toEqual(a);
      expect(await repo.getOwnerVersion(ctxOf(f), f.actionId, 1)).toEqual(a);
      expect(await repo.getOwnerVersion(ctxOf(f), f.actionId, 2)).toBeNull();
    });

    it('preserves governed NOT_APPLICABLE due date and escalation with their reasons', async () => {
      const f = await mk();
      const na = (code: string) => ({ state: 'NOT_APPLICABLE', reason: { code, statement: `${code} statement` } });
      const a = await repo.assignOwner(ctxOf(f), ownerInput(f, { dueAt: na('NO_DEADLINE'), escalationPolicy: na('NO_ESCALATION') }));
      expect(a.dueAt).toEqual(na('NO_DEADLINE'));
      expect(a.escalationPolicy).toEqual(na('NO_ESCALATION'));
    });

    it('is idempotent for the same owner, and re-assignment adds a linear version', async () => {
      const f = await mk();
      const input = ownerInput(f);
      const v1 = await repo.assignOwner(ctxOf(f), input);
      expect((await repo.assignOwner(ctxOf(f), { ...input, correlationId: randomUUID() })).id).toBe(v1.id);
      const v2 = await repo.assignOwner(ctxOf(f), { ...input, roleCode: 'finance_lead' });
      expect(v2).toMatchObject({ assignmentVersion: 2, supersedesAssignmentVersion: 1, roleCode: 'finance_lead' });
      const otherUser = await makeUser(admin);
      const otherMembership = await makeMembership(admin, f.tenantId, f.workspaceId, otherUser);
      const v3 = await repo.assignOwner(ctxOf(f), { ...input, owner: { userId: otherUser, membershipId: otherMembership } });
      expect(v3.assignmentVersion).toBe(3);
      expect((await repo.listOwnerVersions(ctxOf(f), f.actionId)).map((v) => v.assignmentVersion)).toEqual([1, 2, 3]);
      expect((await repo.getCurrentOwner(ctxOf(f), f.actionId))?.id).toBe(v3.id);
    });

    it('requires a real user with an ACTIVE membership in this tenant and workspace', async () => {
      const f = await mk();
      const stranger = await makeUser(admin);
      const strangerMembership = await makeMembership(admin, f.tenantId, f.workspaceId, stranger);
      const message = /active membership in this tenant and workspace/;
      // a membership that belongs to a different user
      await expect(repo.assignOwner(ctxOf(f), ownerInput(f, { owner: { userId: f.ownerUserId, membershipId: strangerMembership } }))).rejects.toThrow(message);
      // not active
      for (const status of ['invited', 'suspended', 'removed']) {
        const u = await makeUser(admin);
        const m = await makeMembership(admin, f.tenantId, f.workspaceId, u, status);
        await expect(repo.assignOwner(ctxOf(f), ownerInput(f, { owner: { userId: u, membershipId: m } }))).rejects.toThrow(message);
      }
      // a membership in a different workspace of the same tenant
      const wsId = randomUUID();
      await admin.query('INSERT INTO tenancy.workspaces (id, tenant_id, name, slug) VALUES ($1,$2,$3,$4)', [wsId, f.tenantId, `w${wsId.slice(0, 8)}`, `w${wsId.slice(0, 8)}`]);
      const u = await makeUser(admin);
      const m = await makeMembership(admin, f.tenantId, wsId, u);
      await expect(repo.assignOwner(ctxOf(f), ownerInput(f, { owner: { userId: u, membershipId: m } }))).rejects.toThrow(message);
      // a user that does not exist
      await expect(repo.assignOwner(ctxOf(f), ownerInput(f, { owner: { userId: randomUUID(), membershipId: f.ownerMembershipId } }))).rejects.toThrow();
      expect(await repo.getCurrentOwner(ctxOf(f), f.actionId)).toBeNull();
    });

    it('requires a future due date and well-formed governed fields', async () => {
      const f = await mk();
      const ctx = ctxOf(f);
      await expect(repo.assignOwner(ctx, ownerInput(f, { dueAt: { state: 'VALUE', value: iso(new Date(Date.now() - HOUR)) } }))).rejects.toThrow(/due date must be after the assignment/);
      await expect(repo.assignOwner(ctx, ownerInput(f, { dueAt: { state: 'VALUE', value: 'not a date' } }))).rejects.toBeInstanceOf(ValidationError);
      await expect(repo.assignOwner(ctx, ownerInput(f, { dueAt: { state: 'UNAVAILABLE', source: 'x' } }))).rejects.toThrow(/UNAVAILABLE can never be stored/);
      await expect(repo.assignOwner(ctx, ownerInput(f, { dueAt: { state: 'NOT_APPLICABLE', reason: { code: '', statement: '' } } }))).rejects.toBeInstanceOf(ValidationError);
      await expect(repo.assignOwner(ctx, ownerInput(f, { escalationPolicy: { state: 'VALUE', value: { ref: ' ' } } }))).rejects.toBeInstanceOf(ValidationError);
      await expect(repo.assignOwner(ctx, ownerInput(f, { roleCode: ' ' }))).rejects.toBeInstanceOf(ValidationError);
      await expect(repo.assignOwner(ctx, ownerInput(f, { assignedByUserId: randomUUID() }))).rejects.toThrow();
    });

    it('is safe under concurrency: identical assignments store one version, different ones stay linear', async () => {
      const f = await mk();
      const input = ownerInput(f);
      const same = await Promise.all(Array.from({ length: 6 }, () => repo.assignOwner(ctxOf(f), input)));
      expect(new Set(same.map((r) => r.id)).size).toBe(1);

      const g = await mk();
      await Promise.all(Array.from({ length: 5 }, (_v, i) => repo.assignOwner(ctxOf(g), ownerInput(g, { roleCode: `role_${i}` }))));
      const versions = await repo.listOwnerVersions(ctxOf(g), g.actionId);
      expect(versions.map((v) => v.assignmentVersion)).toEqual([1, 2, 3, 4, 5]);
      expect(versions.map((v) => v.supersedesAssignmentVersion)).toEqual([null, 1, 2, 3, 4]);
    });

    it('rejects an action outside the caller scope, UPDATE/DELETE, and is invisible to other tenants', async () => {
      const f = await mk();
      const a = await repo.assignOwner(ctxOf(f), ownerInput(f));
      await expect(admin.query(`UPDATE ${OWNERS} SET role_code = 'x'`)).rejects.toThrow(/append-only/);
      await expect(admin.query(`DELETE FROM ${OWNERS}`)).rejects.toThrow(/append-only/);
      const stranger = await makeCaptureFixture(admin, 'approved', worldB);
      expect(await repo.getCurrentOwner(ctxOf(stranger), f.actionId)).toBeNull();
      expect(await repo.listOwnerVersions(ctxOf(stranger), f.actionId)).toEqual([]);
      await expect(repo.assignOwner(ctxOf(stranger), ownerInput(f))).rejects.toThrow();
      expect(a.assignmentVersion).toBe(1);
    });
  });
});
