/**
 * STRIPE-SBX-01 (migration 0226): provider identity and the durable provider-event ledger. Provider-neutral: the provider is a parameter, and nothing here knows an
 * event name, a product or a price.
 *
 * Two kinds of method, deliberately separate:
 *  - TRUSTED LINK REGISTRATION (`registerCustomer`, `registerSubscriptionLink`): runs under an authenticated TENANT context (RLS pins tenant_id). This is the only way a
 *    provider customer comes to belong to a tenant. No route exposes it today; the eventual checkout flow calls it. Identity is never taken from an email, a name, webhook
 *    metadata or a client-supplied tenant id.
 *  - WEBHOOK-PATH CALLS (`claimEvent`, `finishEvent`, `resolveCustomer`, `checkSubscriptionLink`, `linkSubscription`): run before any tenant is known and go ONLY through
 *    the narrow SECURITY DEFINER functions of migration 0226. They return closed outcome strings or identifiers, never payload, SQL or constraint text.
 */
import { withTenantTransaction, withTransaction, type TenantContext } from '../../client.js';

export class ProviderLinkConflictError extends Error { constructor() { super('provider link conflict'); this.name = 'ProviderLinkConflictError'; } }
export class ProviderLinkNotFoundError extends Error { constructor() { super('provider customer not found'); this.name = 'ProviderLinkNotFoundError'; } }
export class ProviderInputError extends Error { constructor() { super('invalid provider identifier'); this.name = 'ProviderInputError'; } }

export type ClaimOutcome = 'CLAIMED' | 'DUPLICATE' | 'IN_PROGRESS' | 'CONFLICT';
export type LinkSubscriptionOutcome = 'LINKED' | 'ALREADY_LINKED' | 'MISMATCH' | 'CUSTOMER_UNKNOWN';
export type SubscriptionLinkCheck = 'UNLINKED' | 'MATCH' | 'MISMATCH';
export interface ResolvedCustomer { tenantId: string; workspaceId: string }

const PROVIDER = /^[a-z][a-z0-9_]{1,31}$/;
const PROVIDER_ID = /^[A-Za-z0-9_-]{1,255}$/;
const EVENT_TYPE = /^[a-z][a-z0-9_.]{0,127}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const RESULT_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const need = (ok: boolean): void => { if (!ok) throw new ProviderInputError(); };

export class ProviderBillingRepository {
  // ── trusted link registration (tenant context) ────────────────────────────────────────────────────────────────────────────────────────────────────
  /** Idempotent for the same tenant; a customer already owned by ANOTHER tenant is a (non-disclosing) conflict. */
  async registerCustomer(ctx: TenantContext, provider: string, providerCustomerId: string): Promise<{ created: boolean }> {
    need(PROVIDER.test(provider) && PROVIDER_ID.test(providerCustomerId));
    return withTenantTransaction(ctx, async (client) => {
      const inserted = await client.query(
        `INSERT INTO billing.provider_customers (provider, provider_customer_id, tenant_id) VALUES ($1,$2,$3) ON CONFLICT (provider, provider_customer_id) DO NOTHING RETURNING id`,
        [provider, providerCustomerId, ctx.tenantId]);
      if (inserted.rowCount === 1) return { created: true };
      // visible only if it is this tenant's own row (forced RLS); anything else is somebody else's identity
      const own = await client.query('SELECT 1 FROM billing.provider_customers WHERE provider = $1 AND provider_customer_id = $2 AND tenant_id = $3', [provider, providerCustomerId, ctx.tenantId]);
      if (own.rowCount === 1) return { created: false };
      throw new ProviderLinkConflictError();
    });
  }

  /** Links a provider subscription to one of THIS tenant's registered customers. Idempotent for the same customer; a different customer or tenant is a conflict. */
  async registerSubscriptionLink(ctx: TenantContext, provider: string, providerSubscriptionId: string, providerCustomerId: string, internalSubscriptionId: string | null = null): Promise<{ created: boolean }> {
    need(PROVIDER.test(provider) && PROVIDER_ID.test(providerSubscriptionId) && PROVIDER_ID.test(providerCustomerId) && (internalSubscriptionId === null || UUID.test(internalSubscriptionId)));
    return withTenantTransaction(ctx, async (client) => {
      const customer = await client.query<{ id: string }>('SELECT id FROM billing.provider_customers WHERE provider = $1 AND provider_customer_id = $2 AND tenant_id = $3', [provider, providerCustomerId, ctx.tenantId]);
      if (customer.rowCount !== 1) throw new ProviderLinkNotFoundError();
      const ref = customer.rows[0]!.id;
      const inserted = await client.query(
        `INSERT INTO billing.provider_subscription_links (provider, provider_subscription_id, provider_customer_ref, tenant_id, internal_subscription_id) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (provider, provider_subscription_id) DO NOTHING RETURNING id`, [provider, providerSubscriptionId, ref, ctx.tenantId, internalSubscriptionId]);
      if (inserted.rowCount === 1) return { created: true };
      const same = await client.query('SELECT 1 FROM billing.provider_subscription_links WHERE provider = $1 AND provider_subscription_id = $2 AND tenant_id = $3 AND provider_customer_ref = $4', [provider, providerSubscriptionId, ctx.tenantId, ref]);
      if (same.rowCount === 1) return { created: false };
      throw new ProviderLinkConflictError();
    });
  }

  // ── webhook path (no tenant yet; governed functions only) ─────────────────────────────────────────────────────────────────────────────────────────
  async claimEvent(provider: string, eventId: string, eventType: string, payloadHash: string): Promise<{ outcome: ClaimOutcome; attemptCount: number }> {
    need(PROVIDER.test(provider) && PROVIDER_ID.test(eventId) && EVENT_TYPE.test(eventType) && HEX64.test(payloadHash));
    return withTransaction(async (client) => {
      const r = await client.query<{ outcome: ClaimOutcome; attempt_count: number }>('SELECT outcome, attempt_count FROM billing.claim_provider_event($1,$2,$3,$4)', [provider, eventId, eventType, payloadHash]);
      return { outcome: r.rows[0]!.outcome, attemptCount: Number(r.rows[0]!.attempt_count) };
    });
  }

  /** Closes a claimed attempt as processed or failed with a FIXED result code. False = the event was not in the claimed state (nothing changed). */
  async finishEvent(provider: string, eventId: string, state: 'processed' | 'failed', resultCode: string, tenantId: string | null): Promise<boolean> {
    need(PROVIDER.test(provider) && PROVIDER_ID.test(eventId) && RESULT_CODE.test(resultCode) && (tenantId === null || UUID.test(tenantId)));
    return withTransaction(async (client) => {
      const r = await client.query<{ ok: boolean }>('SELECT billing.finish_provider_event($1,$2,$3,$4,$5) AS ok', [provider, eventId, state, resultCode, tenantId]);
      return r.rows[0]!.ok === true;
    });
  }

  async resolveCustomer(provider: string, providerCustomerId: string): Promise<ResolvedCustomer | null> {
    need(PROVIDER.test(provider) && PROVIDER_ID.test(providerCustomerId));
    return withTransaction(async (client) => {
      const r = await client.query<{ tenant_id: string; workspace_id: string }>('SELECT tenant_id, workspace_id FROM billing.resolve_provider_customer($1,$2)', [provider, providerCustomerId]);
      return r.rowCount === 1 ? { tenantId: r.rows[0]!.tenant_id, workspaceId: r.rows[0]!.workspace_id } : null;
    });
  }

  async checkSubscriptionLink(provider: string, providerSubscriptionId: string, providerCustomerId: string): Promise<SubscriptionLinkCheck> {
    need(PROVIDER.test(provider) && PROVIDER_ID.test(providerSubscriptionId) && PROVIDER_ID.test(providerCustomerId));
    return withTransaction(async (client) => {
      const r = await client.query<{ v: SubscriptionLinkCheck }>('SELECT billing.check_provider_subscription_link($1,$2,$3) AS v', [provider, providerSubscriptionId, providerCustomerId]);
      return r.rows[0]!.v;
    });
  }

  async linkSubscription(provider: string, providerSubscriptionId: string, providerCustomerId: string): Promise<LinkSubscriptionOutcome> {
    need(PROVIDER.test(provider) && PROVIDER_ID.test(providerSubscriptionId) && PROVIDER_ID.test(providerCustomerId));
    return withTransaction(async (client) => {
      const r = await client.query<{ v: LinkSubscriptionOutcome }>('SELECT billing.link_provider_subscription($1,$2,$3) AS v', [provider, providerSubscriptionId, providerCustomerId]);
      return r.rows[0]!.v;
    });
  }
}
