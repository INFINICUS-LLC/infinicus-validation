/**
 * Route-permission regression audit (P0-4 Block 3).
 *
 * Builds the real Fastify application and inspects the preHandler chain every registered route actually runs, so a
 * route added or edited later cannot silently rely on "authenticated = authorized".
 *
 * Rule: every route is either explicitly classified below as public / session-only / onboarding-bootstrap BY DESIGN
 * (with its reason), or it MUST run authenticate -> resolveTenantContext -> an explicit permission check, in that
 * order. There is no allowlist of tenant-scoped routes without a permission.
 *
 * No database is needed: routes are captured at registration time.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

const captured = vi.hoisted(() => ({ routes: [] as any[] }));

// Wraps Fastify so that (a) every route registration is recorded and (b) the handlers produced by requirePermission /
// requireAllPermissions carry the permission codes they enforce. Production behaviour is unchanged.
vi.mock('fastify', async (importOriginal) => {
  const mod: any = await importOriginal();
  const real = mod.default;
  const wrapped: any = (opts: any) => {
    const app = real(opts);
    const origDecorate = app.decorate.bind(app);
    app.decorate = (name: string, value: any, deps?: any) => {
      if (name === 'requirePermission') {
        const factory = value;
        value = (code: string) => { const h = factory(code); Object.defineProperty(h, '__perms', { value: [code] }); return h; };
      } else if (name === 'requireAllPermissions') {
        const factory = value;
        value = (codes: readonly string[]) => { const h = factory(codes); Object.defineProperty(h, '__perms', { value: [...new Set(codes)] }); return h; };
      }
      return origDecorate(name, value, deps);
    };
    app.addHook('onRoute', (r: any) => captured.routes.push(r));
    return app;
  };
  Object.assign(wrapped, real);
  return { ...mod, default: wrapped };
});

import { loadConfig } from '@infinicus/configuration';
import { buildApp } from '../src/app.js';

type Step = 'authenticate' | 'resolveTenantContext' | 'subscription' | 'idempotency' | `perm:${string}` | 'other';
interface RouteInfo { key: string; method: string; url: string; steps: Step[]; perms: string[]; bodyKeys: string[]; paramKeys: string[] }

/** Routes that are intentionally not tenant-permission gated, each with the reason. Keyed `METHOD url`. */
const BY_DESIGN: Record<string, { kind: 'public' | 'session' | 'onboarding'; reason: string }> = {
  'GET /v1/health': { kind: 'public', reason: 'liveness; no data' },
  'GET /v1/ready': { kind: 'public', reason: 'readiness; no tenant data' },
  'POST /v1/auth/register': { kind: 'public', reason: 'pre-authentication' },
  'POST /v1/auth/verify-email': { kind: 'public', reason: 'pre-authentication; single-use token' },
  'POST /v1/auth/login': { kind: 'public', reason: 'pre-authentication' },
  'POST /v1/webhooks/data-acquisition/:token': { kind: 'public', reason: 'unguessable connector token in the path + per-IP/connector rate limit; no session' },
  'POST /v1/auth/logout': { kind: 'session', reason: 'acts only on the caller\'s own session' },
  'GET /v1/auth/session': { kind: 'session', reason: 'returns only the caller\'s own session' },
  'POST /v1/onboarding': { kind: 'onboarding', reason: 'bootstrap: creates the caller\'s tenant; identity from session' },
  'POST /v1/onboarding/:onboardingId/business': { kind: 'onboarding', reason: 'bootstrap: tenantId/workspaceId are lookup keys, not authority - OnboardingService rechecks initiatedBy == session user and RLS confines the lookup' },
  'POST /v1/onboarding/:onboardingId/owner': { kind: 'onboarding', reason: 'bootstrap: same initiator recheck; this step creates the first membership, so none can exist yet' },
  'GET /v1/onboarding/active': { kind: 'onboarding', reason: 'bootstrap: returns only the session user\'s own onboarding' },
};
/** Swagger UI/spec are public (recorded as a deployment-hardening finding, not part of the authorization surface). */
const DOCS_PREFIX = '/documentation';

let app: FastifyInstance;
let routes: RouteInfo[] = [];

function describeRoutes(a: any): RouteInfo[] {
  const out: RouteInfo[] = [];
  const shape = (s: any): string[] => { try { const sh = s?._def?.shape?.() ?? s?.shape; return sh ? Object.keys(sh) : []; } catch { return []; } };
  for (const r of captured.routes) {
    for (const method of ([] as string[]).concat(r.method)) {
      if (method === 'HEAD' || method === 'OPTIONS') continue;
      const handlers = ([] as any[]).concat(r.onRequest ?? [], r.preHandler ?? []);
      const steps: Step[] = handlers.map((f) =>
        f === a.authenticate ? 'authenticate'
          : f === a.resolveTenantContext ? 'resolveTenantContext'
            : f?.__perms ? (`perm:${f.__perms.join('+')}` as Step)
              : f === a.requireIdempotencyKey ? 'idempotency'
                : 'other');
      const perms = handlers.flatMap((f) => f?.__perms ?? []);
      out.push({ key: `${method} ${r.url}`, method, url: r.url, steps, perms, bodyKeys: shape(r.schema?.body), paramKeys: shape(r.schema?.params) });
    }
  }
  return out;
}

beforeAll(async () => {
  const config = loadConfig({ DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://unused:unused@127.0.0.1:1/unused', NODE_ENV: 'test', LOG_LEVEL: 'silent' });
  app = await buildApp(config);
  await app.ready();
  routes = describeRoutes(app);
});
afterAll(async () => { await app?.close(); });

const indexOfStep = (r: RouteInfo, pred: (s: Step) => boolean) => r.steps.findIndex(pred);
const isTenantRoute = (r: RouteInfo) => !r.url.startsWith(DOCS_PREFIX) && !(r.key in BY_DESIGN);
const permsOf = (method: string, url: string) => routes.find((r) => r.key === `${method} ${url}`)?.perms.slice().sort();

describe('route-permission regression audit', () => {
  it('captures the real route table (the audit is not vacuous)', () => {
    expect(routes.length).toBeGreaterThan(80);
    expect(routes.filter(isTenantRoute).length).toBeGreaterThan(60);
  });

  it('every non-classified route runs authenticate -> resolveTenantContext -> an explicit permission, in that order', () => {
    const violations: string[] = [];
    for (const r of routes.filter(isTenantRoute)) {
      const a = indexOfStep(r, (s) => s === 'authenticate');
      const t = indexOfStep(r, (s) => s === 'resolveTenantContext');
      const p = indexOfStep(r, (s) => s.startsWith('perm:'));
      if (a < 0) violations.push(`${r.key}: no authenticate`);
      else if (t < 0) violations.push(`${r.key}: no resolveTenantContext`);
      else if (p < 0) violations.push(`${r.key}: NO EXPLICIT PERMISSION (authenticated != authorized)`);
      else if (!(a < t && t < p)) violations.push(`${r.key}: wrong order (${r.steps.join(' > ')})`);
    }
    expect(violations).toEqual([]);
  });

  it('every by-design classification still matches a real route and its declared kind', () => {
    for (const [key, meta] of Object.entries(BY_DESIGN)) {
      const r = routes.find((x) => x.key === key);
      expect(r, `${key} is classified but no longer exists - remove it`).toBeDefined();
      if (meta.kind === 'session' || meta.kind === 'onboarding') expect(r!.steps).toContain('authenticate');
      // A classified route must never silently gain tenant scope without a permission.
      if (r!.steps.includes('resolveTenantContext')) expect(r!.perms.length, `${key} resolves tenant scope but has no permission`).toBeGreaterThan(0);
    }
  });

  it('F1: GET /v1/businesses requires bo:read', () => {
    expect(permsOf('GET', '/v1/businesses')).toEqual(['bo:read']);
  });

  it('F2: the workflow view requires EVERY layer read permission (all-of, never a single permission)', () => {
    expect(permsOf('GET', '/v1/businesses/:businessId/workflow')).toEqual(['aba:read', 'adi:read', 'bi:read', 'bo:read', 'dt:read', 'om:read', 'sim:read']);
    const r = routes.find((x) => x.key === 'GET /v1/businesses/:businessId/workflow')!;
    expect(r.steps.filter((s) => s.startsWith('perm:'))).toHaveLength(1);
  });

  it('F3: the billing subscription read requires platform:admin', () => {
    expect(permsOf('GET', '/v1/billing/subscription')).toEqual(['platform:admin']);
  });

  it('pins the approval-authority surface: grant/read/revoke need aba:admin, decisions and choices need aba:write', () => {
    const base = '/v1/businesses/:businessId';
    expect(permsOf('POST', `${base}/approver-assignments`)).toEqual(['aba:admin']);
    expect(permsOf('GET', `${base}/approver-assignments/:assignmentCode`)).toEqual(['aba:admin']);
    expect(permsOf('POST', `${base}/approver-assignments/:assignmentCode/revoke`)).toEqual(['aba:admin']);
    expect(permsOf('POST', `${base}/decisions`)).toEqual(['aba:write']);
    expect(permsOf('POST', `${base}/decision-recommendations/:recommendationId/choice`)).toEqual(['aba:write']);
    expect(permsOf('POST', `${base}/outcomes`)).toEqual(['om:write']);
    expect(permsOf('POST', `${base}/decision-recommendations/outcome`)).toEqual(['om:write']);
  });

  it('no route authorizes by role name: only permission codes of the form layer:action are enforced', () => {
    for (const r of routes) for (const p of r.perms) expect(p).toMatch(/^[a-z]+:[a-z_]+$/);
  });

  it('no request body or path parameter carries an approver-authority or tenant-scope value except the reviewed bootstrap/grantee cases', () => {
    // Reviewed: onboarding steps 2/3 (tenantId/workspaceId lookup keys, initiator recheck); approver grant (approverUserId is the
    // GRANTEE under aba:admin); decisions (approverUserId must equal the authenticated user, else refused); incidents
    // (affectedTenantIds under platform:admin - platform-operator contract review pending); events/orders (customerId/memberId are data).
    const REVIEWED = new Set([
      'POST /v1/onboarding/:onboardingId/business', 'POST /v1/onboarding/:onboardingId/owner',
      'POST /v1/businesses/:businessId/approver-assignments', 'POST /v1/businesses/:businessId/decisions',
      'POST /v1/incidents',
    ]);
    const found = routes
      .filter((r) => [...r.bodyKeys, ...r.paramKeys].some((k) => /^(tenantId|workspaceId|userId|approverUserId|affectedTenantIds)$/.test(k)))
      .map((r) => r.key)
      .filter((k) => !REVIEWED.has(k));
    expect(found).toEqual([]);
  });

  it('no business-operations route accepts an ApprovedAction: BO cannot consume ABA output through the HTTP surface', () => {
    const BO_PREFIXES = ['/events', '/operations', '/products', '/register-sessions', '/orders'];
    const boRoutes = routes.filter((r) => BO_PREFIXES.some((p) => r.url.includes(`/v1/businesses/:businessId${p}`)));
    expect(boRoutes.length).toBeGreaterThan(15);
    for (const r of boRoutes) {
      expect([...r.bodyKeys, ...r.paramKeys].filter((k) => /approved.?action|authorized.?action|actionPackage/i.test(k)), r.key).toEqual([]);
    }
  });
});
