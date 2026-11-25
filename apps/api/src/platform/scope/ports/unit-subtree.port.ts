import type { platformV1 } from '@eve/contracts';

/**
 * Port: which org units lie in the subtree under a unit on a given date (CLAUDE.md rule 11).
 * Defined by the platform in its own terms; `org` registers its implementation in the
 * `UnitSubtreeRegistry`. Without one the deny-all adapter answers "none" (fail closed).
 */
export interface UnitSubtreePort {
  /** The unit itself plus every unit below it, as of `asOf`. Empty when unknown. */
  unitIdsUnder(companyId: string, unitId: string, asOf: platformV1.BusinessDate): Promise<string[]>;
}

export const UNIT_SUBTREE_PORT = Symbol('UnitSubtreePort');
