/** P0-6f: the announcer's gate may be a per-issuance factory over the issuing context (no database: fake outbox). Closed unless the answer is exactly true. */
import { describe, expect, it } from 'vitest';
import type { TenantContext } from '@infinicus/database';
import type { AuthorizedActionPackageV1 } from '@infinicus/handoff-contracts';
import { ActionAuthorizedAnnouncer } from '../src/index.js';

const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ctx: TenantContext = { tenantId: U(2), workspaceId: U(3), userId: U(9) };
const pkg = {
  identity: { packageId: U(1), packageVersion: 1 }, integrity: { digest: `sha256:${'b'.repeat(64)}` },
  scope: { tenantId: U(2), workspaceId: U(3), businessId: U(4) }, action: { type: { code: 'inventory_reorder_policy_update', schemaVersion: '1' }, automationLevel: { level: 2 }, executionWindow: { state: 'NOT_APPLICABLE' } },
  validity: { expiresAt: { state: 'NOT_APPLICABLE' } }, lineage: { decision: { decisionId: U(5) } }, issuance: { issuedAt: '2026-10-12T10:00:00.000Z' },
} as unknown as AuthorizedActionPackageV1;
const trace = { correlationId: U(8), causationId: null };
const outbox = () => { const rows: unknown[] = []; return { rows, repo: { enqueueIfAbsent: async (_c: unknown, i: unknown) => { rows.push(i); return { inserted: true } as never; } } }; };

describe('ActionAuthorizedAnnouncer gate factory', () => {
  it('asks the factory with the ISSUING context and announces only on an exact true', async () => {
    const o = outbox(); const seen: TenantContext[] = [];
    const a = new ActionAuthorizedAnnouncer({ gate: (c) => { seen.push(c); return { isEnabled: async () => true }; }, outbox: o.repo });
    expect(await a.announce(ctx, pkg, trace)).toBe('ANNOUNCED');
    expect(seen).toEqual([ctx]);
    expect(o.rows).toHaveLength(1);
  });
  it('is closed when the gate says anything but true, throws, or the factory itself throws - nothing is written', async () => {
    for (const gate of [
      () => ({ isEnabled: async () => false }), () => ({ isEnabled: async () => 'yes' as never }), () => ({ isEnabled: async () => undefined as never }),
      () => ({ isEnabled: async () => { throw new Error('down'); } }), () => { throw new Error('factory down'); },
    ]) {
      const o = outbox();
      expect(await new ActionAuthorizedAnnouncer({ gate, outbox: o.repo }).announce(ctx, pkg, trace)).toBe('GATE_CLOSED');
      expect(o.rows).toHaveLength(0);
    }
  });
  it('a plain gate object still works, and no gate at all is deny-all', async () => {
    const o = outbox();
    expect(await new ActionAuthorizedAnnouncer({ gate: { isEnabled: async () => true }, outbox: o.repo }).announce(ctx, pkg, trace)).toBe('ANNOUNCED');
    const closed = outbox();
    expect(await new ActionAuthorizedAnnouncer({ outbox: closed.repo }).announce(ctx, pkg, trace)).toBe('GATE_CLOSED');
    expect(closed.rows).toHaveLength(0);
  });
});
