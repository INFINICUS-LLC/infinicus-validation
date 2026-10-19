import type { TenantContext } from '../../client.js';
import { withTenantTransaction } from '../../client.js';
import { NotFoundError, ConflictError } from './errors.js';
import { BusinessDeclaredCurrencyReader } from '../onboarding/index.js';
import { minorUnitsOf, roundToCurrency, UnsupportedCurrencyError } from '../../currency/minorUnits.js';

/** A refused amount (for example more decimals than the currency has). The API maps this name to 400. */
export class RegisterAmountError extends Error {
  constructor(reason: string) {
    super(`RegisterSession amount invalid: ${reason}`);
    this.name = 'ValidationError';
  }
}

export interface OpenRegisterSessionInput {
  businessId: string;
  openingCash: number;
  registerName?: string;
  openedBy?: string;
  notes?: string;
}

export interface CloseRegisterSessionInput {
  closingCash: number;
  closedBy?: string;
  notes?: string;
}

export interface RegisterSession {
  id: string;
  tenantId: string;
  workspaceId: string;
  businessId: string;
  registerName: string;
  /** The session's currency (set from the business's declared currency at open). null = opened before migration 0202. */
  currencyCode: string | null;
  status: 'open' | 'closed';
  openedBy: string | null;
  closedBy: string | null;
  openingCash: number;
  closingCash: number | null;
  expectedCash: number | null;
  variance: number | null;
  notes: string | null;
  openedAt: Date;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function round2(n: number): number {
  return Math.round((n || 0) * 100) / 100;
}

function rowToSession(row: Record<string, unknown>): RegisterSession {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    workspaceId: row.workspace_id as string,
    businessId: row.business_id as string,
    registerName: row.register_name as string,
    currencyCode: (row.currency_code as string | null) ?? null,
    status: row.status as 'open' | 'closed',
    openedBy: row.opened_by as string | null,
    closedBy: row.closed_by as string | null,
    openingCash: parseFloat(String(row.opening_cash)),
    closingCash: row.closing_cash === null ? null : parseFloat(String(row.closing_cash)),
    expectedCash: row.expected_cash === null ? null : parseFloat(String(row.expected_cash)),
    variance: row.variance === null ? null : parseFloat(String(row.variance)),
    notes: row.notes as string | null,
    openedAt: row.opened_at as Date,
    closedAt: row.closed_at as Date | null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

/**
 * Register/shift open-close and cash reconciliation — the first slice of
 * the POS/Commerce buildout (see the "Foodics-comparable" build spec):
 * before orders or payments can exist, a business needs a real register
 * session to operate against. expected_cash/variance are computed at
 * close time from business_events sale totals during the session window,
 * treating every sale as cash-equivalent — business_events has no
 * payment-method field yet, so a real cash/card split is a later
 * increment once orders/payments exist, not assumed here.
 */
/** Money in the session's currency; sessions without a recorded currency (pre-0202) keep the old two-decimal rounding. */
function roundCash(n: number, currencyCode: string | null): number {
  return currencyCode === null ? round2(n) : roundToCurrency(n, currencyCode);
}

export class RegisterSessionRepository {
  constructor(private readonly currencies: Pick<BusinessDeclaredCurrencyReader, 'getCurrent'> = new BusinessDeclaredCurrencyReader()) {}

  /**
   * Opening a register records the business's DECLARED currency on the session (Business Administration, migration 0185). An undeclared or
   * unsupported currency fails closed; the opening cash must be exact in that currency (no hidden rounding).
   */
  async open(ctx: TenantContext, input: OpenRegisterSessionInput): Promise<RegisterSession> {
    const state = await this.currencies.getCurrent(ctx, input.businessId);
    if (state.status !== 'DECLARED') {
      throw new ConflictError('RegisterSession', `business ${input.businessId} has no declared currency; declare one before opening a register`);
    }
    const currencyCode = state.current.currency;
    if (minorUnitsOf(currencyCode) === null) throw new UnsupportedCurrencyError(currencyCode);
    if (roundToCurrency(input.openingCash, currencyCode) !== input.openingCash) {
      throw new RegisterAmountError(`opening cash has more decimal places than ${currencyCode} allows (${minorUnitsOf(currencyCode)})`);
    }
    return withTenantTransaction(ctx, async (client) => {
      const existing = await client.query(
        `SELECT id FROM business_operations.register_sessions WHERE business_id = $1 AND status = 'open'`,
        [input.businessId]
      );
      if (existing.rows.length > 0) {
        throw new ConflictError('RegisterSession', `a register session is already open for business ${input.businessId}`);
      }
      const result = await client.query<Record<string, unknown>>(
        `INSERT INTO business_operations.register_sessions
           (tenant_id, workspace_id, business_id, register_name, opened_by, opening_cash, notes, currency_code)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING *`,
        [
          ctx.tenantId, ctx.workspaceId, input.businessId,
          input.registerName ?? 'Main Register', input.openedBy ?? null,
          input.openingCash, input.notes ?? null, currencyCode,
        ]
      );
      return rowToSession(result.rows[0]);
    });
  }

  async getOpen(ctx: TenantContext, businessId: string): Promise<RegisterSession | null> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `SELECT * FROM business_operations.register_sessions WHERE business_id = $1 AND status = 'open'`,
        [businessId]
      );
      return result.rows.length === 0 ? null : rowToSession(result.rows[0]);
    });
  }

  async close(ctx: TenantContext, sessionId: string, input: CloseRegisterSessionInput): Promise<RegisterSession> {
    return withTenantTransaction(ctx, async (client) => {
      const existing = await client.query<Record<string, unknown>>(
        `SELECT * FROM business_operations.register_sessions WHERE id = $1`,
        [sessionId]
      );
      if (existing.rows.length === 0) throw new NotFoundError('RegisterSession', sessionId);
      const session = rowToSession(existing.rows[0]);
      if (session.status === 'closed') {
        throw new ConflictError('RegisterSession', `session ${sessionId} is already closed`);
      }

      // Expected cash. A session with a recorded currency (opened after 0202) is reconciled from the TENDER taken in it: opening cash plus the cash
      // actually applied to orders (change already excluded); card and other payments are not cash. A session opened before 0202 has no tender
      // records, so it keeps the old arithmetic (every sale of the business since it opened, counted as cash).
      let salesTotal: number;
      if (session.currencyCode !== null) {
        const cash = await client.query<Record<string, unknown>>(
          `SELECT COALESCE(SUM(amount_applied), 0) AS total FROM business_operations.order_payments WHERE register_session_id = $1 AND method = 'cash'`,
          [sessionId]
        );
        salesTotal = Number(cash.rows[0]?.total ?? 0);
      } else {
        const salesDuring = await client.query<Record<string, unknown>>(
          `SELECT COALESCE(SUM(amount), 0) AS total
           FROM business_operations.business_events
           WHERE business_id = $1 AND event_type = 'sale' AND occurred_at >= $2`,
          [session.businessId, session.openedAt]
        );
        salesTotal = Number(salesDuring.rows[0]?.total ?? 0);
      }
      if (session.currencyCode !== null && roundToCurrency(input.closingCash, session.currencyCode) !== input.closingCash) {
        throw new RegisterAmountError(`closing cash has more decimal places than ${session.currencyCode} allows`);
      }
      salesTotal = roundCash(salesTotal, session.currencyCode);
      const expectedCash = roundCash(session.openingCash + salesTotal, session.currencyCode);
      const variance = roundCash(input.closingCash - expectedCash, session.currencyCode);

      const result = await client.query<Record<string, unknown>>(
        `UPDATE business_operations.register_sessions SET
           status        = 'closed',
           closing_cash  = $2,
           expected_cash = $3,
           variance      = $4,
           closed_by     = $5,
           notes         = COALESCE($6, notes),
           closed_at     = now()
         WHERE id = $1
         RETURNING *`,
        [sessionId, input.closingCash, expectedCash, variance, input.closedBy ?? null, input.notes ?? null]
      );
      return rowToSession(result.rows[0]);
    });
  }

  async list(ctx: TenantContext, businessId: string, limit = 20): Promise<RegisterSession[]> {
    return withTenantTransaction(ctx, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `SELECT * FROM business_operations.register_sessions
         WHERE business_id = $1
         ORDER BY opened_at DESC
         LIMIT $2`,
        [businessId, limit]
      );
      return result.rows.map(rowToSession);
    });
  }

  /**
   * Orders taken in a session (POS-4) and the tender taken against them (POS-5), in the session's currency.
   */
  async summary(ctx: TenantContext, businessId: string, sessionId: string): Promise<RegisterSessionSummary> {
    return withTenantTransaction(ctx, async (client) => {
      const found = await client.query<Record<string, unknown>>(`SELECT * FROM business_operations.register_sessions WHERE id = $1 AND business_id = $2`, [sessionId, businessId]);
      if (found.rows.length === 0) throw new NotFoundError('RegisterSession', sessionId);
      const session = rowToSession(found.rows[0]);
      const counts = await client.query<Record<string, unknown>>(
        `SELECT operational_status AS status, count(*)::int AS n, COALESCE(SUM(total_amount), 0) AS total
           FROM platform.orders WHERE register_session_id = $1 GROUP BY operational_status`,
        [sessionId]
      );
      const tender = await client.query<Record<string, unknown>>(
        `SELECT method, COALESCE(SUM(amount_applied), 0) AS applied FROM business_operations.order_payments WHERE register_session_id = $1 GROUP BY method`,
        [sessionId]
      );
      const applied = new Map(tender.rows.map((r) => [r.method as string, Number(r.applied)]));
      const tenders = {
        cash: roundCash(applied.get('cash') ?? 0, session.currencyCode),
        card: roundCash(applied.get('card') ?? 0, session.currencyCode),
        other: roundCash(applied.get('other') ?? 0, session.currencyCode),
      };
      const byStatus = new Map(counts.rows.map((r) => [r.status as string, { n: Number(r.n), total: Number(r.total) }]));
      const n = (status: string): number => byStatus.get(status)?.n ?? 0;
      return {
        session,
        ordersPlanned: n('planned'),
        ordersCompleted: n('completed'),
        ordersVoided: n('failed'),
        completedSalesTotal: roundCash(byStatus.get('completed')?.total ?? 0, session.currencyCode),
        tenders,
        expectedCash: roundCash(session.openingCash + tenders.cash, session.currencyCode),
      };
    });
  }
}

export interface RegisterSessionSummary {
  session: RegisterSession;
  ordersPlanned: number;
  ordersCompleted: number;
  ordersVoided: number;
  /** Sum of completed orders linked to the session (all tender types together). */
  completedSalesTotal: number;
  /** Payments applied to orders in the session, by method (change already excluded). */
  tenders: { cash: number; card: number; other: number };
  /** Opening cash plus the cash applied so far: what the drawer should hold. */
  expectedCash: number;
}
