/**
 * POS readiness (POS2-03): is this business operationally configured to sell? It is NOT an entitlement and reads no billing state: entitlement answers
 * "may this tenant use POS", readiness answers "can this business sell safely". The two stay independent and either can be missing without the other.
 *
 * The evaluation is a pure function of facts (deterministic: fixed check order, no clock, no randomness) and the service only gathers those facts through
 * read-only ports. It writes nothing, activates nothing and changes no existing behaviour: the checks that are REQUIRED are exactly the prerequisites the
 * approved POS contracts already enforce when an order is created (a declared, supported currency, and an open register session in that currency). Other
 * candidates are ADVISORY (reported, never blocking) or NOT_APPLICABLE (the capability is not modelled yet); promoting any of them to REQUIRED is an owner
 * decision. A dependency that cannot be read yields UNVERIFIED, never a pass. Stable machine-readable codes are part of the contract (version below).
 */
import type { TenantContext } from '@infinicus/database';
import {
  BusinessDeclaredCurrencyReader, BusinessRepository, ProductRepository, RegisterSessionRepository, minorUnitsOf,
} from '@infinicus/database';

export const POS_READINESS_CONTRACT = 'pos-readiness/1' as const;

export type CheckId =
  | 'BUSINESS_ACTIVE' | 'CURRENCY_DECLARED' | 'CURRENCY_SUPPORTED' | 'CATALOG_HAS_ACTIVE_PRODUCT'
  | 'TAX_CONFIGURATION' | 'INVENTORY_CONFIGURATION' | 'BRANCH_CONFIGURATION'
  | 'REGISTER_OPEN' | 'REGISTER_CURRENCY_MATCHES';
export type CheckStatus = 'PASS' | 'FAIL' | 'UNVERIFIED' | 'SKIPPED' | 'NOT_APPLICABLE';
export type Verdict = 'READY' | 'NOT_READY' | 'UNVERIFIED';
export type ReasonCode =
  | 'BUSINESS_NOT_ACTIVE' | 'CURRENCY_NOT_DECLARED' | 'CURRENCY_NOT_SUPPORTED' | 'NO_ACTIVE_PRODUCTS'
  | 'TAX_NOT_MODELLED' | 'INVENTORY_NOT_LINKED_TO_SALES' | 'BRANCH_NOT_MODELLED'
  | 'REGISTER_NOT_OPEN' | 'REGISTER_CURRENCY_MISMATCH'
  | 'DEPENDENCY_UNAVAILABLE' | 'PREREQUISITE_NOT_MET';

export interface ReadinessCheck {
  id: CheckId;
  scope: 'CONFIGURATION' | 'SESSION';
  requirement: 'REQUIRED' | 'ADVISORY';
  status: CheckStatus;
  reasonCode: ReasonCode | null;
}

export interface PosReadiness {
  contract: typeof POS_READINESS_CONTRACT;
  businessId: string;
  /** Can the business sell at all (REQUIRED configuration checks). */
  configuration: Verdict;
  /** Can it take an order right now (configuration plus the open register session). */
  session: Verdict;
  checks: ReadinessCheck[];
  /** Reason codes of REQUIRED checks that are not passing, in check order. Empty when both verdicts are READY. */
  blockingReasons: ReasonCode[];
}

/** A fact, or the marker that it could not be read. */
export type Fact<T> = { kind: 'known'; value: T } | { kind: 'unavailable' };

export interface PosReadinessFacts {
  businessId: string;
  businessStatus: Fact<string>;
  declaredCurrency: Fact<string | null>;                       // null = the business has not declared one
  openRegister: Fact<{ currencyCode: string | null } | null>;  // null = no register session is open
  activeProductCount: Fact<number>;
}

const known = <T>(f: Fact<T>): f is { kind: 'known'; value: T } => f.kind === 'known';

/** CONFIGURATION: the REQUIRED configuration checks. SESSION: every REQUIRED check (configuration and session). A FAIL or SKIPPED wins over UNVERIFIED. */
function verdict(checks: ReadinessCheck[], scope: 'CONFIGURATION' | 'SESSION'): Verdict {
  const required = checks.filter((c) => c.requirement === 'REQUIRED' && (scope === 'SESSION' || c.scope === 'CONFIGURATION'));
  if (required.some((c) => c.status === 'FAIL' || c.status === 'SKIPPED')) return 'NOT_READY';
  if (required.some((c) => c.status === 'UNVERIFIED')) return 'UNVERIFIED';
  return 'READY';
}

/** Pure and deterministic: the same facts always give the same result. */
export function evaluatePosReadiness(facts: PosReadinessFacts): PosReadiness {
  const c = (id: CheckId, scope: ReadinessCheck['scope'], requirement: ReadinessCheck['requirement'], status: CheckStatus, reasonCode: ReasonCode | null): ReadinessCheck =>
    ({ id, scope, requirement, status, reasonCode });
  const unavailable = (id: CheckId, scope: ReadinessCheck['scope'], requirement: ReadinessCheck['requirement']) => c(id, scope, requirement, 'UNVERIFIED', 'DEPENDENCY_UNAVAILABLE');

  const checks: ReadinessCheck[] = [];
  checks.push(!known(facts.businessStatus) ? unavailable('BUSINESS_ACTIVE', 'CONFIGURATION', 'ADVISORY')
    : facts.businessStatus.value === 'active' ? c('BUSINESS_ACTIVE', 'CONFIGURATION', 'ADVISORY', 'PASS', null)
    : c('BUSINESS_ACTIVE', 'CONFIGURATION', 'ADVISORY', 'FAIL', 'BUSINESS_NOT_ACTIVE'));

  const declared = facts.declaredCurrency;
  checks.push(!known(declared) ? unavailable('CURRENCY_DECLARED', 'CONFIGURATION', 'REQUIRED')
    : declared.value === null ? c('CURRENCY_DECLARED', 'CONFIGURATION', 'REQUIRED', 'FAIL', 'CURRENCY_NOT_DECLARED')
    : c('CURRENCY_DECLARED', 'CONFIGURATION', 'REQUIRED', 'PASS', null));

  checks.push(!known(declared) ? unavailable('CURRENCY_SUPPORTED', 'CONFIGURATION', 'REQUIRED')
    : declared.value === null ? c('CURRENCY_SUPPORTED', 'CONFIGURATION', 'REQUIRED', 'SKIPPED', 'PREREQUISITE_NOT_MET')
    : minorUnitsOf(declared.value) === null ? c('CURRENCY_SUPPORTED', 'CONFIGURATION', 'REQUIRED', 'FAIL', 'CURRENCY_NOT_SUPPORTED')
    : c('CURRENCY_SUPPORTED', 'CONFIGURATION', 'REQUIRED', 'PASS', null));

  checks.push(!known(facts.activeProductCount) ? unavailable('CATALOG_HAS_ACTIVE_PRODUCT', 'CONFIGURATION', 'ADVISORY')
    : facts.activeProductCount.value > 0 ? c('CATALOG_HAS_ACTIVE_PRODUCT', 'CONFIGURATION', 'ADVISORY', 'PASS', null)
    : c('CATALOG_HAS_ACTIVE_PRODUCT', 'CONFIGURATION', 'ADVISORY', 'FAIL', 'NO_ACTIVE_PRODUCTS'));

  checks.push(c('TAX_CONFIGURATION', 'CONFIGURATION', 'ADVISORY', 'NOT_APPLICABLE', 'TAX_NOT_MODELLED'));
  checks.push(c('INVENTORY_CONFIGURATION', 'CONFIGURATION', 'ADVISORY', 'NOT_APPLICABLE', 'INVENTORY_NOT_LINKED_TO_SALES'));
  checks.push(c('BRANCH_CONFIGURATION', 'CONFIGURATION', 'ADVISORY', 'NOT_APPLICABLE', 'BRANCH_NOT_MODELLED'));

  const register = facts.openRegister;
  checks.push(!known(register) ? unavailable('REGISTER_OPEN', 'SESSION', 'REQUIRED')
    : register.value === null ? c('REGISTER_OPEN', 'SESSION', 'REQUIRED', 'FAIL', 'REGISTER_NOT_OPEN')
    : c('REGISTER_OPEN', 'SESSION', 'REQUIRED', 'PASS', null));

  // The same rule order creation applies: the open register's currency must equal the declared currency (a register opened before it was recorded does not).
  const notThere = (known(declared) && declared.value === null) || (known(register) && register.value === null);
  checks.push(notThere ? c('REGISTER_CURRENCY_MATCHES', 'SESSION', 'REQUIRED', 'SKIPPED', 'PREREQUISITE_NOT_MET')
    : !known(register) || !known(declared) ? unavailable('REGISTER_CURRENCY_MATCHES', 'SESSION', 'REQUIRED')
    : register.value!.currencyCode === declared.value ? c('REGISTER_CURRENCY_MATCHES', 'SESSION', 'REQUIRED', 'PASS', null)
    : c('REGISTER_CURRENCY_MATCHES', 'SESSION', 'REQUIRED', 'FAIL', 'REGISTER_CURRENCY_MISMATCH'));

  const configuration = verdict(checks, 'CONFIGURATION');
  // Taking an order needs every REQUIRED check, configuration and session alike, so a business that cannot sell is never READY for a session.
  const session = verdict(checks, 'SESSION');
  const blockingReasons = checks.filter((k) => k.requirement === 'REQUIRED' && k.status !== 'PASS' && k.status !== 'NOT_APPLICABLE').map((k) => k.reasonCode!);
  return { contract: POS_READINESS_CONTRACT, businessId: facts.businessId, configuration, session, checks, blockingReasons };
}

export interface PosReadinessPorts {
  business(ctx: TenantContext, businessId: string): Promise<{ status: string }>;
  declaredCurrency(ctx: TenantContext, businessId: string): Promise<string | null>;
  openRegister(ctx: TenantContext, businessId: string): Promise<{ currencyCode: string | null } | null>;
  activeProductCount(ctx: TenantContext, businessId: string): Promise<number>;
}

export function defaultPosReadinessPorts(): PosReadinessPorts {
  const businesses = new BusinessRepository(); const currencies = new BusinessDeclaredCurrencyReader();
  const registers = new RegisterSessionRepository(); const products = new ProductRepository();
  return {
    business: (ctx, id) => businesses.getForWorkspace(ctx, id),
    declaredCurrency: async (ctx, id) => { const s = await currencies.getCurrent(ctx, id); return s.status === 'DECLARED' ? s.current.currency : null; },
    openRegister: async (ctx, id) => { const s = await registers.getOpen(ctx, id); return s === null ? null : { currencyCode: s.currencyCode }; },
    activeProductCount: async (ctx, id) => (await products.list(ctx, id, true)).length,
  };
}

const isNotFound = (e: unknown): boolean => e instanceof Error && /NotFoundError$/.test(e.name);

/**
 * Gathers the facts through read-only ports and evaluates them. The business read doubles as the scope check: a business that is not visible in the
 * caller's tenant and workspace is a not-found error, not a readiness answer. Any other dependency that cannot be read becomes UNVERIFIED (the cause
 * is deliberately not reported to the caller).
 */
export class PosReadinessService {
  constructor(private readonly ports: PosReadinessPorts = defaultPosReadinessPorts()) {}

  async evaluate(ctx: TenantContext, businessId: string): Promise<PosReadiness> {
    const business = await this.ports.business(ctx, businessId).then((b) => ({ kind: 'known', value: b.status }) as Fact<string>, (e) => {
      if (isNotFound(e)) throw e;
      return { kind: 'unavailable' } as Fact<string>;
    });
    const read = <T>(p: Promise<T>): Promise<Fact<T>> => p.then((value) => ({ kind: 'known', value }) as Fact<T>, () => ({ kind: 'unavailable' }) as Fact<T>);
    const [declaredCurrency, openRegister, activeProductCount] = await Promise.all([
      read(this.ports.declaredCurrency(ctx, businessId)), read(this.ports.openRegister(ctx, businessId)), read(this.ports.activeProductCount(ctx, businessId)),
    ]);
    return evaluatePosReadiness({ businessId, businessStatus: business, declaredCurrency, openRegister, activeProductCount });
  }
}
