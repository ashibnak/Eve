import { z } from 'zod';

/** A point in time, always UTC, serialized as ISO-8601 with `Z`. Stored as `timestamptz`. */
export const InstantSchema = z.iso.datetime({ offset: false }).brand<'Instant'>();
export type Instant = z.infer<typeof InstantSchema>;

/**
 * A calendar date without time or zone (`YYYY-MM-DD`, Gregorian), e.g. an effective date.
 * Stored as Postgres `date`. Displayed in the user's calendar (Jalali for `fa`).
 */
export const BusinessDateSchema = z.iso.date().brand<'BusinessDate'>();
export type BusinessDate = z.infer<typeof BusinessDateSchema>;
