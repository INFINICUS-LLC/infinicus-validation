/** Read-only completed sales and receipt retrieval. Amounts, lines and payments always come from BO. */
import { ApiContractError, type ApiClient, type Scope } from './apiClient';
import { describeRequestError } from './lifecycle';
import type { Resource } from './resource';
import { orderListSchema, orderSchema, type Order } from './schemas';

export const SALES_PAGE_SIZE = 20;
export const salesHistoryPath = (businessId: string, before: string | null = null): string =>
  `/v1/businesses/${encodeURIComponent(businessId)}/orders?status=completed&limit=${SALES_PAGE_SIZE + 1}${before ? `&before=${encodeURIComponent(before)}` : ''}`;

export interface SalesHistoryState {
  orders: readonly Order[];
  busy: boolean;
  message: string | null;
  hasOlder: boolean;
  hasNewer: boolean;
  selectedId: string | null;
  receipt: Resource<Order> | null;
}

/** One instance per authenticated API, business and selected workspace; late answers cannot overwrite a newer selection. */
export class SalesHistoryController {
  private state: SalesHistoryState = { orders: [], busy: true, message: null, hasOlder: false, hasNewer: false, selectedId: null, receipt: null };
  private cursor: string | null = null;
  private previous: (string | null)[] = [];
  private listVersion = 0;
  private receiptVersion = 0;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly api: ApiClient, private readonly scope: Scope, private readonly businessId: string) {}
  getState = (): SalesHistoryState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private set(patch: Partial<SalesHistoryState>): void { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(); }

  private async load(cursor: string | null, previous: (string | null)[]): Promise<void> {
    const version = ++this.listVersion;
    ++this.receiptVersion;
    this.cursor = cursor;
    this.previous = previous;
    this.set({ orders: [], busy: true, message: null, hasOlder: false, hasNewer: previous.length > 0, selectedId: null, receipt: null });
    try {
      const data = await this.api.get(salesHistoryPath(this.businessId, cursor), { scope: this.scope, schema: orderListSchema });
      if (version !== this.listVersion) return;
      if (data.orders.some(order => order.businessId !== this.businessId || order.operationalStatus !== 'completed')) throw new ApiContractError();
      this.set({ orders: data.orders.slice(0, SALES_PAGE_SIZE), hasOlder: data.orders.length > SALES_PAGE_SIZE, busy: false });
    } catch (error) {
      if (version === this.listVersion) this.set({ busy: false, message: describeRequestError(error) });
    }
  }

  refresh = (): Promise<void> => this.load(this.cursor, this.previous);
  older = (): Promise<void> => {
    if (this.state.busy || !this.state.hasOlder) return Promise.resolve();
    return this.load(this.state.orders[this.state.orders.length - 1].id, [...this.previous, this.cursor]);
  };
  newer = (): Promise<void> => {
    if (this.state.busy || this.previous.length === 0) return Promise.resolve();
    return this.load(this.previous[this.previous.length - 1], this.previous.slice(0, -1));
  };
  closeReceipt = (): void => { ++this.receiptVersion; this.set({ selectedId: null, receipt: null }); };

  openReceipt = async (orderId: string): Promise<void> => {
    if (this.state.busy || !this.state.orders.some(order => order.id === orderId)) return;
    const version = ++this.receiptVersion;
    this.set({ selectedId: orderId, receipt: { kind: 'loading' } });
    try {
      // List rows deliberately omit lines/payments. Always read the full order before building or printing a receipt.
      const order = await this.api.get(`/v1/businesses/${encodeURIComponent(this.businessId)}/orders/${encodeURIComponent(orderId)}`, { scope: this.scope, schema: orderSchema });
      if (version !== this.receiptVersion) return;
      if (order.id !== orderId || order.businessId !== this.businessId || order.operationalStatus !== 'completed') throw new ApiContractError();
      this.set({ receipt: { kind: 'ok', data: order } });
    } catch (error) {
      if (version === this.receiptVersion) this.set({ receipt: { kind: 'error', message: describeRequestError(error) } });
    }
  };
}
