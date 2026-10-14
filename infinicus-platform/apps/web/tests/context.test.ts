import { describe, it, expect, vi } from 'vitest';
import { parseWorkspaceClaim, resolveContext, type ContextDeps } from '../lib/context.js';

const T1 = '11111111-1111-1111-1111-111111111111';
const WS1 = '22222222-2222-2222-2222-222222222222';
const UID = '33333333-3333-3333-3333-333333333333';
const CLAIM = `${T1}:${WS1}`;

function deps(over: Partial<ContextDeps> = {}): ContextDeps & { authorize: ReturnType<typeof vi.fn> } {
  return {
    validateSession: vi.fn(async () => ({ user: { id: UID } })),
    getMembership: vi.fn(async () => ({ status: 'active' })),
    authorize: vi.fn(async () => undefined),
    ...over,
  } as never;
}

describe('parseWorkspaceClaim', () => {
  it('accepts <tenantId>:<workspaceId> UUIDs only', () => {
    expect(parseWorkspaceClaim(CLAIM)).toEqual({ tenantId: T1, workspaceId: WS1 });
    for (const bad of [undefined, '', T1, `${T1}:`, `:${WS1}`, `${T1}:${WS1}:x`, 'a:b', `${T1};${WS1}`]) expect(parseWorkspaceClaim(bad)).toBeNull();
  });
});

describe('resolveContext (J-2: identity and scope are server-derived)', () => {
  it('no session token => unauthenticated, and nothing else is consulted', async () => {
    const d = deps();
    expect(await resolveContext({ workspaceClaim: CLAIM }, [], d)).toEqual({ ok: false, reason: 'unauthenticated' });
    expect(d.validateSession).not.toHaveBeenCalled();
    expect(d.getMembership).not.toHaveBeenCalled();
  });

  it('an invalid, expired or revoked session => unauthenticated', async () => {
    const d = deps({ validateSession: vi.fn(async () => { throw new Error('SessionInvalidError'); }) });
    expect(await resolveContext({ sessionToken: 'x', workspaceClaim: CLAIM }, [], d)).toEqual({ ok: false, reason: 'unauthenticated' });
  });

  it('a valid session without a usable workspace claim => no_workspace', async () => {
    expect(await resolveContext({ sessionToken: 't' }, [], deps())).toEqual({ ok: false, reason: 'no_workspace' });
    expect(await resolveContext({ sessionToken: 't', workspaceClaim: 'nonsense' }, [], deps())).toEqual({ ok: false, reason: 'no_workspace' });
  });

  it('the userId in the context is the SESSION principal; the claim cannot carry one', async () => {
    const d = deps();
    const r = await resolveContext({ sessionToken: 't', workspaceClaim: CLAIM }, ['bo:read'], d);
    expect(r).toEqual({ ok: true, ctx: { tenantId: T1, workspaceId: WS1, userId: UID } });
    expect(d.getMembership).toHaveBeenCalledWith({ tenantId: T1, workspaceId: WS1, userId: UID }, UID);
  });

  it('no membership, or a non-active membership, in the claimed workspace => forbidden', async () => {
    for (const d of [
      deps({ getMembership: vi.fn(async () => { throw new Error('NotFoundError'); }) }),
      deps({ getMembership: vi.fn(async () => ({ status: 'suspended' })) }),
      deps({ getMembership: vi.fn(async () => ({ status: 'removed' })) }),
      deps({ getMembership: vi.fn(async () => ({ status: 'invited' })) }),
    ]) {
      expect(await resolveContext({ sessionToken: 't', workspaceClaim: CLAIM }, ['bo:read'], d)).toEqual({ ok: false, reason: 'forbidden' });
      expect(d.authorize).not.toHaveBeenCalled();
    }
  });

  it('requires EVERY listed permission (AND), checked per call; the first missing one fails closed', async () => {
    const d = deps({ authorize: vi.fn(async (_c, code: string) => { if (code === 'om:read') throw new Error('PermissionDeniedError'); }) as never });
    const r = await resolveContext({ sessionToken: 't', workspaceClaim: CLAIM }, ['bo:read', 'om:read', 'aba:read'], d);
    expect(r).toEqual({ ok: false, reason: 'forbidden' });
    expect((d.authorize as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1])).toEqual(['bo:read', 'om:read']);
  });
});
