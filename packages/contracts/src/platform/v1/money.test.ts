import { describe, expect, it } from 'vitest';
import { type CurrencyCode, moneyFromJson, moneyToJson } from './money.js';

describe('Money JSON', () => {
  it('round-trips amounts beyond Number.MAX_SAFE_INTEGER', () => {
    const money = { amountMinor: 123_456_789_012_345_678_901n, currency: 'IRR' as CurrencyCode };
    const json = moneyToJson(money);
    expect(json).toEqual({ amountMinor: '123456789012345678901', currency: 'IRR' });
    expect(moneyFromJson(JSON.parse(JSON.stringify(json)))).toEqual(money);
  });

  it.each([
    [{ amountMinor: 12.5, currency: 'IRR' }],
    [{ amountMinor: '12.5', currency: 'IRR' }],
    [{ amountMinor: '100', currency: 'rial' }],
    [{ amountMinor: '100' }],
  ])('rejects %j', (json) => {
    expect(() => moneyFromJson(json)).toThrow();
  });
});
