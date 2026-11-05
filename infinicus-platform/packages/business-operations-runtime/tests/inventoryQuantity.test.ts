import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Decimal } from '../src/inventory-policy/decimal.js';
import { movementDelta, nextOnHand, parseMovementQuantity, quantityProblemMessage, type MovementType } from '../src/inventory/inventoryQuantity.js';

const d = (t: string) => Decimal.parse(t) as Decimal;
const ok = (v: unknown) => { const r = parseMovementQuantity(v); if (!r.ok) throw new Error(`refused: ${r.problem}`); return r.value.toString(); };
const problem = (v: unknown) => { const r = parseMovementQuantity(v); return r.ok ? null : r.problem; };

describe('parseMovementQuantity: exact, never rounded', () => {
  it('accepts exact decimal text and numbers written with at most four decimals', () => {
    expect(ok('0.1000')).toBe('0.1'); expect(ok('99999999999999.9999')).toBe('99999999999999.9999'); expect(ok('-0.0001')).toBe('-0.0001');
    expect(ok('+5')).toBe('5'); expect(ok(0.1)).toBe('0.1'); expect(ok(12345.6789)).toBe('12345.6789'); expect(ok('0.30000')).toBe('0.3'); expect(ok(0)).toBe('0');
  });
  it('refuses more than four decimals (text or number) and never rounds', () => {
    for (const v of ['0.00001', 0.00001, '1.23456', 1.00005, '0.12345']) expect(problem(v)).toBe('excess_scale');
  });
  it('refuses 10^14 and above, including unsafe integers, without converting text through Number', () => {
    for (const v of ['100000000000000', 1e14, 1e21, 9007199254740993, '9007199254740993', '-100000000000000', '123456789012345678901234567890.1234']) expect(problem(v)).toBe('out_of_range');
    expect(ok('99999999999999')).toBe('99999999999999');
  });
  it('refuses a number with more than 15 significant digits: it is already an approximation (R1 defect D1)', () => {
    for (const v of [12345678901234.5678, 12345678901234.567, 123456789012.3456, 1234567890123.4567]) expect(problem(v), String(v)).toBe('unsafe_number');
    for (const v of [123456789012.345, 1234567890.1234, 12345678901234, 0.0001, 99999999999999]) expect(problem(v), String(v)).toBeNull();
    expect(ok('12345678901234.5678')).toBe('12345678901234.5678');   // the same value as exact text is accepted
  });
  it('refuses over-long text before parsing, so a huge string cannot cost CPU (R1 defect D2)', () => {
    const huge = ['9'.repeat(1_000_000), `0.${'0'.repeat(100_000)}1`, `1${'0'.repeat(300_000)}`, '0'.repeat(65)];
    for (const v of huge) { const t0 = performance.now(); expect(problem(v)).toBe('too_long'); expect(performance.now() - t0).toBeLessThan(50); }
    expect(problem('0'.repeat(64))).toBeNull();                       // 64 characters is still accepted
    expect(ok(`0.${'0'.repeat(20)}`)).toBe('0');                     // trailing zeros beyond the fourth place are still the same value
  });
  it('refuses anything that is not a finite plain decimal', () => {
    for (const v of ['abc', '1e3', '1E3', ' 1', '1 ', '', '1,5', '--1', '.5', '5.', '+', '-', NaN, Infinity, -Infinity, null, undefined, {}, [1], true, 5n]) expect(problem(v), String(v)).toBe('not_a_decimal');
  });
  it('has a fixed message per problem (the value is never echoed)', () => {
    expect(quantityProblemMessage('not_a_decimal')).toBe('Inventory movement quantity must be a finite decimal.');
    expect(quantityProblemMessage('excess_scale')).toBe('Inventory movement quantity must have at most 4 decimal places (it is never rounded).');
    expect(quantityProblemMessage('out_of_range')).toBe('Inventory movement quantity must have an absolute value below 100000000000000.');
    expect(quantityProblemMessage('too_long')).toBe('Inventory movement quantity text must be at most 64 characters.');
    expect(quantityProblemMessage('unsafe_number')).toBe('Inventory movement quantity given as a number must have at most 15 significant digits; pass it as exact decimal text.');
  });
});

describe('movementDelta: movement-type semantics are the original ones', () => {
  const t = (m: MovementType, q: string) => movementDelta(m, d(q)).toString();
  it('adds the magnitude', () => { for (const m of ['receipt', 'transfer_in', 'return'] as const) { expect(t(m, '2.5')).toBe('2.5'); expect(t(m, '-2.5')).toBe('2.5'); } });
  it('subtracts the magnitude', () => { for (const m of ['issue', 'transfer_out', 'write_off'] as const) { expect(t(m, '2.5')).toBe('-2.5'); expect(t(m, '-2.5')).toBe('-2.5'); } });
  it('keeps the sign', () => { for (const m of ['adjustment', 'cycle_count'] as const) { expect(t(m, '2.5')).toBe('2.5'); expect(t(m, '-2.5')).toBe('-2.5'); } });
});

describe('nextOnHand: exact, non-negative, inside numeric(18,4)', () => {
  it('adds exactly (the float traps)', () => {
    const r = nextOnHand(d('0.1000'), d('0.2000')); expect(r.ok && r.value.toString()).toBe('0.3');
    const s = nextOnHand(d('1.0000'), d('-0.0001')); expect(s.ok && s.value.toString()).toBe('0.9999');
    const u = nextOnHand(d('12345678901234.5678'), d('0.0001')); expect(u.ok && u.value.toString()).toBe('12345678901234.5679');
  });
  it('refuses a negative balance and reports the exact value', () => {
    const r = nextOnHand(d('0'), d('-0.0001')); expect(r).toMatchObject({ ok: false, reason: 'negative' }); expect(r.value.toString()).toBe('-0.0001');
    expect(nextOnHand(d('0.0003'), d('-0.0003'))).toMatchObject({ ok: true });
  });
  it('refuses overflow of the maximum', () => {
    expect(nextOnHand(d('99999999999999.9999'), d('0.0001'))).toMatchObject({ ok: false, reason: 'overflow' });
    expect(nextOnHand(d('99999999999999.9998'), d('0.0001'))).toMatchObject({ ok: true });
  });
});

describe('the writer does no floating-point quantity arithmetic (static)', () => {
  const src = readFileSync(resolve(__dirname, '../src/OperationalCommandExecutor.ts'), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const writer = src.slice(src.indexOf('private async applyInventoryMovement'), src.indexOf('private async recordPurchaseReceipt'));
  it('the movement writer never uses Number() or Math.abs() on a quantity and passes exact numeric text', () => {
    expect(writer).not.toMatch(/\bNumber\(|Math\.abs\(|parseFloat|inventoryDelta/);
    expect(writer).toContain('parseMovementQuantity(p.quantity)');
    expect(writer).toContain('FOR UPDATE');
    expect(writer).toMatch(/\$7::numeric/); expect(writer).toMatch(/quantity_on_hand = \$2::numeric/); expect(writer).toMatch(/quantity_on_hand::text/);
  });
});
