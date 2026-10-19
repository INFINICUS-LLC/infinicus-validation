// ISO 4217 minor-unit exponents: how many decimal places a currency's amounts have (USD 2, KWD 3, JPY 0).
//
// The codes below are the ones this platform knows; ANY OTHER CODE IS UNSUPPORTED and fails closed (no silent two-decimal default),
// because a wrong exponent silently mis-states money. To add a currency, add its code to the right list here AND in
// apps/web/lib/client/currency.ts (a test keeps the two tables identical).
//
// Amounts are stored as numeric(18,4), so every exponent up to 4 fits without a migration.

const EXP_0 =
  'BIF CLP DJF GNF ISK JPY KMF KRW PYG RWF UGX UYI VND VUV XAF XOF XPF';
const EXP_2 =
  'AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BMD BND BOB BRL BSD BTN BWP BYN BZD CAD CDF CHF CNY COP CRC CUP ' +
  'CVE CZK DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GTQ GYD HKD HNL HTG HUF IDR ILS INR IRR JMD KES KGS KHR ' +
  'KPW KYD KZT LAK LBP LKR LRD LSL MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD PAB PEN ' +
  'PGK PHP PKR PLN QAR RON RSD RUB SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SVC SYP SZL THB TJS TMT TOP TRY TTD TWD ' +
  'TZS UAH USD UZS VES WST XCD YER ZAR ZMW ZWL';
const EXP_3 =
  'BHD IQD JOD KWD LYD OMR TND';
const EXP_4 =
  'CLF UYW';

const EXPONENT = new Map<string, number>();
for (const [list, exponent] of [[EXP_0, 0], [EXP_2, 2], [EXP_3, 3], [EXP_4, 4]] as const) {
  for (const code of list.split(' ')) EXPONENT.set(code, exponent);
}

/** Decimal places of a currency, or null when the code is not a supported ISO 4217 code. */
export function minorUnitsOf(currencyCode: string): number | null {
  return EXPONENT.get(currencyCode) ?? null;
}

export class UnsupportedCurrencyError extends Error {
  constructor(currencyCode: string) {
    super(`currency ${currencyCode} is not a supported ISO 4217 code`);
    this.name = 'ConflictError';
  }
}

/**
 * Round a money amount to the currency's minor unit, half away from zero. The tiny relative correction makes 1.005 round to 1.01
 * (the binary value is 1.00499999999999989...). Throws for an unsupported currency.
 */
export function roundToCurrency(amount: number, currencyCode: string): number {
  const exponent = minorUnitsOf(currencyCode);
  if (exponent === null) throw new UnsupportedCurrencyError(currencyCode);
  if (!Number.isFinite(amount)) return 0;
  const factor = 10 ** exponent;
  const scaled = Math.abs(amount) * factor * (1 + Number.EPSILON);
  return (Math.sign(amount) * Math.round(scaled)) / factor;
}
