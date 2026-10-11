import { randomUUID } from 'node:crypto';
import {
  BusinessDeclaredCurrencyReader, BusinessDeclaredCurrencyRepository,
  DECLARED_CURRENCY_AUDIT_ENTITY, DECLARED_CURRENCY_AUDIT_DECLARED, DECLARED_CURRENCY_AUDIT_CHANGED,
  type DeclaredCurrencyRecord, type DeclaredCurrencyState, type DeclareCurrencyOutcome, type TenantContext,
} from '@infinicus/database';

/**
 * Business Administration: the governed, business-scoped DECLARED CURRENCY (migration 0185).
 *
 * Business Administration owns this fact (locked manifest: "Currency"). This service is the ONLY writer. Business Operations and ABA may read
 * it through BusinessDeclaredCurrencyReader and never write it; the Data Acquisition layer is not involved.
 *
 * Authority is the authenticated server-side context only: tenant, workspace and actor come from `ctx`, never from the request body; the
 * business id is a lookup key verified against that context (a foreign tenant, workspace or business is "not found"). The route enforces the
 * permission; `rc.permissionUsed` is recorded in the audit row, never trusted as authority.
 *
 * Semantics:
 *  - UNDECLARED is the absence of a declaration. Nothing here reads tenancy.tenants.default_currency, business_profile_extensions.default_currency
 *    or any other default, and no default is ever promoted into a declaration.
 *  - First declaration: expectedVersion must be null. Declaring the value already in force is an exact replay: it returns the current
 *    declaration, writes nothing and adds no audit row. A different value is a CHANGE: it requires expectedVersion equal to the current version
 *    (otherwise 409) and a reason; it appends version + 1 and keeps every earlier version.
 *  - The declaration and its audit row commit or roll back together (the repository writes both on one transaction client); a failing audit
 *    write undoes the declaration.
 *  - A change never rewrites an inventory cost currency, an evaluation row or any other history: this service touches no other table.
 */
export interface DeclaredCurrencyRequestContext {
  /** The permission the route enforced. Recorded in the audit row, never trusted as authority. */
  permissionUsed: string;
  /** The request correlation id (any string from the edge); normalised to a UUID for storage, the original kept in the audit metadata. */
  correlationId: string;
}

export interface DeclareCurrencyRequest {
  businessId: string;
  currency: string;
  expectedVersion: number | null;
  reason?: string;
}

export interface DeclareCurrencyResponse {
  outcome: DeclareCurrencyOutcome;
  declaration: DeclaredCurrencyRecord;
}

export interface BusinessDeclaredCurrencyDependencies {
  repository: BusinessDeclaredCurrencyRepository;
  reader: BusinessDeclaredCurrencyReader;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export { DECLARED_CURRENCY_AUDIT_ENTITY, DECLARED_CURRENCY_AUDIT_DECLARED, DECLARED_CURRENCY_AUDIT_CHANGED };

export class BusinessDeclaredCurrencyService {
  private readonly deps: BusinessDeclaredCurrencyDependencies;

  constructor(deps: Partial<BusinessDeclaredCurrencyDependencies> = {}) {
    this.deps = {
      repository: deps.repository ?? new BusinessDeclaredCurrencyRepository(),
      reader: deps.reader ?? new BusinessDeclaredCurrencyReader(),
    };
  }

  /** Declares (or explicitly changes) the business's currency. Idempotent; the repository writes the declaration and its audit row atomically. */
  async declare(ctx: TenantContext, rc: DeclaredCurrencyRequestContext, request: DeclareCurrencyRequest): Promise<DeclareCurrencyResponse> {
    const correlationId = UUID.test(rc.correlationId) ? rc.correlationId : randomUUID();
    const requestCorrelationId = String(rc.correlationId).slice(0, 200);
    const result = await this.deps.repository.declare(ctx, {
      businessId: request.businessId, currency: request.currency, expectedVersion: request.expectedVersion,
      ...(request.reason === undefined ? {} : { reason: request.reason }), permissionUsed: rc.permissionUsed, correlationId, requestCorrelationId,
    });
    return { outcome: result.outcome, declaration: result.record };
  }

  /** The current declaration, or UNDECLARED. Never a default. */
  async getCurrent(ctx: TenantContext, businessId: string): Promise<DeclaredCurrencyState> {
    return this.deps.reader.getCurrent(ctx, businessId);
  }

  async history(ctx: TenantContext, businessId: string): Promise<DeclaredCurrencyRecord[]> {
    return this.deps.reader.history(ctx, businessId);
  }
}
