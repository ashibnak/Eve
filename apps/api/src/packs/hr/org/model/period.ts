import type { platformV1 } from '@eve/contracts';

/** A business date as the Date Prisma uses for `date` columns (UTC midnight). */
export const dateOf = (day: platformV1.BusinessDate) => new Date(`${day}T00:00:00Z`);
export const dayOf = (date: Date) => date.toISOString().slice(0, 10) as platformV1.BusinessDate;

/** Rows whose [valid_from, valid_to) contains `day`. */
export function validOn(day: Date) {
  return { validFrom: { lte: day }, OR: [{ validTo: null }, { validTo: { gt: day } }] };
}
