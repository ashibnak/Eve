import type { platformV1 } from '@eve/contracts';

/**
 * Text cleanup for data typed in Iranian offices, applied to every imported cell:
 * - Arabic yeh/kaf (ي ى ك) become Persian (ی ک), so the same name always matches;
 * - zero-width and directional marks are removed, except ZWNJ (نیم‌فاصله) between letters;
 * - runs of whitespace collapse and the ends are trimmed.
 */
export function normalizeText(value: string): string {
  return value
    .replace(/[يى]/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[​‎‏‪-‮⁦-⁩﻿]/g, '')
    .replace(/(^|\s)‌+|‌+(?=\s|$)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Persian and Arabic-Indic digits to ASCII; also the Persian decimal and thousands separators. */
export function toAsciiDigits(value: string): string {
  return value
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/٫/g, '.')
    .replace(/[٬،]/g, ',');
}

/** A code (personnel code, legacy code): normalized text with ASCII digits and no spaces. */
export function normalizeCode(value: string): string {
  return toAsciiDigits(normalizeText(value)).replace(/\s/g, '');
}

/** A number written by people: Persian digits, thousands separators. Null if not a number. */
export function parseNumber(value: string | number): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = toAsciiDigits(normalizeText(value)).replace(/,/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
  return Number(text);
}

const TRUE_WORDS = new Set(['true', 'yes', 'y', '1', 'بله', 'بلی', 'آری', 'دارد', '✓']);
const FALSE_WORDS = new Set(['false', 'no', 'n', '0', 'خیر', 'نه', 'ندارد']);

export function parseBoolean(value: string | number | boolean): boolean | null {
  if (typeof value === 'boolean') return value;
  const text = toAsciiDigits(normalizeText(String(value))).toLowerCase();
  if (TRUE_WORDS.has(text)) return true;
  if (FALSE_WORDS.has(text)) return false;
  return null;
}

/**
 * A date as people write it: an Excel date cell, an ISO date (`2026-11-22`), or a date in the
 * company's calendar (`1405/09/01`, `1405-9-1`, Persian digits allowed). Years below 1700 are read
 * in the jurisdiction calendar. Null if it is not a valid date.
 */
export function parseDate(
  value: string | number | Date,
  calendar: platformV1.JurisdictionCalendar,
): platformV1.BusinessDate | null {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    // Excel stores dates as midnight UTC of the calendar day.
    return value.toISOString().slice(0, 10) as platformV1.BusinessDate;
  }
  const text = toAsciiDigits(normalizeText(String(value)));
  const match = /^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})$/.exec(text);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  try {
    if (year < 1700) return calendar.toBusinessDate({ year, month, day });
    const iso = `${match[1]}-${match[2]?.padStart(2, '0')}-${match[3]?.padStart(2, '0')}`;
    const date = new Date(`${iso}T00:00:00Z`);
    return date.toISOString().slice(0, 10) === iso ? (iso as platformV1.BusinessDate) : null;
  } catch {
    return null;
  }
}
