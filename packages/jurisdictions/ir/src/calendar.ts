import type { platformV1 } from '@eve/contracts';

/**
 * Persian (Jalali, Solar Hijri) calendar, the official calendar of Iran.
 *
 * Conversion via Julian Day Numbers with the leap-year "breaks" table of the widely used
 * jalaali algorithm (Kazimierz M. Borkowski), which follows the official astronomical calendar for
 * years -61 to 3177 SH. Verified against ICU's `persian` calendar for every day of 1300-1500 SH.
 */

const BREAKS = [
  -61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192, 2262, 2324, 2394,
  2456, 3178,
];

const div = (a: number, b: number) => Math.trunc(a / b);
const mod = (a: number, b: number) => a - Math.trunc(a / b) * b;

interface YearInfo {
  /** 0 for a leap year, 1-4 otherwise (years since the last leap year). */
  leap: number;
  /** Gregorian year in which this Jalali year starts. */
  gy: number;
  /** Day of March on which Farvardin 1 falls. */
  march: number;
}

function yearInfo(jy: number): YearInfo {
  const last = BREAKS[BREAKS.length - 1] as number;
  let jp = BREAKS[0] as number;
  if (!Number.isInteger(jy) || jy < jp || jy >= last)
    throw new RangeError(`Jalali year ${jy} out of range`);
  const gy = jy + 621;
  let leapJ = -14;
  let jump = 0;
  for (let i = 1; i < BREAKS.length; i += 1) {
    const jm = BREAKS[i] as number;
    jump = jm - jp;
    if (jy < jm) break;
    leapJ += div(jump, 33) * 8 + div(mod(jump, 33), 4);
    jp = jm;
  }
  let n = jy - jp;
  leapJ += div(n, 33) * 8 + div(mod(n, 33) + 3, 4);
  if (mod(jump, 33) === 4 && jump - n === 4) leapJ += 1;
  const leapG = div(gy, 4) - div((div(gy, 100) + 1) * 3, 4) - 150;
  const march = 20 + leapJ - leapG;
  if (jump - n < 6) n = n - jump + div(jump + 4, 33) * 33;
  let leap = mod(mod(n + 1, 33) - 1, 4);
  if (leap === -1) leap = 4;
  return { leap, gy, march };
}

/** Gregorian date to Julian Day Number. */
function gregorianToJdn(gy: number, gm: number, gd: number): number {
  let d =
    div((gy + div(gm - 8, 6) + 100100) * 1461, 4) +
    div(153 * mod(gm + 9, 12) + 2, 5) +
    gd -
    34840408;
  d = d - div(div(gy + 100100 + div(gm - 8, 6), 100) * 3, 4) + 752;
  return d;
}

/** Julian Day Number to Gregorian date. */
function jdnToGregorian(jdn: number): { gy: number; gm: number; gd: number } {
  let j = 4 * jdn + 139361631;
  j = j + div(div(4 * jdn + 183187720, 146097) * 3, 4) * 4 - 3908;
  const i = div(mod(j, 1461), 4) * 5 + 308;
  const gd = div(mod(i, 153), 5) + 1;
  const gm = mod(div(i, 153), 12) + 1;
  const gy = div(j, 1461) - 100100 + div(8 - gm, 6);
  return { gy, gm, gd };
}

function jalaliToJdn(jy: number, jm: number, jd: number): number {
  const info = yearInfo(jy);
  return gregorianToJdn(info.gy, 3, info.march) + (jm - 1) * 31 - div(jm, 7) * (jm - 7) + jd - 1;
}

function jdnToJalali(jdn: number): platformV1.CalendarDate {
  const { gy } = jdnToGregorian(jdn);
  let jy = gy - 621;
  const info = yearInfo(jy);
  let k = jdn - gregorianToJdn(gy, 3, info.march);
  if (k >= 0) {
    if (k <= 185) return { year: jy, month: 1 + div(k, 31), day: mod(k, 31) + 1 };
    k -= 186;
  } else {
    jy -= 1;
    k += 179;
    if (info.leap === 1) k += 1;
  }
  return { year: jy, month: 7 + div(k, 30), day: mod(k, 30) + 1 };
}

export function isLeapYear(jy: number): boolean {
  return yearInfo(jy).leap === 0;
}

export function daysInMonth(jy: number, jm: number): number {
  if (!Number.isInteger(jm) || jm < 1 || jm > 12)
    throw new RangeError(`Jalali month ${jm} out of range`);
  if (jm <= 6) return 31;
  if (jm <= 11) return 30;
  return isLeapYear(jy) ? 30 : 29;
}

function parseBusinessDate(date: string): { gy: number; gm: number; gd: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new RangeError(`Not a business date: ${date}`);
  return { gy: Number(match[1]), gm: Number(match[2]), gd: Number(match[3]) };
}

function formatBusinessDate(gy: number, gm: number, gd: number): platformV1.BusinessDate {
  const pad = (n: number, width: number) => String(n).padStart(width, '0');
  return `${pad(gy, 4)}-${pad(gm, 2)}-${pad(gd, 2)}` as platformV1.BusinessDate;
}

export function fromBusinessDate(date: platformV1.BusinessDate): platformV1.CalendarDate {
  const { gy, gm, gd } = parseBusinessDate(date);
  return jdnToJalali(gregorianToJdn(gy, gm, gd));
}

export function toBusinessDate(date: platformV1.CalendarDate): platformV1.BusinessDate {
  if (
    !Number.isInteger(date.day) ||
    date.day < 1 ||
    date.day > daysInMonth(date.year, date.month)
  ) {
    throw new RangeError(
      `${date.year}/${date.month}/${date.day} does not exist in the Persian calendar`,
    );
  }
  const { gy, gm, gd } = jdnToGregorian(jalaliToJdn(date.year, date.month, date.day));
  return formatBusinessDate(gy, gm, gd);
}

export const persianCalendar: platformV1.JurisdictionCalendar = {
  id: 'persian',
  fromBusinessDate,
  toBusinessDate,
  daysInMonth,
  monthRange(year, month) {
    const from = toBusinessDate({ year, month, day: 1 });
    const next =
      month === 12 ? { year: year + 1, month: 1, day: 1 } : { year, month: month + 1, day: 1 };
    return { from, to: toBusinessDate(next) };
  },
};
