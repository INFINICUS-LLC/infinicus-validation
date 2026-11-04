import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { CAPABILITIES, entitlementProfileFor, isCapability } from '../src/capabilities.js';

describe('capability vocabulary (POS2-01)', () => {
  it('names capabilities, never a plan, price or billing provider', () => {
    expect(CAPABILITIES).toContain('pos.core');
    expect(CAPABILITIES).toContain('intelligence.growth');
    for (const c of CAPABILITIES) expect(c).toMatch(/^(pos|intelligence|enterprise)\.[a-z_]+$/);
    const source = readFileSync(new URL('../src/capabilities.ts', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(source).not.toMatch(/stripe|price_|prod_|\bfree\b|plan_code|planCode/i);
  });
  it('recognises only listed capabilities', () => {
    expect(isCapability('pos.core')).toBe(true);
    expect(isCapability('pos.coree')).toBe(false);
    expect(isCapability('')).toBe(false);
  });
});

describe('compatibility entitlement profile (POS2-01)', () => {
  it.each(['trialing', 'active', 'past_due', 'grace_period'])('a %s subscription holds every capability (what the subscription gate already allows)', (status) => {
    const p = entitlementProfileFor(status);
    expect(p.basis).toBe('compatibility');
    expect([...p.capabilities].sort()).toEqual([...CAPABILITIES].sort());
  });
  it.each(['suspended', 'canceled', 'unknown', '', 'ACTIVE'])('a %j subscription holds nothing (fail closed)', (status) => {
    expect(entitlementProfileFor(status).capabilities.size).toBe(0);
  });
});
