/**
 * POS2-03 architecture guard: the readiness report is a read-only, billing-independent GET that nothing else consults yet. Source-text guard, no database.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const platform = new URL('../../../', import.meta.url).pathname;
const text = (rel: string) => readFileSync(join(platform, rel), 'utf8');
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const route = code(text('apps/api/src/routes/posReadiness.ts'));
const service = code(text('packages/business-operations-runtime/src/pos-readiness/posReadiness.ts'));
function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (['node_modules', 'dist', '.next', '.turbo', 'tests'].includes(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full); else if (/\.(ts|tsx)$/.test(name)) yield full;
  }
}

describe('POS readiness route', () => {
  it('is one GET behind authenticate, tenant context, bo:read and business scope, in that order', () => {
    expect(route.match(/server\.(get|post|put|patch|delete)\(/g)).toEqual(['server.get(']);
    expect(route).toMatch(/preHandler: \[app\.authenticate, app\.resolveTenantContext, app\.requirePermission\('bo:read'\), requireBusinessWorkspace\]/);
  });
  it('is not gated by an entitlement or the subscription and takes no idempotency key (it is a read)', () => {
    expect(route).not.toMatch(/requireCapability|requireActiveSubscription|requireIdempotencyKey|enforceUsageLimit|EntitlementService|@infinicus\/billing/);
  });
  it('contains no SQL, pool, transaction or write; it takes the business id only from the validated path and the context from the authenticated request', () => {
    expect(route).not.toMatch(/\b(SELECT|INSERT|UPDATE|DELETE)\b|getPool|withTenantTransaction|\.query\(|request\.body|request\.headers|request\.query/);
    expect(route).toMatch(/readiness\.evaluate\(request\.ctx!, request\.params\.businessId\)/);
  });
});

describe('POS readiness service', () => {
  it('reads through ports only, with no billing, entitlement or provider reference and no write call', () => {
    expect(service).not.toMatch(/@infinicus\/billing|entitlement|subscription|stripe|capability/i);
    expect(service).not.toMatch(/\.(create|open|close|declare|grant|revoke|update|insert|delete)\(/);
    expect(service).not.toMatch(/Date\.now|new Date\(|Math\.random|randomUUID/);   // deterministic: no clock, no randomness
  });
  it('the contract vocabularies are closed in the response schema (a code outside the contract cannot be sent)', () => {
    const schema = code(text('apps/api/src/schemas/posReadiness.ts'));
    for (const word of ['CURRENCY_NOT_DECLARED', 'REGISTER_NOT_OPEN', 'REGISTER_CURRENCY_MISMATCH', 'DEPENDENCY_UNAVAILABLE', 'PREREQUISITE_NOT_MET']) expect(schema).toContain(word);
    expect(schema).toContain("z.literal('pos-readiness/1')");
  });
});

describe('no existing behaviour consults readiness yet (activation is a separate owner-approved step)', () => {
  it('only the route file and the service itself reference the readiness service', () => {
    const offenders: string[] = [];
    for (const root of ['apps/api/src', 'apps/web/app', 'apps/web/lib', 'packages/database/src', 'packages/billing/src', 'packages/business-operations-runtime/src']) {
      for (const file of walk(join(platform, root))) {
        const rel = relative(platform, file);
        if (rel === 'apps/api/src/routes/posReadiness.ts' || rel.startsWith('packages/business-operations-runtime/src/pos-readiness/') || rel === 'packages/business-operations-runtime/src/index.ts') continue;
        if (/posReadiness|pos-readiness/i.test(readFileSync(file, 'utf8'))) offenders.push(rel);
      }
    }
    expect(offenders).toEqual(['apps/api/src/app.ts', 'apps/api/src/schemas/posReadiness.ts']);
  });
  it('order creation, register sessions and tender code are unchanged by this block', () => {
    for (const rel of ['packages/database/src/repositories/bo/OrderRepository.ts', 'packages/database/src/repositories/bo/RegisterSessionRepository.ts', 'packages/database/src/repositories/bo/tender.ts']) {
      expect(text(rel), rel).not.toMatch(/readiness/i);
    }
  });
});
