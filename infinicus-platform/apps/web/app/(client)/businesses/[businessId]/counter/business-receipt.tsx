'use client';

import { useMemo, type ComponentProps } from 'react';
import { businessSummarySchema, type Order } from '../../../../../lib/client/schemas';
import { buildReceipt } from '../../../../../lib/client/receipt';
import { useScopedResource } from '../../../use-scoped-resource';
import type { PaperMm } from '../../../../../lib/client/printing';
import { ReceiptView } from './receipt-view';

/** Mounted with a tenant/workspace/business key so a previous scope's header is never reused. */
export function BusinessReceipt({ order, onClose, autoPrint = false, paperMm, onPrinted }: { order: Order; onClose: () => void; autoPrint?: boolean; paperMm?: PaperMm; onPrinted?: ComponentProps<typeof ReceiptView>['onPrinted'] }) {
  const schema = useMemo(() => businessSummarySchema.refine((b) => b.id === order.businessId, 'Unexpected business'), [order.businessId]);
  const { resource, reload } = useScopedResource(`/v1/businesses/${order.businessId}`, schema);
  if (resource.kind !== 'ok') return <section className="card" aria-label="Receipt">
    <p role={resource.kind === 'error' ? 'alert' : 'status'}>{resource.kind === 'error' ? resource.message : 'Loading receipt business details…'}</p>
    {resource.kind === 'error' ? <button type="button" onClick={reload}>Retry receipt</button> : null}
    <button type="button" onClick={onClose}>Close receipt</button>
  </section>;
  const receipt = buildReceipt(order, { businessName: resource.data.legalName });
  return receipt ? <ReceiptView receipt={receipt} onClose={onClose} autoPrint={autoPrint} paperMm={paperMm} onPrinted={onPrinted} /> : null;
}
