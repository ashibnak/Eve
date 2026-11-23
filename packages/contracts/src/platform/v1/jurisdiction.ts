import type { z } from 'zod';
import type { BusinessDate } from './dates.js';
import type { CurrencyCode } from './money.js';

/** A date in a jurisdiction's official calendar (e.g. Persian/Jalali for `ir`). */
export interface CalendarDate {
  readonly year: number;
  /** 1-based. */
  readonly month: number;
  readonly day: number;
}

/**
 * A jurisdiction's official calendar. Business data is stored as Gregorian `BusinessDate`s;
 * the calendar converts for display, input and calendar-based periods (e.g. a Jalali month).
 */
export interface JurisdictionCalendar {
  /** Unicode calendar id, e.g. `persian`, `gregory`. */
  readonly id: string;
  fromBusinessDate(date: BusinessDate): CalendarDate;
  /** Throws for a date that does not exist in the calendar. */
  toBusinessDate(date: CalendarDate): BusinessDate;
  daysInMonth(year: number, month: number): number;
  /** The Gregorian dates covered by a calendar month: `from` inclusive, `to` exclusive. */
  monthRange(year: number, month: number): { from: BusinessDate; to: BusinessDate };
}

/**
 * Everything country-specific behind one interface (ADR-010): calendar, defaults, and the legal
 * fields of a company. Later releases add law sources, insurance/tax tables and templates.
 */
export interface JurisdictionPack {
  /** ISO 3166-1 alpha-2, lower case. */
  readonly code: string;
  readonly defaultTimeZone: string;
  readonly defaultCurrency: CurrencyCode;
  readonly calendar: JurisdictionCalendar;
  /** Legal identity fields of a company in this jurisdiction, validated on input. */
  readonly companyLegalFields: z.ZodType;
}
