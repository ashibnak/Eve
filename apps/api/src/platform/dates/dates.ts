import type { platformV1 } from '@eve/contracts';

/** True for an IANA time zone this runtime knows, e.g. `Asia/Tehran`, `UTC`. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** The calendar date (Gregorian, `YYYY-MM-DD`) of an instant as seen in a time zone. */
export function businessDateIn(instant: Date, timeZone: string): platformV1.BusinessDate {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}` as platformV1.BusinessDate;
}
