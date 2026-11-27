const DIGITS: Record<string, string> = {
  '۰': '0',
  '۱': '1',
  '۲': '2',
  '۳': '3',
  '۴': '4',
  '۵': '5',
  '۶': '6',
  '۷': '7',
  '۸': '8',
  '۹': '9',
  '٠': '0',
  '١': '1',
  '٢': '2',
  '٣': '3',
  '٤': '4',
  '٥': '5',
  '٦': '6',
  '٧': '7',
  '٨': '8',
  '٩': '9',
};

/**
 * A phone number as international digits without `+` (E.164 digits), or null if it does not look
 * like one. `countryCode` (from the jurisdiction pack) completes national forms:
 *   0912 345 6789, +98 912…, 0098912…, 98912…, ۰۹۱۲…  →  989123456789   (countryCode 98)
 */
export function normalizePhone(raw: string, countryCode: string): string | null {
  const ascii = raw.replace(/[۰-۹٠-٩]/g, (d) => DIGITS[d]!).trim();
  if (!/^\+?[0-9\s\-().]+$/.test(ascii)) return null;
  const plus = ascii.startsWith('+');
  let digits = ascii.replace(/\D/g, '');
  if (plus) {
    // Already international.
  } else if (digits.startsWith('00')) {
    digits = digits.slice(2);
  } else if (digits.startsWith('0')) {
    digits = countryCode + digits.slice(1);
  } else if (!digits.startsWith(countryCode)) {
    // A national number written without its leading 0 (e.g. 912…).
    digits = countryCode + digits;
  }
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}
