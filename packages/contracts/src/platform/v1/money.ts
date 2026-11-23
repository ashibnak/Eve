import { z } from 'zod';

/** ISO 4217 alphabetic code, e.g. `IRR`, `AED`, `EUR`. */
export const CurrencyCodeSchema = z
  .string()
  .regex(/^[A-Z]{3}$/, 'ISO 4217 code')
  .brand<'CurrencyCode'>();
export type CurrencyCode = z.infer<typeof CurrencyCodeSchema>;

/**
 * An amount of money (CLAUDE.md rule 7): an integer count of the currency's minor unit and the
 * currency. Never a bare number. The scale (minor units per major unit) comes from the currency
 * table; per ADR-010 the Iranian rial has scale 0.
 */
export interface Money {
  readonly amountMinor: bigint;
  readonly currency: CurrencyCode;
}

/**
 * JSON form: JSON has no bigint, so the amount travels as a decimal integer string.
 * `{"amountMinor":"125000000","currency":"IRR"}`
 */
export const MoneyJsonSchema = z.object({
  amountMinor: z.string().regex(/^-?\d+$/, 'integer amount in minor units'),
  currency: CurrencyCodeSchema,
});
export type MoneyJson = z.infer<typeof MoneyJsonSchema>;

export function moneyToJson(money: Money): MoneyJson {
  return { amountMinor: money.amountMinor.toString(), currency: money.currency };
}

export function moneyFromJson(json: unknown): Money {
  const parsed = MoneyJsonSchema.parse(json);
  return { amountMinor: BigInt(parsed.amountMinor), currency: parsed.currency };
}
