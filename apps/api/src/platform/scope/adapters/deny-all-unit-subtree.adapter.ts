import type { UnitSubtreePort } from '../ports/unit-subtree.port';

/** Used until a module registers the structure: no unit is known, so a unit grant sees nothing. */
export class DenyAllUnitSubtreeAdapter implements UnitSubtreePort {
  unitIdsUnder(): Promise<string[]> {
    return Promise.resolve([]);
  }
}
