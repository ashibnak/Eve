import type { platformV1 } from '@eve/contracts';

/** What org shows of a person next to a position: code, Persian name, employed on the date. */
export interface PersonCard {
  personnelCode: string;
  name: { first: string; last: string };
  employed: boolean;
}

/**
 * Port (ADR-004), in org's own terms: the people behind assignments. Implemented by an adapter
 * over the people module's public service.
 */
export interface PeopleDirectoryPort {
  /** Cards of the people of a company among `personIds` the caller may read (others missing). */
  cards(
    companyId: string,
    personIds: readonly string[],
    asOf: platformV1.BusinessDate,
  ): Promise<ReadonlyMap<string, PersonCard>>;
  /** Who is employed on `asOf` (null `personIds` = the whole company). Ids only, no personal data. */
  employed(
    companyId: string,
    personIds: readonly string[] | null,
    asOf: platformV1.BusinessDate,
  ): Promise<ReadonlySet<string>>;
  /** The caller's own person in a company, through their login link; null when unlinked. */
  me(companyId: string): Promise<string | null>;
  companyOf(personId: string): Promise<string | null>;
  /** Person ids by personnel code in a company (structure import). */
  idsByPersonnelCode(companyId: string): Promise<ReadonlyMap<string, string>>;
}

export const PEOPLE_DIRECTORY_PORT = Symbol('org.PeopleDirectoryPort');
