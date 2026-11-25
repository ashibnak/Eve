import { z } from 'zod';
import { BusinessDateSchema } from '../../platform/v1/dates.js';

/**
 * `people` module contract, v1 (ADR-003): the person register of R1 (ADR-008). Within v1 only
 * additive changes are allowed; a breaking change is v2 alongside v1.
 */

/**
 * Employment status (product-owner decision, S4). `on_leave` is still employed: it counts as
 * active for org (rule R7, get_manager).
 */
export const EmploymentStatusSchema = z.enum(['active', 'on_leave', 'suspended', 'terminated']);
export type EmploymentStatus = z.infer<typeof EmploymentStatusSchema>;

export const ACTIVE_STATUSES: readonly EmploymentStatus[] = ['active', 'on_leave'];

export function isActiveStatus(status: EmploymentStatus | null): boolean {
  return status !== null && ACTIVE_STATUSES.includes(status);
}

export const ContactChannelSchema = z.enum(['bale', 'sms']);

export const PersonViewSchema = z.object({
  id: z.uuid(),
  companyId: z.uuid(),
  /** Unique within the company (not across the group). */
  personnelCode: z.string(),
  name: z.object({
    first: z.object({ fa: z.string(), en: z.string().nullable() }),
    last: z.object({ fa: z.string(), en: z.string().nullable() }),
  }),
  hireDate: BusinessDateSchema,
  /** Status on `asOf`; null when the register has no status for that date (before the first load). */
  status: EmploymentStatusSchema.nullable(),
  asOf: BusinessDateSchema,
  contact: z.object({ channel: ContactChannelSchema, address: z.string() }).nullable(),
});
export type PersonView = z.infer<typeof PersonViewSchema>;

/** Options of every read: the business date to answer for (default: today in the customer's zone). */
export interface AsOfOptions {
  asOf?: z.infer<typeof BusinessDateSchema>;
}

/** `getMany` options: with `companyId`, only people of that company (and a faster read). */
export interface GetManyOptions extends AsOfOptions {
  companyId?: string;
}

/**
 * The public read service other modules call through their own port (ADR-004). Every call is
 * limited to the scope of the user (or the agent's user) making it.
 */
export interface PeopleReadService {
  getPerson(id: string, options?: AsOfOptions): Promise<PersonView | null>;
  findByPersonnelCode(
    companyId: string,
    personnelCode: string,
    options?: AsOfOptions,
  ): Promise<PersonView | null>;
  listActive(companyId: string, options?: AsOfOptions): Promise<PersonView[]>;
  /** The people among `ids` the caller may read; the others are left out (added in S5). */
  getMany(ids: readonly string[], options?: GetManyOptions): Promise<PersonView[]>;
}

/**
 * Lookups for other modules that reveal no personal data, only ids and yes/no answers (S5): the
 * caller's own person, whether people are employed on a date, a person's company.
 */
export interface PeopleDirectoryService {
  myPersonId(companyId: string): Promise<string | null>;
  /** Ids of people employed (active or on leave) on `asOf`; null `personIds` = whole company. */
  employedAmong(
    companyId: string,
    personIds: readonly string[] | null,
    asOf: z.infer<typeof BusinessDateSchema>,
  ): Promise<ReadonlySet<string>>;
  companyOf(personId: string): Promise<string | null>;
  /** Person ids of a company by personnel code (for imports that refer to people; S7). */
  idsByPersonnelCode(companyId: string): Promise<ReadonlyMap<string, string>>;
}

/** Event `people.person.created@1`. */
export const PersonCreatedPayload = z.object({
  person_id: z.uuid(),
  personnel_code: z.string(),
  status: EmploymentStatusSchema,
});

/** Event `people.person.status_changed@1`; `effective_at` of the envelope is the change date. */
export const PersonStatusChangedPayload = z.object({
  person_id: z.uuid(),
  personnel_code: z.string(),
  from: EmploymentStatusSchema.nullable(),
  to: EmploymentStatusSchema,
});

/**
 * Field sensitivity for the model gateway (CLAUDE.md rule 13): sensitive values never reach an
 * external model; internal ones only without names.
 */
export const PERSON_FIELD_SENSITIVITY = {
  id: 'internal',
  companyId: 'internal',
  personnelCode: 'internal',
  name: 'sensitive',
  hireDate: 'internal',
  status: 'internal',
  contact: 'sensitive',
  asOf: 'public',
} as const satisfies Record<keyof PersonView, 'public' | 'internal' | 'sensitive'>;
