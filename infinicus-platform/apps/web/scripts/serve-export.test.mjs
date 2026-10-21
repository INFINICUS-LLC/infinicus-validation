import { describe, it, expect } from 'vitest';
import { placeholderPath } from './serve-export.mjs';

const ID = '00000000-0000-4000-8000-000000000003';

describe('the fallback rule the device shell must reproduce', () => {
  it('answers every business screen address with the placeholder file, keeping any deeper path', () => {
    expect(placeholderPath(`/businesses/${ID}/counter/`)).toBe('/businesses/_/counter/');
    expect(placeholderPath(`/businesses/${ID}/counter`)).toBe('/businesses/_/counter/');
    expect(placeholderPath(`/businesses/${ID}/sales/extra/file.txt`)).toBe('/businesses/_/sales/extra/file.txt');
    expect(placeholderPath('/businesses/another-id-entirely/printers/')).toBe('/businesses/_/printers/');
  });
  it('leaves everything else alone: the placeholder itself, other screens, assets, the business list and a bare business address', () => {
    for (const p of ['/businesses/_/counter/', '/sign-in/', '/workspaces/', '/businesses/', `/businesses/${ID}`, '/_next/static/chunks/a.js', '/']) {
      expect(placeholderPath(p), p).toBe(p);
    }
  });
});
