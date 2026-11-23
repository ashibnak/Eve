import { describe, expect, it } from 'vitest';
import { IranCompanyLegalFields, isValidLegalNationalId } from './legal-fields.js';

describe('legal-entity national ID', () => {
  it.each(['10380284790', '14007650912'])('accepts %s', (id) => {
    expect(isValidLegalNationalId(id)).toBe(true);
  });

  it.each([
    ['wrong check digit', '10380284791'],
    ['one digit changed', '10380284890'],
    ['too short', '1038028479'],
    ['too long', '103802847900'],
    ['not digits', '1038028479a'],
    ['Persian digits (normalize before validating)', '۱۰۳۸۰۲۸۴۷۹۰'],
    ['zero middle block', '10300000000'],
  ])('rejects %s', (_label, id) => {
    expect(isValidLegalNationalId(id)).toBe(false);
  });
});

describe('Iran company legal fields', () => {
  it('requires a valid national ID and a 10-digit workshop code', () => {
    expect(
      IranCompanyLegalFields.safeParse({ nationalId: '10380284790', ssoWorkshopCode: '1234567890' })
        .success,
    ).toBe(true);
    expect(
      IranCompanyLegalFields.safeParse({ nationalId: '10380284790', ssoWorkshopCode: '123456789' })
        .success,
    ).toBe(false);
    expect(
      IranCompanyLegalFields.safeParse({ nationalId: '10380284791', ssoWorkshopCode: '1234567890' })
        .success,
    ).toBe(false);
    expect(IranCompanyLegalFields.safeParse({ nationalId: '10380284790' }).success).toBe(false);
  });
});
