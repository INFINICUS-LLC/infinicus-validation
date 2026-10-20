/**
 * Register (till) open and close for the counter (POS-4). Every change goes through the /v1 register-sessions API; the session, its currency and the
 * order summary always come from the server. Same duplicate protection as the order session: one Idempotency-Key per action, a lost answer is retried
 * with the SAME key, and only one action runs at a time.
 */
import { ApiContractError, ApiError, ApiUnavailableError, type ApiClient, type Scope } from './apiClient';
import { describeRequestError } from './lifecycle';
import { openRegisterSchema, registerSessionSchema, registerSummarySchema, type RegisterSession, type RegisterSummary } from './schemas';

export interface RegisterState {
  /** False until the first load has answered. */
  loaded: boolean;
  /** The open session, or null when the register is closed. */
  session: RegisterSession | null;
  /** Orders taken in the open session (server counts). */
  summary: RegisterSummary | null;
  /** The session just closed, to show its reconciliation once. */
  justClosed: RegisterSession | null;
  busy: boolean;
  message: string | null;
  retryable: boolean;
}

export const OPEN_CONFLICT = 'The register could not be opened. A register may already be open, or the business has no declared currency yet. Reload to see its current state.';
export const CLOSE_CONFLICT = 'The register could not be closed. It may already be closed. Reload to see its current state.';
export const AMOUNT_REFUSED = 'That amount was not accepted. Check the digits and that it has no more decimal places than the currency allows.';

/** A cash amount typed by a person: digits with an optional decimal part (at most four digits: the currency decides the real limit on the server). */
export function parseCashAmount(text: string): number | null {
  const t = text.trim();
  const [whole, fraction, ...rest] = t.split('.');
  if (rest.length > 0 || !/^\d{1,12}$/.test(whole)) return null;
  if (fraction !== undefined && !/^\d{1,4}$/.test(fraction)) return null;
  return Number(t);
}

const path = (businessId: string): string => `/v1/businesses/${encodeURIComponent(businessId)}/register-sessions`;
const UNKNOWN_OUTCOME = (error: unknown): boolean => error instanceof ApiUnavailableError || error instanceof ApiContractError || (error instanceof ApiError && error.status >= 500);

interface Pending { key: string; run: (key: string) => Promise<void>; conflict: string }

export class RegisterController {
  private state: RegisterState = { loaded: false, session: null, summary: null, justClosed: null, busy: false, message: null, retryable: false };
  private pending: Pending | null = null;
  private summaryVersion = 0;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly api: ApiClient,
    private readonly scope: Scope,
    private readonly businessId: string,
    private readonly newKey: () => string = () => crypto.randomUUID(),
  ) {}

  getState = (): RegisterState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private set(patch: Partial<RegisterState>): void { this.state = { ...this.state, ...patch }; for (const l of this.listeners) l(); }

  /** Read the open session (if any) and its summary. Reads carry no key and change nothing. */
  load = async (): Promise<void> => {
    if (this.state.busy) return;
    ++this.summaryVersion;
    this.set({ busy: true, message: null });
    try {
      const open = await this.api.get(`${path(this.businessId)}/open`, { scope: this.scope, schema: openRegisterSchema });
      const summary = open.session
        ? await this.api.get(`${path(this.businessId)}/${encodeURIComponent(open.session.id)}/summary`, { scope: this.scope, schema: registerSummarySchema })
        : null;
      if (open.session && summary?.session.id !== open.session.id) throw new ApiContractError();
      this.set({ loaded: true, session: open.session, summary, busy: false });
    } catch (error) {
      this.set({ busy: false, message: describeRequestError(error) });
    }
  };

  private async execute(action: Pending): Promise<boolean> {
    this.set({ busy: true, message: null, retryable: false });
    try {
      await action.run(action.key);
      this.pending = null;
      this.set({ busy: false, retryable: false });
      return true;
    } catch (error) {
      const unknown = UNKNOWN_OUTCOME(error);
      this.pending = unknown ? action : null;
      const message = error instanceof ApiError && error.status === 409 ? action.conflict
        : error instanceof ApiError && error.status === 400 ? AMOUNT_REFUSED
        : describeRequestError(error);
      this.set({ busy: false, message, retryable: unknown });
      return false;
    }
  }

  private act(run: (key: string) => Promise<void>, conflict: string): Promise<boolean> {
    if (this.state.busy || this.pending) return Promise.resolve(false);
    return this.execute({ key: this.newKey(), run, conflict });
  }

  /** Open the register with a starting float. The currency is the business's declared one (the server decides). */
  open = (openingCash: number): Promise<boolean> => {
    if (this.state.session) return Promise.resolve(false);
    return this.act(async (key) => {
      ++this.summaryVersion;
      const session = await this.api.post(path(this.businessId), { body: { openingCash }, scope: this.scope, idempotencyKey: key, schema: registerSessionSchema });
      this.set({ session, summary: null, justClosed: null });
      await this.refreshSummary(session);
    }, OPEN_CONFLICT);
  };

  /** Close the open register with the counted cash; the server reconciles and the result is kept to show once. */
  close = (closingCash: number): Promise<boolean> => {
    const session = this.state.session;
    if (!session) return Promise.resolve(false);
    return this.act(async (key) => {
      ++this.summaryVersion;
      const closed = await this.api.post(`${path(this.businessId)}/${encodeURIComponent(session.id)}/close`, { body: { closingCash }, scope: this.scope, idempotencyKey: key, schema: registerSessionSchema });
      this.set({ session: null, summary: null, justClosed: closed });
    }, CLOSE_CONFLICT);
  };

  /** Re-read the summary of the open session (for example after an order was completed). Best effort: a failed read keeps what is shown. */
  refreshSummary = async (known?: RegisterSession): Promise<void> => {
    const session = known ?? this.state.session;
    if (!session || this.state.session?.id !== session.id || (this.state.busy && !known)) return;
    const version = ++this.summaryVersion;
    try {
      const summary = await this.api.get(`${path(this.businessId)}/${encodeURIComponent(session.id)}/summary`, { scope: this.scope, schema: registerSummarySchema });
      if (version === this.summaryVersion && this.state.session?.id === session.id && summary.session.id === session.id) this.set({ summary });
    } catch { /* keep the previous summary */ }
  };

  retry = async (): Promise<boolean> => {
    if (this.state.busy || !this.pending) return false;
    return this.execute(this.pending);
  };

  /** Give up on the unresolved action and reload the register state from the server. */
  discard = async (): Promise<void> => {
    if (this.state.busy || !this.pending) return;
    this.pending = null;
    this.set({ message: null, retryable: false });
    await this.load();
  };
}
