import { describe, expect, it } from 'vitest';
import {
  add,
  allocate,
  compare,
  currencyScale,
  divideRounded,
  formatMoney,
  fromMajor,
  money,
  multiplyRatio,
  type RoundingMode,
  subtract,
  toMajor,
} from './money';

const irr = (n: bigint) => money(n, 'IRR');

describe('currencies', () => {
  it('uses scale 0 for the rial (ADR-010) and 2 for others', () => {
    expect(currencyScale('IRR')).toBe(0);
    expect(currencyScale('AED')).toBe(2);
  });

  it('refuses unknown currencies', () => {
    expect(() => money(1n, 'XYZ')).toThrow('Unsupported currency');
  });
});

describe('arithmetic', () => {
  it('adds, subtracts and compares within one currency', () => {
    expect(add(irr(1_000n), irr(250n))).toEqual(irr(1_250n));
    expect(subtract(irr(1_000n), irr(250n))).toEqual(irr(750n));
    expect(compare(irr(1n), irr(2n))).toBe(-1);
  });

  it('never mixes currencies', () => {
    expect(() => add(irr(1n), money(1n, 'AED'))).toThrow('Currency mismatch');
  });

  it('stays exact beyond Number.MAX_SAFE_INTEGER', () => {
    const big = irr(9_007_199_254_740_993n);
    expect(add(big, irr(1n)).amountMinor).toBe(9_007_199_254_740_994n);
  });
});

describe('rounding', () => {
  // value ×2 so halves are exact: 5/2=2.5, 7/2=3.5, -5/2=-2.5, 3/2=1.5
  it.each<[RoundingMode, bigint, bigint, bigint, bigint]>([
    ['half_up', 3n, 4n, -3n, 2n],
    ['half_even', 2n, 4n, -2n, 2n],
    ['down', 2n, 3n, -2n, 1n],
    ['up', 3n, 4n, -3n, 2n],
    ['floor', 2n, 3n, -3n, 1n],
    ['ceiling', 3n, 4n, -2n, 2n],
  ])('%s: 2.5→%s 3.5→%s -2.5→%s 1.5→%s', (mode, a, b, c, d) => {
    expect(divideRounded(5n, 2n, mode)).toBe(a);
    expect(divideRounded(7n, 2n, mode)).toBe(b);
    expect(divideRounded(-5n, 2n, mode)).toBe(c);
    expect(divideRounded(3n, 2n, mode)).toBe(d);
  });

  it('applies a percentage with an explicit rounding mode', () => {
    // 7.5 % of 123,456,789 rials = 9,259,259.175
    expect(multiplyRatio(irr(123_456_789n), 75n, 1000n, 'half_up')).toEqual(irr(9_259_259n));
    expect(multiplyRatio(irr(123_456_789n), 75n, 1000n, 'up')).toEqual(irr(9_259_260n));
  });

  it('rejects division by zero', () => {
    expect(() => divideRounded(1n, 0n, 'half_up')).toThrow(RangeError);
  });
});

describe('allocate', () => {
  it('splits exactly, remainders to the largest fractions', () => {
    const parts = allocate(irr(100n), [1n, 1n, 1n]);
    expect(parts.map((p) => p.amountMinor)).toEqual([34n, 33n, 33n]);
    expect(parts.reduce((s, p) => s + p.amountMinor, 0n)).toBe(100n);
  });

  it('keeps the sign and the total for negative amounts', () => {
    const parts = allocate(irr(-10n), [3n, 7n]);
    expect(parts.map((p) => p.amountMinor)).toEqual([-3n, -7n]);
  });

  it('rejects invalid weights', () => {
    expect(() => allocate(irr(1n), [])).toThrow();
    expect(() => allocate(irr(1n), [0n, 0n])).toThrow();
    expect(() => allocate(irr(1n), [-1n, 2n])).toThrow();
  });
});

describe('major units', () => {
  it('parses and prints exactly', () => {
    expect(fromMajor('1250.5', 'AED')).toEqual(money(125_050n, 'AED'));
    expect(toMajor(money(125_050n, 'AED'))).toBe('1250.50');
    expect(toMajor(money(-5n, 'AED'))).toBe('-0.05');
    expect(fromMajor('125000000', 'IRR')).toEqual(irr(125_000_000n));
  });

  it('refuses more decimals than the currency has', () => {
    expect(() => fromMajor('10.5', 'IRR')).toThrow('at most 0 decimals');
    expect(() => fromMajor('1.005', 'AED')).toThrow();
    expect(() => fromMajor('1,000', 'IRR')).toThrow();
  });

  it('formats for display without losing digits', () => {
    expect(formatMoney(irr(12_500_000n), 'fa')).toContain('۱۲٬۵۰۰٬۰۰۰');
    expect(formatMoney(irr(123_456_789_012_345_678n), 'en')).toContain('123,456,789,012,345,678');
  });
});
