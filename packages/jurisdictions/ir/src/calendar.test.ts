import type { platformV1 } from '@eve/contracts';
import { describe, expect, it } from 'vitest';
import {
  daysInMonth,
  fromBusinessDate,
  isLeapYear,
  persianCalendar,
  toBusinessDate,
} from './calendar.js';

const day = (iso: string) => iso as platformV1.BusinessDate;

/** ICU's Persian calendar as the independent reference. */
const icu = new Intl.DateTimeFormat('en-US-u-ca-persian-nu-latn', {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  timeZone: 'UTC',
});
function icuJalali(date: Date): platformV1.CalendarDate {
  const parts = Object.fromEntries(icu.formatToParts(date).map((p) => [p.type, p.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

describe('Persian calendar', () => {
  it.each([
    ['2026-11-22', { year: 1405, month: 9, day: 1 }], // 1 Azar 1405
    ['2025-03-20', { year: 1403, month: 12, day: 30 }], // 30 Esfand 1403 (leap year)
    ['2025-03-21', { year: 1404, month: 1, day: 1 }], // Nowruz 1404
    ['1979-02-11', { year: 1357, month: 11, day: 22 }],
  ])('%s is %j', (iso, jalali) => {
    expect(fromBusinessDate(day(iso))).toEqual(jalali);
    expect(toBusinessDate(jalali)).toBe(iso);
  });

  it('matches ICU and round-trips for every day of 1300-1500 SH', () => {
    const start = Date.UTC(1921, 2, 21); // 1 Farvardin 1300
    const end = Date.UTC(2122, 2, 21); // after 29/30 Esfand 1500
    let checked = 0;
    for (let t = start; t < end; t += 86_400_000) {
      const iso = day(new Date(t).toISOString().slice(0, 10));
      const jalali = fromBusinessDate(iso);
      expect(jalali).toEqual(icuJalali(new Date(t)));
      expect(toBusinessDate(jalali)).toBe(iso);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(73_000);
  }, 60_000);

  it('knows leap years and month lengths', () => {
    expect(isLeapYear(1403)).toBe(true);
    expect(isLeapYear(1404)).toBe(false);
    expect(daysInMonth(1405, 1)).toBe(31);
    expect(daysInMonth(1405, 7)).toBe(30);
    expect(daysInMonth(1403, 12)).toBe(30);
    expect(daysInMonth(1404, 12)).toBe(29);
  });

  it('rejects dates that do not exist', () => {
    expect(() => toBusinessDate({ year: 1404, month: 12, day: 30 })).toThrow(RangeError);
    expect(() => toBusinessDate({ year: 1405, month: 7, day: 31 })).toThrow(RangeError);
    expect(() => toBusinessDate({ year: 1405, month: 13, day: 1 })).toThrow(RangeError);
    expect(() => fromBusinessDate(day('2026-1-1'))).toThrow(RangeError);
  });

  it('gives a month as a half-open Gregorian range', () => {
    expect(persianCalendar.monthRange(1405, 9)).toEqual({ from: '2026-11-22', to: '2026-12-22' });
    expect(persianCalendar.monthRange(1403, 12)).toEqual({ from: '2025-02-19', to: '2025-03-21' });
  });
});
