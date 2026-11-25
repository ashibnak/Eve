import type { platformV1 } from '@eve/contracts';

/**
 * Port (ADR-004), in people's own terms: who is in the team a person leads. A team lead reads the
 * people of their team (product-owner decision 2026-11-25). Implemented by an adapter over org.
 */
export interface TeamPort {
  /**
   * People of `companyId` in positions below the supervisory position(s) `leadPersonId` holds
   * (primary, acting or temporary supervision) on `asOf`, along direct lines. Empty when none.
   */
  membersLedBy(
    companyId: string,
    leadPersonId: string,
    asOf: platformV1.BusinessDate,
  ): Promise<ReadonlySet<string>>;
}

export const TEAM_PORT = Symbol('people.TeamPort');
