import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import { ApiError, type ApiClient, type RequestInitLite, type Scope } from '../lib/client/apiClient';
import { buildNote, notePreview, NOTE_MAX } from '../lib/client/note';
import { NOTE_CONFLICT, NOTE_REFUSED, OrderSession } from '../lib/client/orders';
import { buildReceipt } from '../lib/client/receipt';
import { orderSchema, type Order } from '../lib/client/schemas';
import { OrderPanelView, type OrderPanelProps } from '../app/(client)/businesses/[businessId]/counter/order-panel';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scope: Scope = { tenantId: uuid(1), workspaceId: uuid(2) };

const order = (over: Partial<Order> = {}): Order => ({
  id: uuid(10), businessId: uuid(3), customerId: null, orderNumber: 'ORD-0021', orderDate: '2026-10-20T09:00:00.000Z', currencyCode: 'USD', registerSessionId: uuid(4), note: null,
  totalAmount: 10, operationalStatus: 'planned', createdAt: '2026-10-20T09:00:00.000Z', updatedAt: '2026-10-20T09:00:00.000Z',
  lineItems: [{ id: uuid(11), lineNumber: 1, itemType: 'product', productId: null, description: 'Coffee beans', quantity: 1, unitPrice: 10, lineTotal: 10 }],
  payments: [], changeDue: 0, ...over,
});

describe('buildNote (local check before anything is sent)', () => {
  it('trims; an empty or blank note clears (null); ordinary text with short numbers is kept', () => {
    expect(buildNote('  Table 4, no sugar ')).toEqual({ ok: true, note: 'Table 4, no sugar' });
    expect(buildNote('')).toEqual({ ok: true, note: null });
    expect(buildNote('   ')).toEqual({ ok: true, note: null });
    expect(buildNote('Pick up at 18:30, phone 055 123')).toMatchObject({ ok: true });
  });

  it('allows exactly 500 characters and refuses 501', () => {
    expect(buildNote('x'.repeat(NOTE_MAX))).toMatchObject({ ok: true });
    expect(buildNote('x'.repeat(NOTE_MAX + 1))).toMatchObject({ ok: false });
    expect(buildNote(` ${'x'.repeat(NOTE_MAX)} `)).toMatchObject({ ok: true });
  });

  it('refuses anything that looks like a card number', () => {
    for (const bad of ['4111111111111111', '4111 1111 1111 1111', '4111-1111-1111-1111', 'card 4111 1111 1111 1111 ok']) expect(buildNote(bad), bad).toMatchObject({ ok: false });
  });

  it('notePreview shortens long text to one line and shows nothing for no note', () => {
    expect(notePreview(null)).toBe('');
    expect(notePreview('short')).toBe('short');
    expect(notePreview('a\n  b   c')).toBe('a b c');
    expect(notePreview('x'.repeat(100), 20)).toHaveLength(20);
    expect(notePreview('x'.repeat(100), 20).endsWith('…')).toBe(true);
  });
});

describe('the order schema', () => {
  it('accepts an order without the note field (an API from before migration 0207), a null note and a text note; refuses a non-text note', () => {
    const { note: _omit, ...withoutNote } = order();
    expect(orderSchema.safeParse(withoutNote).success).toBe(true);
    expect(orderSchema.safeParse(order({ note: null })).success).toBe(true);
    expect(orderSchema.safeParse(order({ note: 'table 4' })).success).toBe(true);
    expect(orderSchema.safeParse({ ...order(), note: 42 }).success).toBe(false);
  });
});

/** Answers the note route like the server (the saved note is whatever it returns), or fails with the configured error. */
class FakeApi implements ApiClient {
  calls: { path: string; body: unknown; key?: string }[] = [];
  failWith: ApiError | null = null;
  constructor(public current: Order) {}
  async post<T>(path: string, init: RequestInitLite<T> = {}): Promise<T> {
    this.calls.push({ path, body: init.body, key: init.idempotencyKey });
    if (this.failWith) throw this.failWith;
    this.current = { ...this.current, note: (init.body as { note: string | null }).note };
    return JSON.parse(JSON.stringify(this.current)) as T;
  }
  async get<T>(): Promise<T> { return JSON.parse(JSON.stringify(this.current)) as T; }
  async delete<T>(): Promise<T> { throw new Error('not used'); }
}

describe('OrderSession.setNote', () => {
  const open = async (api: FakeApi) => { const s = new OrderSession(api, scope, uuid(3), () => 'key-1'); await s.open(api.current.id); return s; };

  it('posts the trimmed note with an idempotency key and shows the note the server saved', async () => {
    const api = new FakeApi(order());
    const session = await open(api);
    expect(await session.setNote('  Table 4  ')).toBe(true);
    expect(api.calls[0]).toEqual({ path: `/v1/businesses/${uuid(3)}/orders/${uuid(10)}/note`, body: { note: 'Table 4' }, key: 'key-1' });
    expect(session.getState().order?.note).toBe('Table 4');
  });

  it('an empty note sends null (clears it)', async () => {
    const api = new FakeApi(order({ note: 'old' }));
    const session = await open(api);
    expect(await session.setNote('   ')).toBe(true);
    expect(api.calls[0].body).toEqual({ note: null });
    expect(session.getState().order?.note).toBeNull();
  });

  it('a bad note is refused locally without calling the server; an order that is not open is ignored', async () => {
    const api = new FakeApi(order());
    const session = await open(api);
    expect(await session.setNote('x'.repeat(NOTE_MAX + 1))).toBe(false);
    expect(await session.setNote('4111 1111 1111 1111')).toBe(false);
    expect(api.calls).toHaveLength(0);
    expect(session.getState().message).toContain('card number');
    const done = new FakeApi(order({ operationalStatus: 'completed' }));
    expect(await (await open(done)).setNote('late')).toBe(false);
    expect(done.calls).toHaveLength(0);
  });

  it('a 400 and a 409 get their own plain sentences, never the server words, and are not retried', async () => {
    for (const [status, text] of [[400, NOTE_REFUSED], [409, NOTE_CONFLICT]] as const) {
      const api = new FakeApi(order());
      const session = await open(api);
      api.failWith = new ApiError(status, 'X', 'raw server words must not be shown');
      expect(await session.setNote('hello')).toBe(false);
      expect(session.getState().message).toBe(text);
      expect(session.getState().retryable).toBe(false);
    }
  });
});

describe('order panel: note', () => {
  const panel = (props: Partial<OrderPanelProps>, o: Order | null = order()) =>
    renderToString(<OrderPanelView state={{ order: o, busy: false, message: null, retryable: false }} openOrders={[]} onStart={() => undefined} onRemove={() => undefined} onRetry={() => undefined} onDiscard={() => undefined} onOpen={() => undefined} {...props} />).replace(/<!-- -->/g, '');
  const buttonTag = (out: string, label: string): string | null => {
    const end = out.indexOf(`>${label}</button>`);
    return end < 0 ? null : out.slice(out.lastIndexOf('<button', end), end + 1);
  };

  it('an open order shows the note box with its saved note; Save note waits until the text changes and is valid', () => {
    const base = { onNoteChange: () => undefined, onSaveNote: () => undefined };
    const saved = panel({ ...base }, order({ note: 'Table 4' }));
    expect(saved).toContain('id="order-note"');
    expect(saved).toContain('value="Table 4"');
    expect(buttonTag(saved, 'Save note')).toContain('disabled=""');                       // nothing edited yet
    const edited = panel({ ...base, noteText: 'Table 5', noteCheck: buildNote('Table 5') }, order({ note: 'Table 4' }));
    expect(edited).toContain('value="Table 5"');
    expect(buttonTag(edited, 'Save note')).not.toContain('disabled');
    const same = panel({ ...base, noteText: ' Table 4 ', noteCheck: buildNote(' Table 4 ') }, order({ note: 'Table 4' }));
    expect(buttonTag(same, 'Save note')).toContain('disabled=""');                        // unchanged after trimming
    const bad = panel({ ...base, noteText: '4111 1111 1111 1111', noteCheck: buildNote('4111 1111 1111 1111') });
    expect(buttonTag(bad, 'Save note')).toContain('disabled=""');
    expect(bad).toContain('card number');
  });

  it('a completed or voided order shows its note as read-only text, with no box and no button; no note shows nothing', () => {
    for (const status of ['completed', 'failed'] as const) {
      const out = panel({ onNoteChange: () => undefined, onSaveNote: () => undefined }, order({ operationalStatus: status, note: 'pick up at 6' }));
      expect(out).toContain('Note: pick up at 6');
      expect(out).not.toContain('id="order-note"');
      expect(out).not.toContain('Save note');
    }
    expect(panel({}, order({ operationalStatus: 'completed', note: null }))).not.toContain('Note:');
  });

  it('the box is locked while offline or while a confirmation is open, and absent when the page gives no handler (earlier uses of the panel)', () => {
    const base = { onNoteChange: () => undefined, onSaveNote: () => undefined };
    expect(panel({ ...base, confirm: 'void' })).toMatch(/<input id="order-note"[^>]*disabled=""/);
    expect(panel({})).not.toContain('id="order-note"');
  });

  it('the note box and Save note are locked while the connection is down, and Open on a listed order too', () => {
    const base = { onNoteChange: () => undefined, onSaveNote: () => undefined, offline: true };
    const out = panel({ ...base, noteText: 'Table 5', noteCheck: buildNote('Table 5'), openOrders: [order({ id: uuid(60), orderNumber: 'ORD-0060', note: 'x' })] }, order({ note: 'Table 4' }));
    expect(out).toMatch(/<input id="order-note"[^>]*disabled=""/);
    expect(buttonTag(out, 'Save note')).toContain('disabled=""');
    expect(buttonTag(out, 'Open')).toContain('disabled=""');
  });

  it('the open-orders list shows a short preview of each note', () => {
    const out = panel({ openOrders: [order({ id: uuid(50), orderNumber: 'ORD-0050', note: 'Table 9, allergy: nuts' }), order({ id: uuid(51), orderNumber: 'ORD-0051', note: null })] });
    expect(out).toContain('ORD-0050');
    expect(out).toContain('Table 9, allergy: nuts');
    expect(out.split('order-note-preview').length - 1).toBe(1);
  });
});

describe('the note is internal: it never appears on the customer receipt', () => {
  it('buildReceipt carries no note text', () => {
    const r = buildReceipt(order({ operationalStatus: 'completed', note: 'allergy: nuts - SECRET-NOTE', payments: [{ id: uuid(30), position: 1, method: 'cash', currencyCode: 'USD', amountTendered: 10, amountApplied: 10, changeGiven: 0, reference: null, createdAt: '2026-10-20T09:01:00.000Z' }] }), { formatDate: (d) => d });
    expect(r).not.toBeNull();
    expect(JSON.stringify(r)).not.toContain('SECRET-NOTE');
  });
});
