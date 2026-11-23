/**
 * Iran jurisdiction pack (ADR-010). Country-specific calendar, legal fields, law,
 * insurance/tax tables and document templates live here, never in modules.
 */
import type { platformV1 } from '@eve/contracts';
import { persianCalendar } from './calendar.js';
import { IranCompanyLegalFields } from './legal-fields.js';

export {
  daysInMonth,
  fromBusinessDate,
  isLeapYear,
  persianCalendar,
  toBusinessDate,
} from './calendar.js';
export { IranCompanyLegalFields, isValidLegalNationalId } from './legal-fields.js';

export const jurisdiction: platformV1.JurisdictionPack = {
  code: 'ir',
  defaultTimeZone: 'Asia/Tehran',
  // ADR-010: the rial, scale 0.
  defaultCurrency: 'IRR' as platformV1.CurrencyCode,
  calendar: persianCalendar,
  companyLegalFields: IranCompanyLegalFields,
};
