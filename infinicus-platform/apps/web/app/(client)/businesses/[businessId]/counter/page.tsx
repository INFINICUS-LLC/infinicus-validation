'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import { z } from 'zod';
import { openOrdersPath } from '../../../../../lib/client/orders';
import { orderListSchema, productListSchema } from '../../../../../lib/client/schemas';
import { StateNotice } from '../../../state-notice';
import { useAuth } from '../../../auth-provider';
import { useRequireWorkspace } from '../../../use-require-workspace';
import { useScopedResource } from '../../../use-scoped-resource';
import { CounterCatalogue } from './counter-view';
import { OrderPanelView, useOrderSession } from './order-panel';

const idSchema = z.string().uuid();

export default function CounterPage() {
  const { state, api } = useAuth();
  const { scope } = useRequireWorkspace();
  const params = useParams<{ businessId: string }>();
  const businessId = idSchema.safeParse(params.businessId).success ? params.businessId : null;
  const { resource, reload } = useScopedResource(scope && businessId ? `/v1/businesses/${businessId}/products` : null, productListSchema);
  const open = useScopedResource(scope && businessId ? openOrdersPath(businessId) : null, orderListSchema);
  const { session, state: orderState } = useOrderSession(api, scope, businessId);
  const [ask, setAsk] = useState<{ kind: 'complete' | 'void'; orderId: string } | null>(null);
  const [voidReason, setVoidReason] = useState('');

  if (!scope) return <StateNotice state={state} />;
  if (!businessId) return <div className="card"><p className="notice danger" role="alert">That business address is not valid.</p><p><a href="/businesses">&larr; All businesses</a></p></div>;

  const openOrders = open.resource.kind === 'ok' ? open.resource.data.orders : [];
  const act = (run: () => Promise<boolean>) => { void run().then((changed) => { if (changed) open.reload(); }); };
  // The confirmation belongs to one order: switching orders drops it.
  const confirm = ask && ask.orderId === orderState.order?.id ? ask.kind : null;
  const onConfirm = () => {
    if (!session || !confirm) return;
    const run = confirm === 'complete' ? () => session.complete() : () => session.voidOrder(voidReason);
    void run().then((changed) => { if (changed) { open.reload(); setAsk(null); setVoidReason(''); } });
  };
  const orderPanel = (
    <OrderPanelView
      state={orderState}
      openOrders={openOrders}
      onStart={() => session && act(session.start)}
      onRemove={(lineItemId) => session && act(() => session.remove(lineItemId))}
      onRetry={() => session && act(session.retry)}
      onDiscard={() => { if (session) void session.discard(); }}
      onOpen={(orderId) => session && act(() => session.open(orderId))}
      confirm={confirm}
      voidReason={voidReason}
      onAsk={(kind) => { if (orderState.order) { setVoidReason(''); setAsk({ kind, orderId: orderState.order.id }); } }}
      onCancelAsk={() => { setAsk(null); setVoidReason(''); }}
      onConfirm={onConfirm}
      onReasonChange={setVoidReason}
    />
  );
  const canAdd = Boolean(orderState.order) && orderState.order?.operationalStatus === 'planned' && !orderState.busy && !orderState.retryable;

  return (
    <div>
      <h1>Counter</h1>
      <p><a href="/businesses">&larr; All businesses</a></p>
      {resource.kind === 'loading' ? <p role="status" aria-live="polite">Loading…</p> : null}
      {resource.kind === 'error' ? (<p className="notice danger" role="alert">{resource.message} <button type="button" className="secondary" onClick={reload}>Try again</button></p>) : null}
      {open.resource.kind === 'error' ? <p className="notice danger" role="alert">Open orders could not be loaded. {open.resource.message} <button type="button" className="secondary" onClick={open.reload}>Try again</button></p> : null}
      {resource.kind === 'ok' ? (
        <CounterCatalogue
          products={resource.data.products}
          orderPanel={orderPanel}
          disabled={!canAdd}
          onAdd={(product) => session && act(() => session.add(product))}
        />
      ) : null}
    </div>
  );
}
