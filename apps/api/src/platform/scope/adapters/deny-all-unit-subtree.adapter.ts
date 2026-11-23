import type { UnitSubtreePort } from '../ports/unit-subtree.port';

/** R1 adapter until `org` exists: no unit is known, so a unit-scoped grant sees nothing. */
export class DenyAllUnitSubtreeAdapter implements UnitSubtreePort {
  unitIdsUnder(): Promise<string[]> {
    return Promise.resolve([]);
  }
}
