import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import type { ZodType } from 'zod';
import type { Order } from '../lib/client/schemas';
import { BusinessReceipt } from '../app/(client)/businesses/[businessId]/counter/business-receipt';

const read = vi.hoisted(() => ({ resource: { kind: 'loading' } as any, path: '', schema: null as ZodType | null, reload: vi.fn() }));
vi.mock('../app/(client)/use-scoped-resource', () => ({
  useScopedResource: (path: string, schema: ZodType) => {
    read.path = path; read.schema = schema;
    if (read.resource.kind === 'ok' && !schema.safeParse(read.resource.data).success) return { resource: { kind: 'error', message: 'Unexpected business' }, reload: read.reload };
    return { resource: read.resource, reload: read.reload };
  },
}));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const order: Order = {
  id: id(1), businessId: id(2), customerId: null, orderNumber: 'SALE-6D', currencyCode: 'USD', registerSessionId: id(3),
  orderDate: '2026-10-20T12:00:00.000Z', createdAt: '2026-10-20T12:00:00.000Z', updatedAt: '2026-10-20T12:00:00.000Z',
  operationalStatus: 'completed', totalAmount: 0, changeDue: 0, lineItems: [], payments: [],
};
const business = { id: id(2), legalName: 'Canonical Café', businessCode: 'CAFE', status: 'active', industry: null };
const render = () => renderToString(<BusinessReceipt order={order} onClose={() => {}} />);

beforeEach(() => { read.resource = { kind: 'loading' }; });
describe('POS-6d verified business receipt', () => {
  it('looks up the exact business and waits for its identity before offering print', () => {
    expect(render()).toContain('Loading receipt business details');
    expect(read.path).toBe(`/v1/businesses/${order.businessId}`);
    expect(render()).not.toContain('Print receipt');
    expect(render()).toContain('Close receipt');
  });
  it('prints the canonical summary name with the server sale', () => {
    read.resource = { kind: 'ok', data: business };
    const html = render();
    expect(html).toContain('Canonical Café');
    expect(html).toContain('SALE-6D');
    expect(html).toContain('Print receipt');
  });
  it('offers retry and close on failed identity lookup without a printable sale', () => {
    read.resource = { kind: 'error', message: 'Not found in this workspace' };
    const html = render();
    expect(html).toContain('Not found in this workspace');
    expect(html).toContain('Retry receipt');
    expect(html).toContain('Close receipt');
    expect(html).not.toContain('Print receipt');
    expect(html).not.toContain('SALE-6D');
  });
  it('rejects a well-formed summary belonging to another business', () => {
    read.resource = { kind: 'ok', data: { ...business, id: id(99), legalName: 'Wrong Business' } };
    const html = render();
    expect(html).toContain('Unexpected business');
    expect(html).not.toContain('Wrong Business');
    expect(html).not.toContain('Print receipt');
    expect(read.schema!.safeParse(business).success).toBe(true);
  });
});
