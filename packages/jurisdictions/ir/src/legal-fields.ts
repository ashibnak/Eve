import { z } from 'zod';

/**
 * Checks the national ID of a legal entity (شناسهٔ ملی اشخاص حقوقی): 11 digits whose last
 * digit is a check digit over the first ten, weighted 29, 27, 23, 19, 17 (repeating) after adding
 * (tenth digit + 2) to each digit, modulo 11 (10 counts as 0). Digits 4-9 cannot all be zero.
 */
export function isValidLegalNationalId(value: string): boolean {
  if (!/^\d{11}$/.test(value)) return false;
  if (Number(value.slice(3, 9)) === 0) return false;
  const digits = [...value].map(Number);
  const offset = (digits[9] as number) + 2;
  const weights = [29, 27, 23, 19, 17];
  let sum = 0;
  for (let i = 0; i < 10; i += 1)
    sum += ((digits[i] as number) + offset) * (weights[i % 5] as number);
  const check = sum % 11 === 10 ? 0 : sum % 11;
  return digits[10] === check;
}

/**
 * Legal identity of a company in Iran (product-owner decision, S1): the national ID and the
 * social-security workshop code (کد کارگاه تأمین اجتماعی), both required.
 */
export const IranCompanyLegalFields = z.object({
  nationalId: z
    .string()
    .refine(
      isValidLegalNationalId,
      'Invalid legal-entity national ID (11 digits with check digit)',
    ),
  ssoWorkshopCode: z
    .string()
    .regex(/^\d{10}$/, 'Social-security workshop code must be exactly 10 digits'),
});
export type IranCompanyLegalFields = z.infer<typeof IranCompanyLegalFields>;
