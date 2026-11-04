/**
 * POS2-01 architecture guard: every state-changing POS Core route is gated by the capability seam, in the same position as the subscription gate it
 * replaced, and the seam names capabilities, not providers or plans. Source-text guard, no database.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

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
