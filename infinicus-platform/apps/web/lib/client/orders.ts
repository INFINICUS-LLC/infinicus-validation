/**
 * Order building for the counter (POS-2): start an order, add a product as a line, remove a line, reopen a planned order. Every change goes through the
 * /v1 orders API; the order and its TOTAL always come from the server's answer, the counter never adds amounts itself.
 *
 * Duplicate protection: each user action gets one Idempotency-Key. If an action fails in a way where the server may or may not have applied it (no answer,
 * an unexpected answer, a 5xx), the SAME action with the SAME key is offered for retry, which the server replays instead of repeating. While such an action is
 * pending, no new action is accepted (retry it, or discard it and reload the order). A definite refusal (4xx) clears the action; the next one gets a new key.
 * Only one action runs at a time, so a double tap cannot send two.
 */
import { ApiContractError, ApiError, ApiUnavailableError, type ApiClient, type Scope } from './apiClient';
import { describeRequestError } from './lifecycle';
import { orderSchema, type Order, type Product } from './schemas';
import { DISCOUNT_REASON_MAX } from './discount';
import type { TenderPayment } from './tender';

export interface OrderSessionState {
  order: Order | null;
  busy: boolean;
  message: string | null;
  /** True when the last action may or may not have been applied and can be retried with the same key. */
  retryable: boolean;
}

interface Pending { key: string; run: (key: string) => Promise<Order>; /** Plain wording for a definite 409 refusal of this action. */ conflict?: string; /** Plain wording for a definite 400 refusal. */ invalid?: string; /** Plain wording for a 403 (not allowed to do this action). */ forbidden?: string }

/** The server's reason is never shown raw; a refusal of complete or void gets one plain sentence. */
export const COMPLETE_CONFLICT = 'This order could not be completed. It may have no items, or it was already completed or voided. Reload the order to see its current state.';
export const VOID_CONFLICT = 'This order could not be voided. It may already be completed or voided. Reload the order to see its current state.';
export const VOID_REASON_MAX = 500;
export const DISCOUNT_CONFLICT = 'The discount could not be added. The order may already be completed or voided, or removing a line would leave the discounts larger than the order. Reload the order to see its current state.';
export const DISCOUNT_REFUSED = 'The discount was not accepted. Check the amount: it must be more than zero, exact in the currency, no more than the order total, and at most five discounts per order.';
export const DISCOUNT_FORBIDDEN = 'Only an owner or admin can give discounts. Ask a manager to sign in and apply it.';
export const PAYMENT_REFUSED = 'The payment was not accepted. Check that the payments cover the total and that only cash includes change.';

const orderPath = (businessId: string): string => `/v1/businesses/${encodeURIComponent(businessId)}/orders`;
const IDEMPOTENT_UNKNOWN_OUTCOME = (error: unknown): boolean => error instanceof ApiUnavailableError || error instanceof ApiContractError || (error instanceof ApiError && error.status >= 500);

export class OrderSession {
  private state: OrderSessionState = { order: null, busy: false, message: null, retryable: false };
  private pending: Pending | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly api: ApiClient,
    private readonly scope: Scope,
    private readonly businessId: string,
    private readonly newKey: () => string = () => crypto.randomUUID(),
  ) {}

  getState = (): OrderSessionState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private set(patch: Partial<OrderSessionState>): void { this.state = { ...this.state, ...patch }; for (const l of this.listeners) l(); }

  /** Run one action: one key, one request. Ignored while another action runs or an unresolved one waits for a retry or discard. */
  private async act(run: (key: string) => Promise<Order>, conflict?: string, invalid?: string, forbidden?: string): Promise<boolean> {
    if (this.state.busy || this.pending) return false;
    return this.execute({ key: this.newKey(), run, conflict, invalid, forbidden });
  }

  private async execute(action: Pending): Promise<boolean> {
    this.set({ busy: true, message: null, retryable: false });
    try {
      const order = await action.run(action.key);
      this.pending = null;
      this.set({ order, busy: false, message: null, retryable: false });
      return true;
    } catch (error) {
      const unknown = IDEMPOTENT_UNKNOWN_OUTCOME(error);
      this.pending = unknown ? action : null;
      const refused = error instanceof ApiError && ((error.status === 409 && action.conflict) || (error.status === 400 && action.invalid) || (error.status === 403 && action.forbidden));
      const plain = error instanceof ApiError && error.status === 400 ? action.invalid : error instanceof ApiError && error.status === 403 ? action.forbidden : action.conflict;
      this.set({ busy: false, message: refused && plain ? plain : describeRequestError(error), retryable: unknown });
      return false;
    }
  }

  /** Start a new empty order. */
  start = (): Promise<boolean> =>
    this.act((key) => this.api.post(orderPath(this.businessId), { body: {}, scope: this.scope, idempotencyKey: key, schema: orderSchema }));

  /** Select a BO catalog product. BO resolves its current name and price, independently of the tile's cached display values. */
  add = (product: Product): Promise<boolean> => {
    const order = this.state.order;
    if (!order || order.operationalStatus !== 'planned') return Promise.resolve(false);
    const body = { catalogProductId: product.id, quantity: 1 };
    return this.act((key) => this.api.post(`${orderPath(this.businessId)}/${encodeURIComponent(order.id)}/line-items`, { body, scope: this.scope, idempotencyKey: key, schema: orderSchema }));
  };

  /** Remove one line from the open order. */
  remove = (lineItemId: string): Promise<boolean> => {
    const order = this.state.order;
    if (!order || order.operationalStatus !== 'planned') return Promise.resolve(false);
    return this.act((key) => this.api.delete(`${orderPath(this.businessId)}/${encodeURIComponent(order.id)}/line-items/${encodeURIComponent(lineItemId)}`, { scope: this.scope, idempotencyKey: key, schema: orderSchema }));
  };

  /** Set a line's quantity without removing/recreating it. Totals and captured pricing remain server-owned. */
  setQuantity = (lineItemId: string, quantity: number): Promise<boolean> => {
    const order = this.state.order;
    if (!order || order.operationalStatus !== 'planned' || !order.lineItems.some((line) => line.id === lineItemId)
      || !Number.isFinite(quantity) || quantity <= 0 || quantity > 1_000_000_000) return Promise.resolve(false);
    return this.act((key) => this.api.post(`${orderPath(this.businessId)}/${encodeURIComponent(order.id)}/line-items/${encodeURIComponent(lineItemId)}/quantity`,
      { body: { quantity }, scope: this.scope, idempotencyKey: key, schema: orderSchema }));
  };

  /** Complete with tender: BO records the sale/payments and locks the order. A nonempty zero-total order takes no payment. */
  complete = (payments: readonly TenderPayment[]): Promise<boolean> => {
    const order = this.state.order;
    if (!order || order.operationalStatus !== 'planned' || order.lineItems.length === 0 || (order.totalAmount === 0 ? payments.length !== 0 : payments.length === 0)) return Promise.resolve(false);
    const body = { payments: payments.map(payment => ({ ...payment })) };
    return this.act((key) => this.api.post(`${orderPath(this.businessId)}/${encodeURIComponent(order.id)}/complete`, { body, scope: this.scope, idempotencyKey: key, schema: orderSchema }), COMPLETE_CONFLICT, PAYMENT_REFUSED);
  };

  /** Void the open order, with an optional reason (kept by the server in the order's history). */
  voidOrder = (reason?: string): Promise<boolean> => {
    const order = this.state.order;
    if (!order || order.operationalStatus !== 'planned') return Promise.resolve(false);
    const trimmed = reason?.trim() ?? '';
    if (trimmed.length > VOID_REASON_MAX) {
      this.set({ message: `The reason is too long (at most ${VOID_REASON_MAX} characters).` });
      return Promise.resolve(false);
    }
    const body = trimmed ? { reason: trimmed } : {};
    return this.act((key) => this.api.post(`${orderPath(this.businessId)}/${encodeURIComponent(order.id)}/void`, { body, scope: this.scope, idempotencyKey: key, schema: orderSchema }), VOID_CONFLICT);
  };

  /** Take an amount off the open order (POS-6b; owners and admins only). The new total is the server's answer. */
  discount = (amount: number, reason?: string | null): Promise<boolean> => {
    const order = this.state.order;
    if (!order || order.operationalStatus !== 'planned') return Promise.resolve(false);
    const trimmed = reason?.trim() ?? '';
    if (trimmed.length > DISCOUNT_REASON_MAX) {
      this.set({ message: `The reason is too long (at most ${DISCOUNT_REASON_MAX} characters).` });
      return Promise.resolve(false);
    }
    const body = trimmed ? { amount, reason: trimmed } : { amount };
    return this.act((key) => this.api.post(`${orderPath(this.businessId)}/${encodeURIComponent(order.id)}/discounts`, { body, scope: this.scope, idempotencyKey: key, schema: orderSchema }), DISCOUNT_CONFLICT, DISCOUNT_REFUSED, DISCOUNT_FORBIDDEN);
  };

  /** Load an order by id (for example from the open-orders list). Reads carry no key and change nothing. */
  open = async (orderId: string): Promise<boolean> => {
    if (this.state.busy || this.pending) return false;
    this.set({ busy: true, message: null, retryable: false });
    try {
      const order = await this.api.get(`${orderPath(this.businessId)}/${encodeURIComponent(orderId)}`, { scope: this.scope, schema: orderSchema });
      this.set({ order, busy: false });
      return true;
    } catch (error) {
      this.set({ busy: false, message: describeRequestError(error) });
      return false;
    }
  };

  /** Retry the unresolved action with the SAME key: the server replays the original answer if it had already applied it. */
  retry = async (): Promise<boolean> => {
    if (this.state.busy || !this.pending) return false;
    return this.execute(this.pending);
  };

  /** Give up on the unresolved action and reload the order from the server so the screen shows what was really recorded. */
  discard = async (): Promise<void> => {
    if (this.state.busy || !this.pending) return;
    this.pending = null;
    const id = this.state.order?.id;
    this.set({ message: null, retryable: false });
    if (id) await this.open(id);
  };
}

/** Planned orders of the business, for the "resume an open order" list. */
export const OPEN_ORDERS_LIMIT = 20;
export const openOrdersPath = (businessId: string): string => `${orderPath(businessId)}?status=planned&limit=${OPEN_ORDERS_LIMIT}`;
