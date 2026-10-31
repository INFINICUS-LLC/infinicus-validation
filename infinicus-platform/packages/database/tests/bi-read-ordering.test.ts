import { describe, expect, it } from 'vitest';
import { orderStatusHistory } from '../src/repositories/bi/BiIntakeDatasetReadRepository.js';

const row = (fromStatus: string | null, toStatus: string) => ({ fromStatus, toStatus });
describe('orderStatusHistory: the lifecycle in order even when every row has the same timestamp', () => {
  it('follows from -> to, whatever order the rows arrive in', () => {
    const chain = [row(null, 'received'), row('received', 'validating'), row('validating', 'validated'), row('validated', 'processed')];
    for (const shuffled of [[...chain].reverse(), [chain[2], chain[0], chain[3], chain[1]], [chain[1], chain[3], chain[2], chain[0]], chain]) {
      expect(orderStatusHistory(shuffled).map((r) => r.toStatus)).toEqual(['received', 'validating', 'validated', 'processed']);
    }
  });
  it('a rejected intake ends at rejected; an empty history stays empty; the input is not mutated', () => {
    const rejected = [row('validating', 'rejected'), row(null, 'received'), row('received', 'validating')];
    const snapshot = JSON.stringify(rejected);
    expect(orderStatusHistory(rejected).map((r) => r.toStatus)).toEqual(['received', 'validating', 'rejected']);
    expect(JSON.stringify(rejected)).toBe(snapshot);
    expect(orderStatusHistory([])).toEqual([]);
  });
  it('rows that do not chain are kept (never dropped), in the order given', () => {
    const odd = [row('x', 'y'), row('p', 'q')];
    expect(orderStatusHistory(odd).map((r) => r.toStatus)).toEqual(['y', 'q']);
  });
});
