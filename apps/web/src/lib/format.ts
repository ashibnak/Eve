import { fromBusinessDate, toBusinessDate } from '@eve/jurisdiction-ir';
import type { platformV1 } from '@eve/contracts';
import { currentLocale } from '../i18n/t';
import { toAsciiDigits } from '../api';

export type IsoDate = platformV1.BusinessDate;

/** Today as a business date in the customer's zone (R1 customers are in Iran). */
export function todayIso(now: Date = new Date()): IsoDate {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tehran',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  return parts as IsoDate;
}

/** A business date for people: "۲ آذر ۱۴۰۵" in Persian (Jalali), "22 Nov 2026" in English. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(`${iso}T12:00:00Z`);
  return new Intl.DateTimeFormat(currentLocale === 'fa' ? 'fa-IR-u-ca-persian' : 'en-GB', {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(date);
}

/** The short Jalali form people type, e.g. ۱۴۰۵/۰۹/۰۱ (Persian digits in Persian). */
export function formatDateInput(iso: IsoDate): string {
  if (currentLocale !== 'fa') return iso;
  const { year, month, day } = fromBusinessDate(iso);
  return toPersianDigits(
    `${year}/${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}`,
  );
}

/**
 * What a person typed into a date field, as a business date: Jalali (1405/09/01, 1405-9-1,
 * Persian digits allowed) or ISO (2026-11-22). Null when it is not a real date.
 */
export function parseDateInput(text: string): IsoDate | null {
  const ascii = toAsciiDigits(text.trim()).replace(/[٫,]/g, '/');
  const match = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(ascii);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < 1700) {
    try {
      return toBusinessDate({ year, month, day });
    } catch {
      return null;
    }
  }
  const iso = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const check = new Date(`${iso}T00:00:00Z`);
  return check.toISOString().slice(0, 10) === iso ? (iso as IsoDate) : null;
}

const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

export function toPersianDigits(text: string): string {
  return text.replace(/\d/g, (d) => PERSIAN_DIGITS[Number(d)] ?? d);
}

/** A number for people: Persian digits with ٬ and ٫ in Persian. */
export function formatNumber(value: number, fractionDigits = 0): string {
  return new Intl.NumberFormat(currentLocale === 'fa' ? 'fa-IR' : 'en-US', {
    maximumFractionDigits: fractionDigits,
  }).format(value);
}

/** Shifts a business date by whole days. */
export function addDays(iso: IsoDate, days: number): IsoDate {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10) as IsoDate;
}
