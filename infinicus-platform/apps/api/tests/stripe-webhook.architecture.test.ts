/**
 * STRIPE-SBX-01 architecture and security guards (static): provider boundary, scoped raw body, the six approved events, no metadata trust, no secret logging,
 * no migration surprises, no route to the trusted link registration.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const root = resolve(__dirname, '..', '..', '..');
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8');
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'node_modules' || e.name === 'dist' ? [] : walk(join(dir, e.name))) : [join(dir, e.name)]));
const rel = (f: string) => f.slice(root.length + 1).replace(/\\/g, '/');
const sources = [...walk(resolve(root, 'packages')), ...walk(resolve(root, 'apps')), ...walk(resolve(root, 'layers'))].filter((f) => /[\\/]src[\\/].*\.(ts|tsx|js|mjs)$/.test(f));

const adapter = strip(read('apps/api/src/billing/stripe/StripeWebhookAdapter.ts'));
const verifier = strip(read('apps/api/src/billing/stripe/verifyStripeSignature.ts'));
const route = strip(read('apps/api/src/routes/stripeWebhook.ts'));
const service = strip(read('packages/billing/src/provider/ProviderBillingService.ts'));
const migration = readdirSync(resolve(root, 'infrastructure/database/migrations')).find((f) => f.startsWith('0226_'))!;
const sql = strip(read(`infrastructure/database/migrations/${migration}`).replace(/^--.*$/gm, ''));

describe('STRIPE-SBX-01 - the Stripe code is isolated from the billing core', () => {
  it('only the two adapter files import the stripe SDK; no other source in the repository does', () => {
    const importers = sources.filter((f) => /from 'stripe'|require\('stripe'\)/.test(strip(readFileSync(f, 'utf8')))).map(rel).sort();
    expect(importers).toEqual(['apps/api/src/billing/stripe/StripeWebhookAdapter.ts', 'apps/api/src/billing/stripe/verifyStripeSignature.ts']);
  });
  it('the billing package and the database package mention no Stripe event, product, price or secret and never depend on the SDK', () => {
    const files = sources.map(rel).filter((f) => f.startsWith('packages/billing/src/') || f.startsWith('packages/database/src/repositories/billing/'));
    expect(files.length).toBeGreaterThan(8);
    // case-insensitive "stripe" is allowed only in comments (stripped) - never in code
    const offenders = files.filter((f) => /stripe|whsec_|sk_test|sk_live|\bprice_[A-Za-z0-9]{14,}|\bprod_[A-Za-z0-9]{10,}|checkout\.session|customer\.subscription|invoice\.paid|invoice\.payment_failed/i.test(strip(read(f))));
    expect(offenders).toEqual([]);
    for (const pkg of ['packages/billing/package.json', 'packages/database/package.json', 'packages/configuration/package.json']) expect(read(pkg)).not.toMatch(/"stripe"/);
  });
  it('the SDK is a dependency of the API app only, pinned to an exact version', () => {
    expect(JSON.parse(read('apps/api/package.json')).dependencies.stripe).toMatch(/^\d+\.\d+\.\d+$/);
  });
  it('the provider service reaches the lifecycle only through EntitlementService (no direct repository transitions, no duplicated payment logic)', () => {
    expect(service).toMatch(/this\.entitlements\.recordPaymentResult\(/);
    expect(service).not.toMatch(/SubscriptionRepository|transitionStatus|\.recordPayment\(|UPDATE\s|INSERT\s|\.query\(|withTransaction|withTenantTransaction/i);
    expect(service).not.toMatch(/capabilit|entitlementProfile|plan/i); // billing state is not entitlement: no capability or plan decision here
  });
  it('the Stripe adapter, the route, the provider service and the provider repository never touch the entitlement store: no grant, revoke, snapshot or capability decision', () => {
    for (const [name, code] of [['adapter', adapter], ['verifier', verifier], ['route', route], ['service', service], ['repository', strip(read('packages/database/src/repositories/billing/ProviderBillingRepository.ts'))]] as const) {
      expect(code, name).not.toMatch(/billing\.entitlements|grant_entitlement|revoke_entitlement|EntitlementRepository|\bresolveProfile\b|\benforceCapability\b|\bwasEntitledAt\b|entitlementProfile|CAPABILITIES|isCapability/);
    }
  });
  it('EntitlementService, the capability profile and the subscription repository do not know any provider', () => {
    for (const f of ['packages/billing/src/EntitlementService.ts', 'packages/billing/src/capabilities.ts', 'packages/database/src/repositories/billing/SubscriptionRepository.ts']) expect(strip(read(f)), f).not.toMatch(/provider|stripe/i);
  });
  it('no route or handler exposes the trusted link registration (it is a server-side boundary, not an endpoint)', () => {
    const callers = sources.map(rel).filter((f) => /\bregisterCustomer\b|\bregisterSubscriptionLink\b/.test(strip(read(f)))).sort();
    expect(callers).toEqual(['packages/database/src/repositories/billing/ProviderBillingRepository.ts', 'packages/database/src/repositories/billing/index.ts'].filter((f) => callers.includes(f)));
    expect(callers.some((f) => f.startsWith('apps/api/src/'))).toBe(false);
  });
});

describe('STRIPE-SBX-01 - adapter trust rules', () => {
  it('handles exactly the six approved event types (no other provider event name appears in code)', () => {
    const names = [...adapter.matchAll(/'((?:checkout|customer|invoice|payment_intent|charge|payment_method|setup_intent|price|product|plan|coupon|payout|balance)\.[a-z_.]+)'/g)].map((m) => m[1]!);
    expect([...new Set(names)].sort()).toEqual(['checkout.session.completed', 'customer.subscription.created', 'customer.subscription.deleted', 'customer.subscription.updated', 'invoice.paid', 'invoice.payment_failed']);
  });
  it('never reads metadata, client_reference_id, e-mail, names, products, prices or plans from an event', () => {
    expect(adapter).not.toMatch(/\.metadata|client_reference_id|customer_email|customer_name|\.email|\.name\b|\.lines|\.items|\.price|\.plan|\.product|livemode/);
  });
  it('contains no lifecycle, entitlement or tenant logic', () => {
    expect(adapter).not.toMatch(/EntitlementService|recordPaymentResult|tenantId|workspaceId|withTenantTransaction|getPool|\.query\(|@infinicus\/database/);
  });
  it('logs and echoes nothing: no console, no logger, no secret in any response', () => {
    for (const code of [adapter, verifier, route, service]) expect(code).not.toMatch(/console\.|\blog\.|request\.log|reply\.log|logger|JSON\.stringify\(request\.body|raw\.toString|toString\('utf8'\)/);
    expect(route).not.toMatch(/webhookSecret[^;]*send|send\([^)]*secret/i);
  });
  it('the verifier returns closed codes only and never the underlying error text', () => {
    expect(verifier).not.toMatch(/error\.message|\.message|String\(error\)|JSON\.stringify\(error/);
    expect(verifier).toMatch(/Stripe\.webhooks\.constructEvent\(rawBody, signatureHeader, webhookSecret, STRIPE_SIGNATURE_TOLERANCE_SECONDS\)/);
  });
});

describe('STRIPE-SBX-01 - raw body is scoped to the webhook route only', () => {
  it('the only content-type parser registration in the API is inside the encapsulated webhook plugin, as a buffer', () => {
    const parserFiles = sources.map(rel).filter((f) => /addContentTypeParser|removeAllContentTypeParsers|removeContentTypeParser/.test(strip(read(f))));
    expect(parserFiles).toEqual(['apps/api/src/routes/stripeWebhook.ts']);
    expect(route).toMatch(/await app\.register\(async \(scope\) => \{\s*scope\.addContentTypeParser\('application\/json', \{ parseAs: 'buffer'/);
    expect(route).not.toMatch(/\bapp\.addContentTypeParser|fp\(|fastify-plugin/); // not fastify-plugin: it must stay encapsulated
    expect(strip(read('apps/api/src/app.ts'))).not.toMatch(/rawBody|addContentTypeParser|parseAs/);
  });
  it('the route is one unauthenticated POST /webhooks/stripe, authenticated by the signature, with a bounded body and fail-closed answers', () => {
    expect([...route.matchAll(/scope\.(get|post|put|patch|delete)\('([^']+)'/g)].map((m) => `${m[1]} ${m[2]}`)).toEqual(['post /webhooks/stripe']);
    expect(route).not.toMatch(/\bapp\.authenticate\b|\bresolveTenantContext\b|\brequirePermission\b|\brequireActiveSubscription\b|\brequireCapability\b|preHandler/);
    expect(route).toMatch(/bodyLimit: BODY_LIMIT_BYTES/);
    expect(route.indexOf('verifyStripeSignature(')).toBeGreaterThan(-1);
    expect(route.indexOf('verifyStripeSignature(')).toBeLessThan(route.indexOf('service.process('));
    expect(route).toMatch(/webhookSecret;\s*if \(signingKey === null\) return reject\(request, reply, 503/);
    expect(route).toMatch(/event\.livemode !== false\) return reject\(request, reply, 400, 'LIVE_MODE_REJECTED'/);
  });
});

describe('STRIPE-SBX-01 - configuration and secrets', () => {
  it('both variables are in the secret inventory, named (never valued) in .env.example, and live keys are refused', () => {
    const inventory = read('packages/configuration/src/secrets.ts');
    for (const name of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']) {
      expect(inventory).toMatch(new RegExp(`name: '${name}',\\s*classification: 'secret'`));
      expect(read('.env.example')).toMatch(new RegExp(`^${name}=$`, 'm'));
    }
    expect(read('.env.example')).not.toMatch(/(sk|rk)_(test|live)_[A-Za-z0-9]{8}|whsec_[A-Za-z0-9]{8}/);
    expect(strip(read('packages/configuration/src/index.ts'))).toMatch(/\^\(sk\|rk\)_test_/);
  });
  it('no committed file contains a Stripe-looking secret value', () => {
    const offenders = [...sources, ...walk(resolve(root, 'docs')).filter((f) => f.endsWith('.md'))].map(rel).filter((f) => /\b(sk|rk)_(live)_[A-Za-z0-9]{8,}|\b(sk|rk)_test_[A-Za-z0-9]{16,}/.test(read(f)));
    expect(offenders).toEqual([]);
  });
});

describe('STRIPE-SBX-01 - migration 0226 shape', () => {
  it('is the only new migration, exactly named', () => {
    const all = readdirSync(resolve(root, 'infrastructure/database/migrations')).filter((f) => /\.sql$/.test(f)).sort();
    expect(all.slice(all.indexOf('0226_billing_provider_links_and_events.sql'))).toEqual(['0226_billing_provider_links_and_events.sql', '0227_harden_billing_emit_functions.sql']); // 0227 is SEC-BILL-02B-1's (legacy emit_* hardening), later than this block's
    expect(all.filter((f) => /^0(22[5-9]|2[3-9]\d)_/.test(f))).toEqual(['0225_create_billing_entitlements.sql', '0226_billing_provider_links_and_events.sql', '0227_harden_billing_emit_functions.sql']); // 0225 is POS2-02's entitlement store, 0227 is SEC-BILL-02B-1's; this block's only migration is 0226
    expect(all.filter((f) => f.startsWith('0226_'))).toHaveLength(1); // the number is unique
  });
  it('is additive: no drop, no seed, no GRANT, no plan or entitlement change; the one change to an existing table is a composite unique key', () => {
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN|SCHEMA|CONSTRAINT|TRIGGER|POLICY|INDEX)\b|\bTRUNCATE\s+billing|\bDELETE\s+FROM|\bGRANT\b|billing\.plans|INSERT INTO billing\.(?!provider_)/i);
    expect([...sql.matchAll(/ALTER TABLE ([a-z_.]+) /gi)].map((m) => m[1]).filter((t) => !/provider_(customers|subscription_links|events)$/.test(t!))).toEqual(['billing.subscriptions']);
    expect(sql).toMatch(/ALTER TABLE billing\.subscriptions ADD CONSTRAINT subscriptions_id_tenant_key UNIQUE \(id, tenant_id\)/);
  });
  it('permits many provider subscriptions per tenant: no uniqueness on tenant_id alone in the provider tables', () => {
    expect(sql).not.toMatch(/tenant_id\s+uuid[^,]*UNIQUE|UNIQUE\s*\(\s*tenant_id\s*\)|UNIQUE\s*\(\s*tenant_id\s*,\s*provider\s*\)/i);
    expect(sql).toMatch(/provider_subscription_links_identity_key UNIQUE \(provider, provider_subscription_id\)/);
    expect(sql).toMatch(/provider_customers_identity_key UNIQUE \(provider, provider_customer_id\)/);
    expect(sql).toMatch(/provider_events_identity_key UNIQUE \(provider, event_id\)/);
  });
  it('every table has ENABLE and FORCE row-level security; the identity tables are append-only; the ledger has a governed-writer guard', () => {
    for (const t of ['provider_customers', 'provider_subscription_links', 'provider_events']) {
      expect(sql).toMatch(new RegExp(`ALTER TABLE billing\\.${t}\\s+ENABLE ROW LEVEL SECURITY`));
      expect(sql).toMatch(new RegExp(`ALTER TABLE billing\\.${t}\\s+FORCE\\s+ROW LEVEL SECURITY`));
      expect(sql).toMatch(new RegExp(`CREATE TRIGGER forbid_truncate_${t}`));
    }
    expect(sql).toMatch(/CREATE TRIGGER forbid_mutation_provider_customers/); expect(sql).toMatch(/CREATE TRIGGER forbid_mutation_provider_subscription_links/);
    expect(sql).toMatch(/CREATE TRIGGER guard_provider_events BEFORE INSERT OR UPDATE OR DELETE/);
  });
  it('every function is SECURITY DEFINER with a pinned search_path (except the invoker-rights guard, which pins it too) and has PUBLIC execution revoked', () => {
    const fns = [...sql.matchAll(/CREATE OR REPLACE FUNCTION (billing\.[a-z_]+)\(/g)].map((m) => m[1]!);
    expect(fns.sort()).toEqual(['billing.check_provider_subscription_link', 'billing.claim_provider_event', 'billing.finish_provider_event', 'billing.guard_provider_events', 'billing.link_provider_subscription', 'billing.resolve_provider_customer']);
    expect(sql.match(/SET search_path = pg_catalog, pg_temp/g)).toHaveLength(6);
    expect(sql.match(/SECURITY DEFINER/g)).toHaveLength(5);
    for (const f of fns) expect(sql, f).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${f.replace('.', '\\.')}\\(`));
  });
  it('tenant erasure recognises the ledger guard as an append-only guard (retained and reported, never a blocked DELETE)', () => {
    expect(read('infrastructure/database/scripts/delete-tenant-data.mjs')).toMatch(/'forbid_governed_source_mutation', 'guard_provider_events'\)/);
  });
  it('the grant script withholds direct ledger writes from the application role', () => {
    expect(read('infrastructure/database/scripts/grant-app-role.sh')).toMatch(/REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON billing\.provider_events FROM %I/);
  });
});
