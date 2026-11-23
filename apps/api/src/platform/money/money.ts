import { type platformV1 } from '@eve/contracts';

type Money = platformV1.Money;
type CurrencyCode = platformV1.CurrencyCode;

/**
 * Minor units per major unit, as a power of ten. ISO 4217, except the Iranian rial: ADR-010 fixes
 * its scale at 0 (amounts are whole rials). Add a currency here before it can be used.
 */
const CURRENCY_SCALE: Readonly<Record<string, number>> = {
  IRR: 0,
  AED: 2,
  EUR: 2,
  USD: 2,
};

export function currencyScale(currency: string): number {
  const scale = CURRENCY_SCALE[currency];
  if (scale === undefined) throw new Error(`Unsupported currency ${currency}`);
  return scale;
}

export function money(amountMinor: bigint, currency: string): Money {
  currencyScale(currency);
  return { amountMinor, currency: currency as CurrencyCode };
}

/**
 * How to round a result that falls between two minor units. Always explicit: the choice is a
 * business rule of the caller (rule template), never a library default.
 */
export type RoundingMode = 'half_up' | 'half_even' | 'down' | 'up' | 'floor' | 'ceiling';

function sameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency)
    throw new Error(`Currency mismatch: ${a.currency} vs ${b.currency}`);
}

export function add(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return { amountMinor: a.amountMinor + b.amountMinor, currency: a.currency };
}

export function subtract(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return { amountMinor: a.amountMinor - b.amountMinor, currency: a.currency };
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  sameCurrency(a, b);
  return a.amountMinor < b.amountMinor ? -1 : a.amountMinor > b.amountMinor ? 1 : 0;
}

/** `numerator / denominator` rounded to an integer with an explicit mode (bigint, exact). */
export function divideRounded(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  if (denominator === 0n) throw new RangeError('Division by zero');
  if (denominator < 0n) return divideRounded(-numerator, -denominator, mode);
  const quotient = numerator / denominator; // truncates toward zero
  const remainder = numerator % denominator;
  if (remainder === 0n) return quotient;
  const negative = numerator < 0n;
  const awayFromZero = negative ? quotient - 1n : quotient + 1n;
  const twiceRemainder = (remainder < 0n ? -remainder : remainder) * 2n;
  switch (mode) {
    case 'down':
      return quotient;
    case 'up':
      return awayFromZero;
    case 'floor':
      return negative ? quotient - 1n : quotient;
    case 'ceiling':
      return negative ? quotient : quotient + 1n;
    case 'half_up':
      return twiceRemainder >= denominator ? awayFromZero : quotient;
    case 'half_even':
      if (twiceRemainder > denominator) return awayFromZero;
      if (twiceRemainder < denominator) return quotient;
      return quotient % 2n === 0n ? quotient : awayFromZero;
  }
}

/** `amount × numerator / denominator`, e.g. a 7.5 % raise is `multiplyRatio(m, 75n, 1000n, …)`. */
export function multiplyRatio(
  m: Money,
  numerator: bigint,
  denominator: bigint,
  mode: RoundingMode,
): Money {
  return {
    amountMinor: divideRounded(m.amountMinor * numerator, denominator, mode),
    currency: m.currency,
  };
}

/**
 * Splits an amount by integer weights so the parts add up exactly to the whole (largest
 * remainder; ties go to the earlier part).
 */
export function allocate(m: Money, weights: readonly bigint[]): Money[] {
  if (weights.length === 0 || weights.some((w) => w < 0n))
    throw new RangeError('Weights must be non-negative');
  const total = weights.reduce((sum, w) => sum + w, 0n);
  if (total === 0n) throw new RangeError('Weights must not all be zero');
  const sign = m.amountMinor < 0n ? -1n : 1n;
  const amount = m.amountMinor * sign;
  const shares = weights.map((w) => (amount * w) / total);
  const remainders = weights.map((w, i) => ({ i, r: (amount * w) % total }));
  let left = amount - shares.reduce((sum, s) => sum + s, 0n);
  remainders.sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  for (const { i } of remainders) {
    if (left === 0n) break;
    shares[i] = (shares[i] as bigint) + 1n;
    left -= 1n;
  }
  return shares.map((s) => ({ amountMinor: s * sign, currency: m.currency }));
}

/** Parses a major-unit decimal (`"1250.50"`) exactly; more decimals than the scale is an error. */
export function fromMajor(decimal: string, currency: string): Money {
  const scale = currencyScale(currency);
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(decimal.trim());
  if (!match) throw new Error(`Not a decimal amount: ${decimal}`);
  const [, sign, whole, fraction = ''] = match;
  if (fraction.length > scale)
    throw new Error(`${currency} allows at most ${scale} decimals: ${decimal}`);
  const minor = BigInt(`${whole}${fraction.padEnd(scale, '0')}`);
  return money(sign === '-' ? -minor : minor, currency);
}

/** Major-unit decimal string, e.g. `"1250.50"`; exact. */
export function toMajor(m: Money): string {
  const scale = currencyScale(m.currency);
  const negative = m.amountMinor < 0n;
  const digits = (negative ? -m.amountMinor : m.amountMinor).toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const fraction = scale > 0 ? `.${digits.slice(-scale)}` : '';
  return `${negative ? '-' : ''}${whole}${fraction}`;
}

/** Display text in a locale, e.g. `fa` → `۱۲٬۵۰۰٬۰۰۰ ریال`. Exact for any size (no Number). */
export function formatMoney(m: Money, locale: string): string {
  const scale = currencyScale(m.currency);
  const format = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: m.currency,
    minimumFractionDigits: scale,
    maximumFractionDigits: scale,
  });
  // Intl accepts exact decimal strings, so no precision is lost on large amounts.
  return format.format(toMajor(m) as unknown as number);
}
