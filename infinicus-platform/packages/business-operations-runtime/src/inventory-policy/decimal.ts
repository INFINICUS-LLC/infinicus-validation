/**
 * Exact decimal arithmetic for the inventory policy evaluator (Block B2b).
 *
 * Rule comparisons such as `reorderPoint + reorderQuantity <= 500` or `reorderQuantity x unit_cost <= 5000` must be exact: binary floating
 * point turns 250.1 + 249.9 into 500.00000000000006 and would fail a rule that is satisfied. Values are therefore held as an integer
 * (BigInt) over a power-of-ten scale. Numbers enter through their shortest round-trip decimal text (the value a person wrote), never through
 * binary expansion. Pure: no I/O, no clock.
 */
export class Decimal {
  private constructor(readonly units: bigint, readonly scale: number) {}

  /** Parses decimal text (`-12.50`, `1e-4`, `NaN` is refused). Returns null for anything that is not a finite decimal. */
  static parse(text: string): Decimal | null {
    const m = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text.trim());
    if (m === null) return null;
    const [, sign, whole, frac = '', exp = '0'] = m;
    const digits = BigInt(`${whole}${frac}`);
    let scale = frac.length - Number(exp);
    let units = sign === '-' ? -digits : digits;
    if (scale < 0) { units *= 10n ** BigInt(-scale); scale = 0; }
    return new Decimal(units, scale);
  }

  /** A finite JS number, through its shortest round-trip text. Returns null for NaN, Infinity or a non-number. */
  static fromNumber(value: unknown): Decimal | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    return Decimal.parse(String(value));
  }

  static of(units: number | bigint): Decimal { return new Decimal(BigInt(units), 0); }

  private align(other: Decimal): [bigint, bigint, number] {
    const scale = Math.max(this.scale, other.scale);
    return [this.units * 10n ** BigInt(scale - this.scale), other.units * 10n ** BigInt(scale - other.scale), scale];
  }

  add(other: Decimal): Decimal { const [a, b, s] = this.align(other); return new Decimal(a + b, s); }
  sub(other: Decimal): Decimal { const [a, b, s] = this.align(other); return new Decimal(a - b, s); }
  mul(other: Decimal): Decimal { return new Decimal(this.units * other.units, this.scale + other.scale); }
  abs(): Decimal { return new Decimal(this.units < 0n ? -this.units : this.units, this.scale); }
  /** -1, 0 or 1. */
  cmp(other: Decimal): number { const [a, b] = this.align(other); return a < b ? -1 : a > b ? 1 : 0; }
  lte(other: Decimal): boolean { return this.cmp(other) <= 0; }
  gte(other: Decimal): boolean { return this.cmp(other) >= 0; }
  gt(other: Decimal): boolean { return this.cmp(other) > 0; }
  isZero(): boolean { return this.units === 0n; }
  isNegative(): boolean { return this.units < 0n; }

  /** Canonical decimal text with trailing fractional zeros removed (`2.50` -> `2.5`, `-0` -> `0`). */
  toString(): string {
    const negative = this.units < 0n;
    let digits = (negative ? -this.units : this.units).toString().padStart(this.scale + 1, '0');
    let text = this.scale === 0 ? digits : `${digits.slice(0, digits.length - this.scale)}.${digits.slice(digits.length - this.scale)}`;
    if (text.includes('.')) text = text.replace(/0+$/, '').replace(/\.$/, '');
    return negative && text !== '0' ? `-${text}` : text;
  }
}
