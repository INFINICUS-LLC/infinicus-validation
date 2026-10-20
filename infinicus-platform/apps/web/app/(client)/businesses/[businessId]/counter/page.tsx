'use client';

import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { openOrdersPath } from '../../../../../lib/client/orders';
import { orderListSchema, productListSchema } from '../../../../../lib/client/schemas';
import { StateNotice } from '../../../state-notice';
import { useAuth } from '../../../auth-provider';
import { useRequireWorkspace } from '../../../use-require-workspace';
import { useScopedResource } from '../../../use-scoped-resource';
import { CounterCatalogue } from './counter-view';
import { OrderPanelView, useOrderSession } from './order-panel';
import { RegisterPanelView, useRegister } from './register-panel';
import { BusinessReceipt } from './business-receipt';
import { parseCashAmount } from '../../../../../lib/client/register';
import { buildTenderPlan, type TenderEntry } from '../../../../../lib/client/tender';
import { buildDiscount, NO_DISCOUNT, type DiscountEntry } from '../../../../../lib/client/discount';
import { buildNote } from '../../../../../lib/client/note';

const idSchema = z.string().uuid();

export default function CounterPage() {
  const { state, api } = useAuth();
  const { scope } = useRequireWorkspace();
  const params = useParams<{ businessId: string }>();
  const businessId = idSchema.safeParse(params.businessId).success ? params.businessId : null;
  const { resource, reload } = useScopedResource(scope && businessId ? `/v1/businesses/${businessId}/products` : null, productListSchema);
  const open = useScopedResource(scope && businessId ? openOrdersPath(businessId) : null, orderListSchema);
  const { session, state: orderState } = useOrderSession(api, scope, businessId);
  const { controller: register, state: registerState } = useRegister(api, scope, businessId);
  const [cashText, setCashText] = useState('');
  const [confirmingClose, setConfirmingClose] = useState(false);
  useEffect(() => { if (register) void register.load(); }, [register]);
  const [ask, setAsk] = useState<{ kind: 'complete' | 'void' | 'discount'; orderId: string } | null>(null);
  const [discount, setDiscount] = useState<DiscountEntry>(NO_DISCOUNT);
  const [voidReason, setVoidReason] = useState('');
  const [tenders, setTenders] = useState<TenderEntry[]>([]);
  const [receiptFor, setReceiptFor] = useState<string | null>(null);
  // The note being typed belongs to one order: switching orders drops the draft and the box shows that order's saved note again.
  const [noteDraft, setNoteDraft] = useState<{ orderId: string; text: string } | null>(null);

  if (!scope) return <StateNotice state={state} />;
  if (!businessId) return <div className="card"><p className="notice danger" role="alert">That business address is not valid.</p><p><a href="/businesses">&larr; All businesses</a></p></div>;

  const openOrders = open.resource.kind === 'ok' ? open.resource.data.orders : [];
  const act = (run: () => Promise<boolean>) => { void run().then((changed) => { if (changed) { open.reload(); void register?.refreshSummary(); } }); };
  // The confirmation belongs to one order: switching orders drops it.
  const confirm = ask && ask.orderId === orderState.order?.id ? ask.kind : null;
  const noteText = noteDraft && noteDraft.orderId === orderState.order?.id ? noteDraft.text : undefined;
  // Like the confirmation, the open receipt belongs to one order: switching orders closes it.
  const receipt = orderState.order?.businessId === businessId && orderState.order.operationalStatus === 'completed' && receiptFor === orderState.order.id ? orderState.order : null;
  const onConfirm = () => {
    if (!session || !confirm) return;
    let run: () => Promise<boolean>;
    const orderId = orderState.order?.id ?? null;
    if (confirm === 'complete') {
      const order = orderState.order;
      const check = order ? buildTenderPlan(tenders, order.totalAmount, order.currencyCode) : null;
      if (!check || !check.ok) return;
      run = () => session.complete(check.payments);
    } else if (confirm === 'discount') {
      const order = orderState.order;
      const check = order ? buildDiscount(discount, order.totalAmount, order.currencyCode) : null;
      if (!check || !check.ok) return;
      run = () => session.discount(check.amount, check.reason);
    } else {
      run = () => session.voidOrder(voidReason);
    }
    void run().then((changed) => { if (changed) { open.reload(); void register?.refreshSummary(); setAsk(null); setVoidReason(''); setDiscount(NO_DISCOUNT); setTenders([]); if (confirm === 'complete') setReceiptFor(orderId); } });
  };
  const orderPanel = (
    <OrderPanelView
      state={orderState}
      openOrders={openOrders}
      onStart={() => session && act(session.start)}
      onRemove={(lineItemId) => session && act(() => session.remove(lineItemId))}
      onQuantity={(lineItemId, quantity) => session && act(() => session.setQuantity(lineItemId, quantity))}
      onRetry={() => session && act(session.retry)}
      onDiscard={() => { if (session) void session.discard(); }}
      onOpen={(orderId) => session && act(() => session.open(orderId))}
      confirm={confirm}
      voidReason={voidReason}
      onAsk={(kind) => { if (orderState.order) { setVoidReason(''); setDiscount(NO_DISCOUNT); setTenders(orderState.order.totalAmount === 0 ? [] : [{ method: 'cash', amountText: '', reference: '' }]); setAsk({ kind, orderId: orderState.order.id }); } }}
      onCancelAsk={() => { setAsk(null); setVoidReason(''); setDiscount(NO_DISCOUNT); setTenders([]); }}
      onConfirm={onConfirm}
      onReasonChange={setVoidReason}
      tenders={tenders}
      tenderCheck={orderState.order ? buildTenderPlan(tenders, orderState.order.totalAmount, orderState.order.currencyCode) : null}
      onTendersChange={setTenders}
      discount={discount}
      discountCheck={orderState.order ? buildDiscount(discount, orderState.order.totalAmount, orderState.order.currencyCode) : null}
      onDiscountChange={setDiscount}
      noteText={noteText}
      noteCheck={noteText !== undefined ? buildNote(noteText) : null}
      onNoteChange={(text) => { if (orderState.order) setNoteDraft({ orderId: orderState.order.id, text }); }}
      onSaveNote={() => { if (session && noteText !== undefined) void session.setNote(noteText).then((saved) => { if (saved) { setNoteDraft(null); open.reload(); } }); }}
      registerOpen={registerState.loaded ? registerState.session !== null : undefined}
      onViewReceipt={() => { if (orderState.order) setReceiptFor(orderState.order.id); }}
      receiptOpen={receipt !== null}
    />
  );
  const cashValid = parseCashAmount(cashText) !== null;
  const registerPanel = (
    <RegisterPanelView
      state={registerState}
      cashText={cashText}
      cashValid={cashValid}
      confirmingClose={confirmingClose}
      onCashChange={(text) => { setCashText(text); setConfirmingClose(false); }}
      onOpen={() => { const n = parseCashAmount(cashText); if (register && n !== null) void register.open(n).then((ok) => { if (ok) { setCashText(''); open.reload(); } }); }}
      onAskClose={() => setConfirmingClose(true)}
      onCancelClose={() => setConfirmingClose(false)}
      onConfirmClose={() => { const n = parseCashAmount(cashText); if (register && n !== null) void register.close(n).then((ok) => { if (ok) { setCashText(''); setConfirmingClose(false); open.reload(); } }); }}
      onRetry={() => { if (register) void register.retry(); }}
      onDiscard={() => { if (register) void register.discard(); }}
    />
  );
  const canAdd = Boolean(orderState.order) && orderState.order?.operationalStatus === 'planned' && !orderState.busy && !orderState.retryable && confirm === null;

  return (
    <div>
      <h1>Counter</h1>
      <p><a href={`/businesses/${businessId}/sales`}>Sales history and receipts</a></p>
      <p><a href="/businesses">&larr; All businesses</a></p>
      {resource.kind === 'loading' ? <p role="status" aria-live="polite">Loading…</p> : null}
      {resource.kind === 'error' ? (<p className="notice danger" role="alert">{resource.message} <button type="button" className="secondary" onClick={reload}>Try again</button></p>) : null}
      {open.resource.kind === 'error' ? <p className="notice danger" role="alert">Open orders could not be loaded. {open.resource.message} <button type="button" className="secondary" onClick={open.reload}>Try again</button></p> : null}
      {resource.kind === 'ok' ? (
        <CounterCatalogue
          products={resource.data.products}
          orderPanel={<div className="counter-left">{registerPanel}{orderPanel}{receipt ? <BusinessReceipt key={`${scope.tenantId}/${scope.workspaceId}/${businessId}`} order={receipt} onClose={() => setReceiptFor(null)} /> : null}</div>}
          disabled={!canAdd}
          onAdd={(product) => session && act(() => session.add(product))}
        />
      ) : null}
    </div>
  );
}
