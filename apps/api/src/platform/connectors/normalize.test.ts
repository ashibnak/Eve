import { jurisdiction as ir } from '@eve/jurisdiction-ir';
import { describe, expect, it } from 'vitest';
import {
  normalizeCode,
  normalizeText,
  parseBoolean,
  parseDate,
  parseNumber,
  toAsciiDigits,
} from './normalize';

describe('normalizeText', () => {
  it('turns Arabic yeh and kaf into Persian', () => {
    expect(normalizeText('علي كريمي')).toBe('علی کریمی');
  });

  it('keeps ZWNJ inside words, drops stray marks and extra spaces', () => {
    expect(normalizeText('  می‌رود‏   خانه​ ')).toBe('می‌رود خانه');
    expect(normalizeText('‌کتاب‌')).toBe('کتاب');
  });
});

describe('codes and numbers', () => {
  it('converts Persian and Arabic-Indic digits', () => {
    expect(toAsciiDigits('۱۲۳٤٥٦')).toBe('123456');
    expect(normalizeCode(' ۱۲ ۳۴ ')).toBe('1234');
  });

  it('reads numbers with separators and rejects text', () => {
    expect(parseNumber('۱٬۲۵۰٬۰۰۰')).toBe(1_250_000);
    expect(parseNumber('0.5')).toBe(0.5);
    expect(parseNumber('۰٫۵')).toBe(0.5);
    expect(parseNumber(12)).toBe(12);
    expect(parseNumber('دوازده')).toBeNull();
  });

  it('reads yes/no in Persian and English', () => {
    expect(parseBoolean('بله')).toBe(true);
    expect(parseBoolean('خیر')).toBe(false);
    expect(parseBoolean('YES')).toBe(true);
    expect(parseBoolean(0)).toBe(false);
    expect(parseBoolean('شاید')).toBeNull();
  });
});

describe('parseDate', () => {
  const cal = ir.calendar;

  it('reads Jalali dates in the company calendar, with Persian digits', () => {
    expect(parseDate('1405/09/01', cal)).toBe('2026-11-22');
    expect(parseDate('۱۴۰۵/۹/۱', cal)).toBe('2026-11-22');
    expect(parseDate('1403-12-30', cal)).toBe('2025-03-20');
  });

  it('reads ISO dates and Excel date cells', () => {
    expect(parseDate('2026-11-22', cal)).toBe('2026-11-22');
    expect(parseDate(new Date(Date.UTC(2026, 10, 22)), cal)).toBe('2026-11-22');
  });

  it('rejects dates that do not exist or are not dates', () => {
    expect(parseDate('1404/12/30', cal)).toBeNull(); // 1404 is not a leap year
    expect(parseDate('2026-02-30', cal)).toBeNull();
    expect(parseDate('دیروز', cal)).toBeNull();
    expect(parseDate('22/11/2026', cal)).toBeNull();
  });
});
