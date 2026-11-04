/**
 * POS2-01 architecture guard: every state-changing POS Core route is gated by the capability seam, in the same position as the subscription gate it
 * replaced, and the seam names capabilities, not providers or plans. Source-text guard, no database.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';

const routes = new URL('../src/routes/', import.meta.url);
const read = (f: string) => readFileSync(new URL(f, routes), 'utf8');
const POS_CORE_ROUTES = ['orders.ts', 'products.ts', 'registerSessions.ts', 'printers.ts', 'printJobs.ts', 'offlineSales.ts'];

describe('POS Core write routes use the capability gate (POS2-01)', () => {
  for (const f of POS_CORE_ROUTES) {
    it(`${f}: no direct subscription gate remains, every gate is requireCapability('pos.core') after the permission check and before business scope`, () => {
      const src = read(f);
      expect(src).not.toContain('requireActiveSubscription');
      const gates = src.match(/app\.requireCapability\('pos\.core'\)/g) ?? [];
      expect(gates.length).toBeGreaterThan(0);
      // After the permission check and before business scope, on every handler chain (the printers file shares one `admin` chain).
      expect(src).toMatch(/app\.requirePermission\('bo:(?:write|admin)'\),\s*app\.requireCapability\('pos\.core'\),\s*requireBusinessWorkspace/);
      expect(src).not.toMatch(/requireCapability\('pos\.core'\),\s*app\.requirePermission/);
    });
  }
  it('orders.ts gates all eight write handlers', () => {
    expect((read('orders.ts').match(/app\.requireCapability\('pos\.core'\)/g) ?? []).length).toBe(8);
  });
  it('no other route file was moved to the capability gate by accident (intelligence routes keep requireActiveSubscription)', () => {
    const others = readdirSync(routes).filter((f) => f.endsWith('.ts') && !POS_CORE_ROUTES.includes(f));
    for (const f of others) expect(read(f), f).not.toContain("requireCapability('pos.core')");
    expect(read('decisionRecommendations.ts')).toContain('requireActiveSubscription');
    expect(read('twin.ts')).toContain('requireActiveSubscription');
  });
  it('the billing plugin keeps requireActiveSubscription unchanged and adds requireCapability beside it, with no provider or plan name', () => {
    const plugin = readFileSync(new URL('../src/plugins/billing.ts', import.meta.url), 'utf8');
    expect(plugin).toContain("app.decorate('requireActiveSubscription'");
    expect(plugin).toContain("app.decorate('requireCapability'");
    expect(plugin.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/stripe/i);
  });
});

// ── POS2-02: the entitlement store ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
const platform = new URL('../../../', import.meta.url);
const text = (rel: string) => readFileSync(new URL(rel, platform), 'utf8');
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/--.*$/gm, '');
const walk = (dir: URL, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.next') continue;
    const u = new URL(name + (statSync(new URL(name, dir)).isDirectory() ? '/' : ''), dir);
    if (statSync(u).isDirectory()) walk(u, out); else if (name.endsWith('.ts')) out.push(u.pathname);
  }
  return out;
};

describe('entitlement store architecture (POS2-02)', () => {
  const migration = stripComments(text('infrastructure/database/migrations/0225_create_billing_entitlements.sql'));
  it('migration 0225 follows 0224 with no gap and is unique', () => {
    const files = readdirSync(new URL('infrastructure/database/migrations/', platform)).filter((f) => f.endsWith('.sql')).sort();
    expect(files.filter((f) => f.startsWith('0225_'))).toEqual(['0225_create_billing_entitlements.sql']);
    const numbers = files.map((f) => Number(f.slice(0, 4)));
    numbers.forEach((n, i) => { if (i > 0) expect(n, files[i]).toBe(numbers[i - 1] + 1); });
  });
  it('the store carries no provider, plan or price semantics', () => {
    expect(migration).not.toMatch(/stripe|price_|prod_|plan_id|plan_code|\bpro\b|\bgrowth\b|\bstarter\b|\bexplorer\b/i);
    for (const rel of ['packages/billing/src/capabilities.ts', 'packages/database/src/repositories/billing/EntitlementRepository.ts']) {
      expect(stripComments(text(rel)), rel).not.toMatch(/stripe|planCode|plan\.code|price/i);
    }
    const service = stripComments(text('packages/billing/src/EntitlementService.ts'));
    const resolve = service.slice(service.indexOf('async resolveProfile'), service.indexOf('async enforceCapability'));
    expect(resolve).not.toMatch(/plan|stripe/i);
  });
  it('fails closed: the table is tenant-scoped with forced RLS, the app role cannot write it, and rows are never deleted', () => {
    expect(migration).toMatch(/ENABLE ROW LEVEL SECURITY/); expect(migration).toMatch(/FORCE ROW LEVEL SECURITY/);
    expect(migration).toMatch(/BEFORE DELETE ON billing\.entitlements[\s\S]*billing\.forbid_mutation/);
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION billing\.grant_entitlement/);
    const grants = text('infrastructure/database/scripts/grant-app-role.sh');
    expect(grants).toMatch(/REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON billing\.entitlements/);
    expect(grants).toMatch(/REVOKE EXECUTE ON FUNCTION billing\.grant_entitlement/);
    expect(grants).toMatch(/REVOKE EXECUTE ON FUNCTION billing\.revoke_entitlement/);
  });
  it('no request-serving code can mint or revoke an entitlement', () => {
    const offenders: string[] = [];
    for (const dir of ['apps/api/src/', 'apps/web/app/', 'apps/web/lib/', 'packages/billing/src/']) {
      for (const file of walk(new URL(dir, platform))) {
        const src = readFileSync(file, 'utf8');
        if (/EntitlementRepository\.(grant|revoke)\b|grant_entitlement|revoke_entitlement/.test(src)) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
  it('POS Core routes ask only for the capability, never for a plan or provider', () => {
    for (const f of POS_CORE_ROUTES) expect(stripComments(read(f)), f).not.toMatch(/stripe|planCode|plan\.code|\bGrowth\b|\bPro\b/);
  });
});

