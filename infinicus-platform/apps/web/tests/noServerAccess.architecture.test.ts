/**
 * NA-05 guard (replaces the J-2 "no browser identity" guard of the old server-rendered pages): apps/web is a client of the /v1 API (owner decision
 * NEW-ARCH-R0, Option B). It has NO server-side data access of its own, so the second identity path that J-2 had to police cannot come back:
 * no database, no platform packages, no cookie contract, no 'use server' actions, no identity or scope read from the URL or a form.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
});
const files = [...walk(join(ROOT, 'app')), ...walk(join(ROOT, 'lib'))];
const read = (f: string) => readFileSync(f, 'utf8');
const rel = (f: string) => f.replace(ROOT, '');
const code = (f: string) => read(f).split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

describe('apps/web has no server-side data access or identity path (NA-05)', () => {
  it('has source files to check', () => expect(files.length).toBeGreaterThan(20));

  it('imports no platform package, database driver or server-only Next API, and declares none as a dependency', () => {
    expect(files.filter((f) => /from ['"](@infinicus\/|pg['"]|pg\/|next\/headers|server-only)/.test(code(f))).map(rel)).toEqual([]);
    const pkg = JSON.parse(read(join(ROOT, 'package.json'))) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const declared = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(declared.filter((d) => d.startsWith('@infinicus/') || d === 'pg' || d === '@types/pg')).toEqual([]);
    expect(read(join(ROOT, 'next.config.mjs'))).not.toMatch(/transpilePackages/);
  });

  it('has no server actions and no cookie or session-cookie contract', () => {
    expect(files.filter((f) => /['"]use server['"]/.test(code(f))).map(rel)).toEqual([]);
    expect(files.filter((f) => /inf_session|inf_workspace|cookies\(|document\.cookie/.test(code(f))).map(rel)).toEqual([]);
  });

  it('makes network calls only in the API client and the session manager', () => {
    expect(files.filter((f) => /\bfetch\(|\bdoFetch\(/.test(code(f))).map(rel).sort()).toEqual(['/lib/client/apiClient.ts', '/lib/client/backendSession.ts']);
  });

  it('takes no identity or scope from the URL or a form: no searchParams, no tenant/workspace/user inputs; the business id is read only from the address PATH and validated (POS-8d-2a)', () => {
    expect(files.filter((f) => /searchParams|useSearchParams|location\.(search|hash)/.test(code(f))).map(rel)).toEqual([]);
    expect(files.filter((f) => /name=["'](userId|tenantId|workspaceId)["']|id=["'](userId|tenantId|workspaceId)["']/.test(code(f))).map(rel)).toEqual([]);
    // The framework's route parameter is NOT used by any screen: in a static export (the counter bundled in the device shell) it is the build-time
    // placeholder, never the real business. The id comes from the address through one shared, validating reader.
    expect(files.filter((f) => /useParams|usePathname/.test(code(f))).map(rel)).toEqual([]);
    const readers = files.filter((f) => /useBusinessId\(/.test(code(f)) && !f.endsWith('use-business-id.ts'));
    expect(readers.map(rel).sort()).toEqual(['/app/(client)/businesses/[businessId]/counter/page.tsx', '/app/(client)/businesses/[businessId]/finance/page.tsx', '/app/(client)/businesses/[businessId]/history/page.tsx', '/app/(client)/businesses/[businessId]/inventory/page.tsx', '/app/(client)/businesses/[businessId]/printers/page.tsx', '/app/(client)/businesses/[businessId]/purchasing/page.tsx', '/app/(client)/businesses/[businessId]/reports/page.tsx', '/app/(client)/businesses/[businessId]/sales/page.tsx', '/app/(client)/businesses/[businessId]/staff/page.tsx', '/app/(client)/businesses/[businessId]/workflow/page.tsx']);
    const reader = code(join(ROOT, 'lib/client/locationPath.ts'));
    expect(reader).toContain('window.location.pathname');                                    // the path only (search/hash are refused above)
    expect(reader).toContain('businessIdFromPath');
    const validator = code(join(ROOT, 'lib/client/businessTabs.ts'));
    expect(validator).toMatch(/\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}/);   // a well-formed id or nothing
    expect(validator).toMatch(/UUID\.test\(m\[1\]\) \? m\[1\] : null/);
    for (const f of readers) expect(code(f), rel(f)).toContain('const businessId = useBusinessId();');     // used as a lookup key, never as authority
  });

  it('every tenant page uses a scoped API reader and the workspace guard', () => {
    const pages = files.filter((f) => /app\/\(client\)\/businesses\/.*page\.tsx$/.test(f));
    expect(pages).toHaveLength(11);   // workflow, history, businesses list, counter, completed sales, printers, the BI sales report, inventory, finance, purchasing and staff
    for (const f of pages) {
      if (rel(f) === '/app/(client)/businesses/[businessId]/sales/page.tsx') {
        // History has a scoped controller for cursor/selection races; business identity is read by BusinessReceipt.
        expect(code(f), rel(f)).toContain('new SalesHistoryController(api, scope, businessId)');
        expect(code(f), rel(f)).toContain('BusinessReceipt');
        const controller = code(join(ROOT, 'lib/client/salesHistory.ts'));
        expect(controller).toContain('this.api.get(');
        expect(controller).toContain('scope: this.scope');
      } else if (rel(f) === '/app/(client)/businesses/[businessId]/printers/page.tsx') {
        // Printers has a scoped controller (like completed sales): every request carries the controller's own scope.
        expect(code(f), rel(f)).toContain('new PrintersController(api, scope, businessId)');
        const controller = code(join(ROOT, 'lib/client/printers.ts'));
        expect(controller).toContain('this.api.get(');
        expect(controller).toContain('this.api.post(');
        expect(controller).toContain('scope: this.scope');
        expect(controller).toContain('idempotencyKey: key');
      } else {
        expect(code(f), rel(f)).toContain('useScopedResource');
      }
      expect(code(f), rel(f)).toContain('useRequireWorkspace');
    }
  });

  it('no component builds the workspace claim itself: scope comes from the controller state', () => {
    expect(files.filter((f) => !f.includes('/lib/client/') && /tenantId\s*:\s*\S+\s*,\s*workspaceId\s*:/.test(code(f)) && !/use-scoped-resource/.test(f)).map(rel)).toEqual([]);
  });
});
