import { describe, expect, it } from 'vitest';
import { canonicalJson, toCanonicalValue } from './canonical-json';

describe('canonicalJson', () => {
  it('sorts keys recursively and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[{"y":2,"z":1}]},"b":1}',
    );
  });

  it('encodes bigint as string and Date as ISO', () => {
    expect(
      canonicalJson({ amount: 12345678901234567890n, at: new Date(Date.UTC(2026, 10, 22)) }),
    ).toBe('{"amount":"12345678901234567890","at":"2026-11-22T00:00:00.000Z"}');
  });

  it('is stable after a storage round-trip', () => {
    const stored = toCanonicalValue({ b: [1, { y: null, x: 'ف' }], a: 1.5 });
    expect(canonicalJson(stored)).toBe(canonicalJson({ a: 1.5, b: [1, { x: 'ف', y: null }] }));
  });

  it('rejects non-finite numbers', () => {
    expect(() => canonicalJson({ x: Number.NaN })).toThrow();
  });
});
