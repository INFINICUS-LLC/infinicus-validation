/**
 * P0-6d - live PostgreSQL proof that Business Operations announces every terminal execution as `operations.action.executed@1`
 * atomically with the execution fact, once, as a reference (never a copy of the evidence, never an effectiveness claim).
 * Requires DATABASE_URL (app role, RLS) and ADMIN_DATABASE_URL.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- tests read arbitrary rows */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { AuthorizedActionExecutionRepository, closePool, createPool } from '@infinicus/database';
import type { TenantContext } from '@infinicus/database';
import { ACTION_EXECUTED_CONSUMER, ACTION_EXECUTED_EVENT_TYPE, actionExecutedEventId, isActionExecutedPayload } from '@infinicus/event-contracts';
import { AuthorizedActionExecutionService, type ExecutionEventPublisher, type ExecutionResult } from '../src/index.js';
import { answerFor } from './helpers/intakeFixture.js';
import { ScriptedProvider, SUPPORTED, buildPackage, claimPackage, consumedAnswer, makeExecWorld, type ExecWorld } from './helpers/executionWorld.js';
import { deleteMovementsForTenants } from './helpers/movementCleanup.js';

const run = Boolean(process.env.DATABASE_URL && process.env.ADMIN_DATABASE_URL);
const S = 'business_operations';
const OPEN = { isEnabled: async () => true };
const EFFECT = /(effectiv|improv|impact|benefit|uplift|successrate|outcomeverified|learned|learning)/i;

describe.runIf(run)('P0-6d: BO announces executions atomically', () => {
  let admin: Pool;
  const tenantIds: string[] = [];
  const repo = new AuthorizedActionExecutionRepository();

  beforeAll(() => {
    admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
    createPool({ connectionString: process.env.DATABASE_URL as string });
  });
  afterAll(async () => { await deleteMovementsForTenants(admin, tenantIds).catch(() => undefined); await admin?.end(); await closePool(); });

  const engine = (provider: ScriptedProvider, over: Record<string, unknown> = {}) => new AuthorizedActionExecutionService({
    statusProvider: provider, executionStatusMaxAgeMs: 5000, gate: OPEN, capabilities: SUPPORTED, ...over,
  });
  async function claimed() {
    const ew: ExecWorld = await makeExecWorld(admin, tenantIds, {});
    const pkg = await buildPackage(ew, { reorderPoint: 150, reorderQuantity: 250, modified: { baseline: [100, 200] } });
    const { claimId, receiptId } = await claimPackage(ew, pkg);
    const provider = new ScriptedProvider(() => consumedAnswer(pkg, receiptId));
    const ctx: TenantContext = { tenantId: ew.w.tenantId, workspaceId: ew.w.workspaceId, userId: randomUUID() };
    return { ew, pkg, claimId, receiptId, provider, ctx };
  }
  const terminal = (r: ExecutionResult) => { if (r.state !== 'TERMINAL') throw new Error(`expected a terminal result, got ${JSON.stringify(r)}`); return r.execution; };
  const outbox = async (tenantId: string) => (await admin.query(`SELECT * FROM events.outbox_events WHERE tenant_id=$1 AND event_type=$2`, [tenantId, ACTION_EXECUTED_EVENT_TYPE])).rows;

  it('a successful execution commits exactly one reference-only event whose digest is the evidence digest', async () => {
    const c = await claimed();
    const e = terminal(await engine(c.provider).executeClaim(c.ctx, c.claimId));
    const rows = await outbox(c.ew.w.tenantId);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row).toMatchObject({ status: 'pending', aggregate_id: e.id, id: actionExecutedEventId(e.id) });
    expect(isActionExecutedPayload(row.payload)).toBe(true);
    expect(row.payload).toMatchObject({
      executionId: e.id, contractVersion: 'execution-evidence/1', evidenceDigest: e.evidenceDigest, packageId: c.pkg.identity.packageId, claimId: c.claimId,
      outcome: 'SUCCEEDED', mutationResult: 'APPLIED', actionType: { code: 'inventory_reorder_policy_update', schemaVersion: '1' }, target: { kind: 'inventory_item', id: c.ew.itemId },
    });
    expect(JSON.stringify(row.payload)).not.toContain('reorderPoint'); // a reference: no evidence body travels in the event
    expect(JSON.stringify(row.payload)).not.toMatch(EFFECT); // BO announces a fact, never an effect
    expect(JSON.stringify(e.evidence)).not.toMatch(EFFECT);
    expect(row.headers).toMatchObject({ consumers: [ACTION_EXECUTED_CONSUMER] });
    expect(row.causation_id).toBe(c.claimId);
  });

  it('a refusal is announced too, as REFUSED / NOT_APPLICABLE, never as a success', async () => {
    const c = await claimed();
    c.provider.set(() => consumedAnswer(c.pkg, c.receiptId, { authority: { state: 'REVOKED' } }));
    const e = terminal(await engine(c.provider).executeClaim(c.ctx, c.claimId));
    const rows = await outbox(c.ew.w.tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toMatchObject({ executionId: e.id, outcome: 'REFUSED', mutationResult: 'NOT_APPLICABLE', evidenceDigest: e.evidenceDigest });
  });

  it('replays and 8 concurrent calls announce the execution once', async () => {
    const c = await claimed();
    const results = await Promise.all(Array.from({ length: 8 }, () => engine(c.provider).executeClaim(c.ctx, c.claimId)));
    await engine(c.provider).executeClaim(c.ctx, c.claimId);
    expect(new Set(results.map((r) => terminal(r).id)).size).toBe(1);
    expect(await outbox(c.ew.w.tenantId)).toHaveLength(1);
  });

  it('is atomic: if the event cannot be written the whole execution rolls back (no execution row, no mutation, no event)', async () => {
    const c = await claimed();
    const failing: ExecutionEventPublisher = { publish: async () => { throw new Error('outbox unavailable'); } };
    const before = (await admin.query(`SELECT reorder_point::float AS rp, version FROM ${S}.inventory_balances WHERE id=$1`, [c.ew.balanceId])).rows[0];
    const r = await engine(c.provider, { eventPublisher: failing }).executeClaim(c.ctx, c.claimId);
    expect(r.state).toBe('RETRY'); // not a silent success
    expect((await admin.query(`SELECT 1 FROM ${S}.authorized_action_executions WHERE claim_id=$1`, [c.claimId])).rowCount).toBe(0);
    expect((await admin.query(`SELECT reorder_point::float AS rp, version FROM ${S}.inventory_balances WHERE id=$1`, [c.ew.balanceId])).rows[0]).toEqual(before);
    expect(await outbox(c.ew.w.tenantId)).toHaveLength(0);
    // a later healthy attempt completes and announces once
    const e = terminal(await engine(c.provider).executeClaim(c.ctx, c.claimId));
    expect(e.outcome).toBe('SUCCEEDED');
    expect(await outbox(c.ew.w.tenantId)).toHaveLength(1);
  });

  it('the evidence the event references is retrievable by id in scope and nowhere else', async () => {
    const c = await claimed();
    const e = terminal(await engine(c.provider).executeClaim(c.ctx, c.claimId));
    expect((await repo.getById(c.ctx, e.id))?.evidenceDigest).toBe(e.evidenceDigest);
    const other = await claimed();
    expect(await repo.getById(other.ctx, e.id)).toBeNull(); // another tenant cannot read it (RLS)
  });
});
