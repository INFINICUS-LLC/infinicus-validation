import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { idempotencyRequestHash } from '../src/plugins/idempotency.js';

describe('resource-bound idempotency fingerprints', () => {
  it('retains the stored body hash for parameterless requests', () => {
    for (const body of [undefined, null, {}, { email: 'test@example.test' }]) {
      expect(idempotencyRequestHash(body, {})).toBe(createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex'));
    }
  });
  it('binds every resource parameter, independently of property insertion order', () => {
    const body = { quantity: 2 };
    const params = { businessId: 'business-a', orderId: 'order-a', lineItemId: 'line-a' };
    const hash = idempotencyRequestHash(body, params);
    expect(idempotencyRequestHash(body, { lineItemId: 'line-a', orderId: 'order-a', businessId: 'business-a' })).toBe(hash);
    for (const name of Object.keys(params)) expect(idempotencyRequestHash(body, { ...params, [name]: 'other' })).not.toBe(hash);
    expect(idempotencyRequestHash({ quantity: 3 }, params)).not.toBe(hash);
  });
  it('cannot confuse a legacy JSON body with the resource fingerprint envelope', () => {
    const params = { orderId: 'order-a' };
    const body = { payments: [] };
    expect(idempotencyRequestHash(body, params)).not.toBe(idempotencyRequestHash({ params: Object.entries(params), body }, {}));
    expect(idempotencyRequestHash(body, params)).not.toBe(idempotencyRequestHash(body, {}));
  });
});
