import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import { browserLocation, currentBusinessId, type LocationSource } from '../lib/client/locationPath';
import { businessIdFromPath } from '../lib/client/businessTabs';
import { useBusinessId, useBusinessTabs } from '../app/(client)/businesses/[businessId]/use-business-id';
import { generateStaticParams } from '../app/(client)/businesses/[businessId]/layout';

const ID = '00000000-0000-4000-8000-000000000003';

/** An address the test drives by hand. */
class FakeLocation implements LocationSource {
  path: string;
  listeners = new Set<() => void>();
  constructor(path: string) { this.path = path; }
  pathname = (): string => this.path;
  subscribe = (l: () => void): (() => void) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
  go(path: string): void { this.path = path; for (const l of [...this.listeners]) l(); }
}

describe('currentBusinessId (the address is the truth)', () => {
  it('reads a well-formed id from a business address and follows the address when it changes', () => {
    const loc = new FakeLocation(`/businesses/${ID}/counter/`);
    expect(currentBusinessId(loc)).toBe(ID);
    loc.go('/businesses/11111111-1111-4111-8111-111111111111/sales/');
    expect(currentBusinessId(loc)).toBe('11111111-1111-4111-8111-111111111111');
  });
  it('is null for the placeholder, a malformed or injected id, other screens and an empty path', () => {
    for (const p of ['/businesses/_/counter/', '/businesses/not-an-id/counter/', '/businesses/<script>/counter/', '/businesses/', '/sign-in/', '']) {
      expect(currentBusinessId(new FakeLocation(p)), p).toBeNull();
    }
  });
  it('the placeholder the export is built with is never a valid id (an opened placeholder address shows the invalid-address notice)', () => {
    expect(generateStaticParams()).toEqual([{ businessId: '_' }]);
    expect(businessIdFromPath('/businesses/_/counter/')).toBeNull();
  });
  it('without a window (server rendering) the path is empty and subscribing does nothing', () => {
    expect(browserLocation.pathname()).toBe('');
    expect(() => browserLocation.subscribe(() => undefined)()).not.toThrow();
  });
});

describe('the hooks on the server (first render before the browser address is read)', () => {
  const Probe = ({ loc }: { loc: LocationSource }) => <p>{useBusinessId(loc) ?? 'none'}|{useBusinessTabs(loc).length}</p>;
  it('give no business and no tabs while server rendering, even if the source has a valid address; the browser then reads the real address', () => {
    const out = renderToString(<Probe loc={new FakeLocation(`/businesses/${ID}/counter/`)} />).replace(/<!-- -->/g, '');
    expect(out).toBe('<p>none|0</p>');
  });
});
