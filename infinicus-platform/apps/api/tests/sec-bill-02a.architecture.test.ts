/**
 * SEC-BILL-02A architecture guards (static): the two closed holes cannot silently reopen.
 *  SF-1  a public route starts a subscription only through the allowlisted self-service entry point.
 *  SF-2  no HTTP route can record a payment result; only the provider-neutral webhook service (behind signature verification) calls recordPaymentResult.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const root = resolve(__dirname, '..', '..', '..');
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8');
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'node_modules' || e.name === 'dist' ? [] : walk(join(dir, e.name))) : [join(dir, e.name)]));
const rel = (f: string) => f.slice(root.length + 1).replace(/\\/g, '/');
const sources = [...walk(resolve(root, 'apps')), ...walk(resolve(root, 'packages')), ...walk(resolve(root, 'layers'))].filter((f) => /[\\/]src[\\/].*\.(ts|tsx|js|mjs)$/.test(f));
const code = (f: string) => strip(readFileSync(f, 'utf8'));

describe('SEC-BILL-02A SF-1 - self-service plan start', () => {
  it('the self-service allowlist is exactly ["free"], frozen, and pure (no environment, configuration, database or request input)', () => {
    const src = strip(read('packages/billing/src/selfService.ts'));
    expect(src).toMatch(/SELF_SERVICE_PLAN_CODES: readonly string\[\] = Object\.freeze\(\['free'\]\)/);
    expect(src).not.toMatch(/process\.|import |require\(|\.env|config|query|from '@infinicus/);
  });
  it('no source outside EntitlementService itself calls startSubscription except the lazy free-plan provisioning; no API source calls it at all', () => {
    const callers = sources.filter((f) => /\.startSubscription\(/.test(code(f))).map(rel);
    expect(callers).toEqual(['packages/billing/src/EntitlementService.ts']);
    expect(callers.filter((f) => f.startsWith('apps/'))).toEqual([]);
  });
  it('the public trial route calls only startSelfServiceSubscription, with the request body untouched by any plan logic', () => {
    const route = code(resolve(root, 'apps/api/src/routes/billing.ts'));
    expect(route).toMatch(/entitlements\.startSelfServiceSubscription\(request\.ctx!, request\.body\.planCode\)/);
    expect(route).not.toMatch(/startSubscription|getByCode|PlanRepository|planId|toLowerCase|trim\(|normalize/);
  });
  it('the enforcement point checks the allowlist BEFORE touching a plan or a subscription', () => {
    const svc = strip(read('packages/billing/src/EntitlementService.ts'));
    const body = svc.slice(svc.indexOf('async startSelfServiceSubscription'), svc.indexOf('async startSubscription'));
    expect(body).toMatch(/if \(!isSelfServicePlanCode\(planCode\)\) throw new PlanNotSelfServiceError\(\)/);
    expect(body.indexOf('isSelfServicePlanCode')).toBeLessThan(body.indexOf('this.startSubscription'));
    expect(body).not.toMatch(/this\.plans|this\.subscriptions|toLowerCase|trim\(|normalize|\.code ===|price|trialDays/);
  });
  it('the refusal is a 403 by name, and the error text names no plan', () => {
    expect(strip(read('apps/api/src/errors.ts'))).toMatch(/PlanNotSelfServiceError: 403/);
    expect(strip(read('packages/billing/src/errors.ts'))).toMatch(/This plan cannot be started through self-service/);
  });
});

describe('SEC-BILL-02A SF-2 - payment-result authority', () => {
  it('no route or schema for a tenant-reported payment result exists anywhere in the API source', () => {
    const offenders = sources.filter((f) => f.includes(`${join('apps', 'api', 'src')}`) && /payment-result|recordPaymentBodySchema/.test(code(f))).map(rel);
    expect(offenders).toEqual([]);
  });
  it('recordPaymentResult is called only by the provider-neutral webhook service (never by an HTTP route or any API source)', () => {
    const callers = sources.filter((f) => /\.recordPaymentResult\(/.test(code(f))).map(rel);
    expect(callers).toEqual(['packages/billing/src/provider/ProviderBillingService.ts']);
  });
  it('the only entry to the provider-neutral service is the signature-verified webhook route', () => {
    const users = sources.filter((f) => /ProviderBillingService/.test(code(f)) && f.includes(join('apps', 'api', 'src'))).map(rel).sort();
    expect(users).toEqual(['apps/api/src/app.ts', 'apps/api/src/routes/stripeWebhook.ts']);
    const route = code(resolve(root, 'apps/api/src/routes/stripeWebhook.ts'));
    expect(route.indexOf('verifyStripeSignature(')).toBeGreaterThan(-1);
    expect(route.indexOf('verifyStripeSignature(')).toBeLessThan(route.indexOf('service.process('));
  });
  it('the subscription / suspension / cancellation operations remain service-level only: no HTTP route exposes suspend, reactivate or cancel', () => {
    const routeDir = resolve(root, 'apps/api/src/routes');
    const offenders = walk(routeDir).filter((f) => /\.(suspend|reactivate|cancel)\(/.test(code(f))).map(rel);
    expect(offenders).toEqual([]);
  });
  it('the contract and the production hotfix decision record are committed', () => {
    for (const f of ['docs/production-readiness/SEC-BILL-02A-SECURITY-CONTRACT.md', 'docs/production-readiness/SEC-BILL-02A-PRODUCTION-HOTFIX-DECISION-RECORD.md']) expect(existsSync(resolve(root, f)), f).toBe(true);
  });
});
