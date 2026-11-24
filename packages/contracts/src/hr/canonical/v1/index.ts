import { z } from 'zod';
import { BusinessDateSchema } from '../../../platform/v1/dates.js';

/**
 * HR canonical model (ADR-011): what every connector turns source data into, and the only shape
 * HR modules read from imports. Kept in an HR contract package, not the platform, so the platform
 * stays domain-free (ADR-001).
 *
 * Fields come only from the Module 1 spec (§3) and the R1 people core (build plan S4). Value lists
 * the spec does not define yet (employment status, unit level, position status...) stay open
 * strings until the product owner fixes them (S4/S7). Within v1 only additive changes are allowed.
 */

/** Names are multilingual; Persian is required for Iranian customers (a customer setting later). */
export const LocalizedNameSchema = z.object({
  fa: z.string().min(1),
  en: z.string().min(1).optional(),
});

export const PersonRecordSchema = z.object({
  personnelCode: z.string().min(1),
  name: z.object({
    first: LocalizedNameSchema,
    last: LocalizedNameSchema,
  }),
  hireDate: BusinessDateSchema,
  employmentStatus: z.string().min(1),
  /** Channel kind and address for messages (e.g. Bale), when known. */
  contact: z.object({ channel: z.string().min(1), address: z.string().min(1) }).optional(),
});
export type PersonRecord = z.infer<typeof PersonRecordSchema>;

export const UnitRecordSchema = z.object({
  /** The company's own code, kept for matching imports and old reports. */
  legacyCode: z.string().min(1),
  name: LocalizedNameSchema,
  level: z.string().min(1),
  /** Legacy code of the parent unit; absent for the company's root unit. */
  parentLegacyCode: z.string().min(1).optional(),
  costCenter: z.string().min(1).optional(),
  location: z.string().min(1).optional(),
});
export type UnitRecord = z.infer<typeof UnitRecordSchema>;

export const PositionRecordSchema = z.object({
  legacyCode: z.string().min(1),
  title: LocalizedNameSchema,
  unitLegacyCode: z.string().min(1),
  /** Approved, project or temporary (spec §3); values fixed in S7. */
  type: z.string().min(1),
  fte: z.number().positive().max(1),
  supervisory: z.boolean(),
  /** Direct reporting line, by the other position's legacy code; absent for the top position. */
  reportsToLegacyCode: z.string().min(1).optional(),
  status: z.string().min(1),
});
export type PositionRecord = z.infer<typeof PositionRecordSchema>;

export const AssignmentRecordSchema = z.object({
  personnelCode: z.string().min(1),
  positionLegacyCode: z.string().min(1),
  /** Primary, acting, temporary supervision or project (spec §3); values fixed in S7. */
  kind: z.string().min(1),
  timeShare: z.number().positive().max(1),
  validFrom: BusinessDateSchema,
});
export type AssignmentRecord = z.infer<typeof AssignmentRecordSchema>;
