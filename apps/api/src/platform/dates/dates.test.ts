import { describe, expect, it } from 'vitest';
import { businessDateIn, isValidTimeZone } from './dates';

describe('businessDateIn', () => {
  // 2026-11-22T21:00Z is already 2026-11-23 in Tehran (UTC+03:30).
  const lateEvening = new Date('2026-11-22T21:00:00.000Z');

  it('uses the given zone, not UTC', () => {
    expect(businessDateIn(lateEvening, 'Asia/Tehran')).toBe('2026-11-23');
    expect(businessDateIn(lateEvening, 'UTC')).toBe('2026-11-22');
  });
});

describe('isValidTimeZone', () => {
  it.each(['UTC', 'Asia/Tehran', 'Asia/Dubai'])('accepts %s', (zone) => {
    expect(isValidTimeZone(zone)).toBe(true);
  });

  it.each(['Tehran', 'Mars/Base', ''])('rejects %s', (zone) => {
    expect(isValidTimeZone(zone)).toBe(false);
  });
});
