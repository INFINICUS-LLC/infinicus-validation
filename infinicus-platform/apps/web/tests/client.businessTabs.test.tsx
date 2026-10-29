import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import { businessIdFromPath, businessTabs } from '../lib/client/businessTabs';
import { BusinessTabsView } from '../app/(client)/businesses/[businessId]/business-tabs';

const ID = '00000000-0000-4000-8000-000000000003';

describe('businessIdFromPath', () => {
  it('reads a well-formed business id from a business screen address', () => {
    expect(businessIdFromPath(`/businesses/${ID}/counter`)).toBe(ID);
    expect(businessIdFromPath(`/businesses/${ID}`)).toBe(ID);
    expect(businessIdFromPath(`/businesses/${ID.toUpperCase()}/sales`)).toBe(ID.toUpperCase());
  });
  it('is null for anything else: other screens, a malformed or injected id, no path', () => {
    for (const p of ['/businesses', '/businesses/', '/sign-in', '/workspaces', `/other/${ID}/counter`, '/businesses/not-an-id/counter', '/businesses/<script>/counter', `/businesses/${ID}x/counter`, '', null]) {
      expect(businessIdFromPath(p), String(p)).toBeNull();
    }
  });
});

describe('businessTabs', () => {
  it('lists the thirteen existing screens in order, linked to this business only', () => {
    const tabs = businessTabs(`/businesses/${ID}/counter`);
    expect(tabs.map((t) => t.label)).toEqual(['Counter', 'Sales', 'Reports', 'Finance', 'Inventory', 'Purchasing', 'Staff', 'Data', 'Automation', 'Business', 'Printers', 'Workflow', 'Decision history']);
    expect(tabs.map((t) => t.href)).toEqual(['counter', 'sales', 'reports', 'finance', 'inventory', 'purchasing', 'staff', 'data', 'automation', 'business', 'printers', 'workflow', 'history'].map((s) => `/businesses/${ID}/${s}`));
  });
  it('marks exactly the open screen as current, for each screen', () => {
    for (const [segment, label] of [['counter', 'Counter'], ['sales', 'Sales'], ['reports', 'Reports'], ['finance', 'Finance'], ['inventory', 'Inventory'], ['purchasing', 'Purchasing'], ['staff', 'Staff'], ['data', 'Data'], ['automation', 'Automation'], ['business', 'Business'], ['printers', 'Printers'], ['workflow', 'Workflow'], ['history', 'Decision history']]) {
      const current = businessTabs(`/businesses/${ID}/${segment}`).filter((t) => t.current).map((t) => t.label);
      expect(current, segment).toEqual([label]);
    }
  });
  it('marks none for a look-alike or unknown sub-address, and nothing is listed outside a business screen', () => {
    expect(businessTabs(`/businesses/${ID}/counterx`).some((t) => t.current)).toBe(false);
    expect(businessTabs(`/businesses/${ID}`).some((t) => t.current)).toBe(false);
    expect(businessTabs(`/businesses/${ID}/counter/extra`).filter((t) => t.current).map((t) => t.key)).toEqual(['counter']);
    expect(businessTabs('/businesses')).toEqual([]);
    expect(businessTabs('/businesses/<script>/counter')).toEqual([]);
    expect(businessTabs(null)).toEqual([]);
  });
});

describe('BusinessTabsView', () => {
  const html = (path: string | null) => renderToString(<BusinessTabsView tabs={businessTabs(path)} />);
  it('is a labelled navigation with thirteen links, the open one marked aria-current', () => {
    const out = html(`/businesses/${ID}/printers`);
    expect(out).toContain('<nav class="business-tabs" aria-label="Business sections">');
    expect(out.match(/<a /g)).toHaveLength(13);
    expect(out.match(/aria-current="page"/g)).toHaveLength(1);
    expect(out).toContain(`<a href="/businesses/${ID}/printers" aria-current="page" class="current">Printers</a>`);
    expect(out).toContain(`<a href="/businesses/${ID}/sales">Sales</a>`);
    expect(out).toContain(`href="/businesses/${ID}/sales"`);
  });
  it('renders nothing outside a business screen', () => { expect(html('/businesses')).toBe(''); });
});
