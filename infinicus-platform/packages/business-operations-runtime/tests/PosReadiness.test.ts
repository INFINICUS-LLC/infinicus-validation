import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { TenantContext } from '@infinicus/database';
import {
  evaluatePosReadiness, PosReadinessService, POS_READINESS_CONTRACT,
  type Fact, type PosReadinessFacts, type PosReadinessPorts, type CheckId,
} from '../src/pos-readiness/posReadiness.js';

const BIZ = '00000000-0000-4000-8000-000000000001';
const ctx: TenantContext = { tenantId: '00000000-0000-4000-8000-0000000000a1', workspaceId: '00000000-0000-4000-8000-0000000000b1', userId: '00000000-0000-4000-8000-0000000000c1' };
const k = <T,>(value: T): Fact<T> => ({ kind: 'known', value });
const gone = { kind: 'unavailable' } as const;
const facts = (over: Partial<PosReadinessFacts> = {}): PosReadinessFacts => ({
  businessId: BIZ, businessStatus: k('active'), declaredCurrency: k('KWD'), openRegister: k({ currencyCode: 'KWD' }), activeProductCount: k(3), ...over });
const check = (r: ReturnType<typeof evaluatePosReadiness>, id: CheckId) => r.checks.find((c) => c.id === id)!;

describe('evaluatePosReadiness: the verdicts', () => {
  it('is READY/READY when the required prerequisites hold, with the contract version and a fixed check order', () => {
    const r = evaluatePosReadiness(facts());
    expect(r).toMatchObject({ contract: POS_READINESS_CONTRACT, businessId: BIZ, configuration: 'READY', session: 'READY', blockingReasons: [] });
    expect(r.checks.map((c) => c.id)).toEqual(['BUSINESS_ACTIVE', 'CURRENCY_DECLARED', 'CURRENCY_SUPPORTED', 'CATALOG_HAS_ACTIVE_PRODUCT', 'TAX_CONFIGURATION', 'INVENTORY_CONFIGURATION', 'BRANCH_CONFIGURATION', 'REGISTER_OPEN', 'REGISTER_CURRENCY_MATCHES']);
  });
  it('is deterministic: the same facts always give the identical result', () => {
    const f = facts({ declaredCurrency: k(null) });
    expect(JSON.stringify(evaluatePosReadiness(f))).toBe(JSON.stringify(evaluatePosReadiness(f)));
  });
  it('an undeclared currency is NOT_READY with stable reason codes and skips what depends on it', () => {
    const r = evaluatePosReadiness(facts({ declaredCurrency: k(null) }));
    expect(r).toMatchObject({ configuration: 'NOT_READY', session: 'NOT_READY', blockingReasons: ['CURRENCY_NOT_DECLARED', 'PREREQUISITE_NOT_MET', 'PREREQUISITE_NOT_MET'] });
    expect(check(r, 'CURRENCY_SUPPORTED').status).toBe('SKIPPED');
    expect(check(r, 'REGISTER_CURRENCY_MATCHES').status).toBe('SKIPPED');
  });
  it('a currency the platform cannot state exactly is NOT_READY (CURRENCY_NOT_SUPPORTED)', () => {
    const r = evaluatePosReadiness(facts({ declaredCurrency: k('XXX'), openRegister: k({ currencyCode: 'XXX' }) }));
    expect(r.configuration).toBe('NOT_READY');
    expect(r.session).toBe('NOT_READY');   // an open register cannot make a business that cannot sell ready to take an order
    expect(check(r, 'CURRENCY_SUPPORTED')).toMatchObject({ status: 'FAIL', reasonCode: 'CURRENCY_NOT_SUPPORTED' });
  });
  it.each([['KWD', 3], ['USD', 2], ['JPY', 0]])('%s is a supported currency (exponent %i)', (code) => {
    expect(check(evaluatePosReadiness(facts({ declaredCurrency: k(code), openRegister: k({ currencyCode: code }) })), 'CURRENCY_SUPPORTED').status).toBe('PASS');
  });
  it('no open register: configuration READY, session NOT_READY', () => {
    const r = evaluatePosReadiness(facts({ openRegister: k(null) }));
    expect(r).toMatchObject({ configuration: 'READY', session: 'NOT_READY', blockingReasons: ['REGISTER_NOT_OPEN', 'PREREQUISITE_NOT_MET'] });
  });
  it('a register in another currency, or one with no recorded currency, does not match (same rule as order creation)', () => {
    for (const currencyCode of ['USD', null]) {
      const r = evaluatePosReadiness(facts({ openRegister: k({ currencyCode }) }));
      expect(r.session).toBe('NOT_READY');
      expect(check(r, 'REGISTER_CURRENCY_MATCHES')).toMatchObject({ status: 'FAIL', reasonCode: 'REGISTER_CURRENCY_MISMATCH' });
    }
  });
  it('advisory and not-applicable checks never block, however they come out', () => {
    const r = evaluatePosReadiness(facts({ businessStatus: k('suspended'), activeProductCount: k(0) }));
    expect(r).toMatchObject({ configuration: 'READY', session: 'READY', blockingReasons: [] });
    expect(check(r, 'BUSINESS_ACTIVE')).toMatchObject({ requirement: 'ADVISORY', status: 'FAIL', reasonCode: 'BUSINESS_NOT_ACTIVE' });
    expect(check(r, 'CATALOG_HAS_ACTIVE_PRODUCT')).toMatchObject({ requirement: 'ADVISORY', status: 'FAIL', reasonCode: 'NO_ACTIVE_PRODUCTS' });
    for (const id of ['TAX_CONFIGURATION', 'INVENTORY_CONFIGURATION', 'BRANCH_CONFIGURATION'] as const) expect(check(r, id)).toMatchObject({ requirement: 'ADVISORY', status: 'NOT_APPLICABLE' });
  });
});

describe('evaluatePosReadiness: fail safe', () => {
  it('a required dependency that cannot be read is UNVERIFIED, never a pass', () => {
    const r = evaluatePosReadiness(facts({ declaredCurrency: gone }));
    expect(r.configuration).toBe('UNVERIFIED'); expect(r.session).toBe('UNVERIFIED');
    expect(check(r, 'CURRENCY_DECLARED')).toMatchObject({ status: 'UNVERIFIED', reasonCode: 'DEPENDENCY_UNAVAILABLE' });
    expect(r.blockingReasons).toContain('DEPENDENCY_UNAVAILABLE');
  });
  it('an unreadable register leaves configuration READY and the session UNVERIFIED', () => {
    const r = evaluatePosReadiness(facts({ openRegister: gone }));
    expect(r.configuration).toBe('READY'); expect(r.session).toBe('UNVERIFIED');
  });
  it('a FAIL outranks an UNVERIFIED (NOT_READY wins)', () => {
    expect(evaluatePosReadiness(facts({ declaredCurrency: k(null), openRegister: gone })).configuration).toBe('NOT_READY');
    expect(evaluatePosReadiness(facts({ declaredCurrency: gone, openRegister: k(null) })).session).toBe('NOT_READY');
  });
  it('an unreadable advisory fact never blocks', () => {
    const r = evaluatePosReadiness(facts({ businessStatus: gone, activeProductCount: gone }));
    expect(r).toMatchObject({ configuration: 'READY', session: 'READY', blockingReasons: [] });
    expect(check(r, 'BUSINESS_ACTIVE').status).toBe('UNVERIFIED');
  });
});

const ports = (over: Partial<PosReadinessPorts> = {}): PosReadinessPorts => ({
  business: async () => ({ status: 'active' }), declaredCurrency: async () => 'KWD', openRegister: async () => ({ currencyCode: 'KWD' }), activeProductCount: async () => 2, ...over });
class FakeNotFound extends Error { constructor() { super('nope'); this.name = 'BusinessNotFoundError'; } }

describe('PosReadinessService', () => {
  it('evaluates what the ports return', async () => {
    expect(await new PosReadinessService(ports()).evaluate(ctx, BIZ)).toMatchObject({ configuration: 'READY', session: 'READY' });
  });
  it('a business that is not visible is a not-found error, not a readiness answer', async () => {
    await expect(new PosReadinessService(ports({ business: async () => { throw new FakeNotFound(); } })).evaluate(ctx, BIZ)).rejects.toThrow('nope');
  });
  it('a failing dependency becomes UNVERIFIED and its cause is not exposed', async () => {
    const r = await new PosReadinessService(ports({ declaredCurrency: async () => { throw new Error('connection to db-internal-7 refused'); } })).evaluate(ctx, BIZ);
    expect(r.configuration).toBe('UNVERIFIED');
    expect(JSON.stringify(r)).not.toMatch(/db-internal|refused|connection/);
  });
  it('an unreadable business status is advisory-only UNVERIFIED and does not block', async () => {
    const r = await new PosReadinessService(ports({ business: async () => { throw new Error('boom'); } })).evaluate(ctx, BIZ);
    expect(r.configuration).toBe('READY');
    expect(r.checks.find((c) => c.id === 'BUSINESS_ACTIVE')!.status).toBe('UNVERIFIED');
  });
  it('passes the caller\'s context and the business id through to every port (nothing is taken from elsewhere)', async () => {
    const seen: unknown[] = [];
    const spy = (name: string, value: unknown) => async (c: TenantContext, id: string) => { seen.push([name, c, id]); return value as never; };
    await new PosReadinessService({ business: spy('b', { status: 'active' }), declaredCurrency: spy('d', 'KWD'), openRegister: spy('r', null), activeProductCount: spy('p', 0) }).evaluate(ctx, BIZ);
    expect(seen).toHaveLength(4);
    for (const s of seen as [string, TenantContext, string][]) { expect(s[1]).toBe(ctx); expect(s[2]).toBe(BIZ); }
  });
});

describe('readiness is independent of billing (static)', () => {
  it('imports no billing, entitlement or provider code and writes nothing', () => {
    const src = readFileSync(resolve(__dirname, '../src/pos-readiness/posReadiness.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(src).not.toMatch(/@infinicus\/billing|Entitlement|entitlement|subscription|Subscription|stripe|capability/i);
    expect(src).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b|\.query\(|withTenantTransaction|\.create\(|\.open\(|\.close\(/);
  });
});
