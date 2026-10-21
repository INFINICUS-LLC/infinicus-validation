/**
 * The printer registry and print log screen's logic (POS-8f): read the business's printers (POS-8b) and its recent print attempts (POS-8c), and declare,
 * re-default or retire a printer. The server decides everything (permission `bo:admin` for changes, uniqueness, defaults); this only checks the form
 * before sending, shows the server's answer in plain words, and never stores anything in the browser. A printer's network, Bluetooth or USB address is NOT
 * part of the registry: it is set in the device app.
 */
import { z } from 'zod';
import { ApiError, ApiUnavailableError, type ApiClient, type Scope } from './apiClient';
import { describeRequestError } from './lifecycle';

export const PRINTER_NAME_MAX = 80;
export const PRINT_LOG_LIMIT = 50;
export type PrinterKind = 'receipt' | 'kitchen';
export type PrinterConnection = 'browser' | 'network' | 'bluetooth' | 'usb';
export const KIND_LABELS: Readonly<Record<PrinterKind, string>> = { receipt: 'Receipt', kitchen: 'Kitchen' };
export const CONNECTION_LABELS: Readonly<Record<PrinterConnection, string>> = { browser: 'Browser print', network: 'Network', bluetooth: 'Bluetooth', usb: 'USB' };

const kindSchema = z.enum(['receipt', 'kitchen']);
export const printerSchema = z.object({
  id: z.string().uuid(), name: z.string(), kind: kindSchema, connection: z.enum(['browser', 'network', 'bluetooth', 'usb']),
  paperMm: z.union([z.literal(58), z.literal(80)]), isDefault: z.boolean(), status: z.enum(['active', 'retired']), retiredAt: z.string().nullable(), createdAt: z.string(),
});
export const printerListSchema = z.object({ printers: z.array(printerSchema) });
export const printJobSchema = z.object({
  id: z.string().uuid(), orderId: z.string().uuid(), printerId: z.string().uuid().nullable(), kind: kindSchema, trigger: z.enum(['automatic', 'reprint', 'manual']),
  outcome: z.enum(['succeeded', 'failed']), failureCode: z.enum(['printer_error', 'timeout', 'unsupported', 'other']).nullable(), printedVia: z.enum(['browser', 'device']), createdAt: z.string(),
});
export const printJobListSchema = z.object({ printJobs: z.array(printJobSchema) });
export type Printer = z.infer<typeof printerSchema>;
export type PrintJob = z.infer<typeof printJobSchema>;

export const TRIGGER_LABELS = { automatic: 'Automatic', reprint: 'Reprint', manual: 'Sent by cashier' } as const;
export const FAILURE_LABELS = { printer_error: 'Printer error', timeout: 'No answer in time', unsupported: 'Not supported here', other: 'Other problem' } as const;

export interface PrinterDraft { name: string; kind: PrinterKind; connection: PrinterConnection; paperMm: 58 | 80; isDefault: boolean }
export const NEW_PRINTER: PrinterDraft = { name: '', kind: 'receipt', connection: 'network', paperMm: 80, isDefault: false };

export type PrinterCheck = { ok: true; body: { name: string; kind: PrinterKind; connection: PrinterConnection; paperMm: 58 | 80; isDefault?: true } } | { ok: false; reason: string };

/** The same checks the server makes, so a wrong form is refused before anything is sent. The name is trimmed. */
export function buildPrinter(draft: PrinterDraft): PrinterCheck {
  const name = draft.name.trim();
  if (name === '') return { ok: false, reason: 'Give the printer a name, for example "Front counter".' };
  if (name.length > PRINTER_NAME_MAX) return { ok: false, reason: `The name can be at most ${PRINTER_NAME_MAX} characters.` };
  return { ok: true, body: { name, kind: draft.kind, connection: draft.connection, paperMm: draft.paperMm, ...(draft.isDefault ? { isDefault: true as const } : {}) } };
}

export const PRINTERS_FORBIDDEN = 'Only an owner or admin can change printers.';
export const PRINTERS_NAME_TAKEN = 'A printer with this name already exists. Choose another name, or retire the old one first.';
export const PRINTERS_RETIRED = 'A retired printer cannot be the default.';
export const PRINTERS_UNAVAILABLE = 'Printers are not available on this server yet.';
export const PRINT_LOG_UNAVAILABLE = 'The print log could not be loaded.';

export interface PrintersState { printers: readonly Printer[]; jobs: readonly PrintJob[]; loaded: boolean; busy: boolean; message: string | null; notice: string | null }

/** One instance per authenticated API, business and selected workspace. Late answers cannot overwrite a newer load. */
export class PrintersController {
  private state: PrintersState = { printers: [], jobs: [], loaded: false, busy: true, message: null, notice: null };
  private version = 0;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly api: ApiClient, private readonly scope: Scope, private readonly businessId: string, private readonly newKey: () => string = () => crypto.randomUUID()) {}
  getState = (): PrintersState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private set(patch: Partial<PrintersState>): void { this.state = { ...this.state, ...patch }; for (const l of this.listeners) l(); }
  private base = (): string => `/v1/businesses/${encodeURIComponent(this.businessId)}`;

  /** Loads printers and the recent print log. The registry is required; the log is shown when it can be read. */
  refresh = async (): Promise<void> => {
    const version = ++this.version;
    this.set({ busy: true, message: null });
    const [printers, jobs] = await Promise.allSettled([
      this.api.get(`${this.base()}/printers`, { scope: this.scope, schema: printerListSchema }),
      this.api.get(`${this.base()}/print-jobs?limit=${PRINT_LOG_LIMIT}`, { scope: this.scope, schema: printJobListSchema }),
    ]);
    if (version !== this.version) return;
    if (printers.status === 'rejected') {
      const missing = printers.reason instanceof ApiError && printers.reason.status === 404;
      this.set({ busy: false, loaded: true, printers: [], jobs: [], message: missing ? PRINTERS_UNAVAILABLE : describeRequestError(printers.reason) });
      return;
    }
    this.set({ busy: false, loaded: true, printers: printers.value.printers, jobs: jobs.status === 'fulfilled' ? jobs.value.printJobs : [], message: jobs.status === 'fulfilled' ? null : PRINT_LOG_UNAVAILABLE });
  };

  private describeWrite(error: unknown): string {
    if (error instanceof ApiError) {
      if (error.status === 403) return PRINTERS_FORBIDDEN;
      if (error.status === 409) return error.message.includes('retired') ? PRINTERS_RETIRED : PRINTERS_NAME_TAKEN;
    }
    return describeRequestError(error);
  }

  private async write(run: (key: string) => Promise<unknown>, done: string): Promise<boolean> {
    if (this.state.busy) return false;
    this.set({ busy: true, message: null, notice: null });
    try {
      await run(this.newKey());
    } catch (error) {
      this.set({ busy: false, message: error instanceof ApiUnavailableError ? `${describeRequestError(error)} Nothing was confirmed; check the list before trying again.` : this.describeWrite(error) });
      return false;
    }
    await this.refresh();
    this.set({ notice: done });
    return true;
  }

  create = async (draft: PrinterDraft): Promise<boolean> => {
    const check = buildPrinter(draft);
    if (!check.ok) { this.set({ message: check.reason, notice: null }); return false; }
    return this.write((key) => this.api.post(`${this.base()}/printers`, { body: check.body, scope: this.scope, idempotencyKey: key, schema: printerSchema }), 'Printer added.');
  };
  makeDefault = (printerId: string): Promise<boolean> =>
    this.write((key) => this.api.post(`${this.base()}/printers/${encodeURIComponent(printerId)}/default`, { body: {}, scope: this.scope, idempotencyKey: key, schema: printerSchema }), 'Default printer changed.');
  retire = (printerId: string): Promise<boolean> =>
    this.write((key) => this.api.post(`${this.base()}/printers/${encodeURIComponent(printerId)}/retire`, { body: {}, scope: this.scope, idempotencyKey: key, schema: printerSchema }), 'Printer retired.');
}
