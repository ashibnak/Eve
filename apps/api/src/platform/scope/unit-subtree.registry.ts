import type { platformV1 } from '@eve/contracts';
import { DenyAllUnitSubtreeAdapter } from './adapters/deny-all-unit-subtree.adapter';
import type { UnitSubtreePort } from './ports/unit-subtree.port';

/**
 * The platform's unit-subtree port, delegating to whichever module owns the structure. The org
 * pack registers its adapter at start-up (the platform never imports packs, ADR-001). Until then,
 * or in a deployment without org, it denies: unit-scoped grants see nothing.
 */
export class UnitSubtreeRegistry implements UnitSubtreePort {
  private delegate: UnitSubtreePort = new DenyAllUnitSubtreeAdapter();
  private registered = false;

  use(adapter: UnitSubtreePort): void {
    if (this.registered && this.delegate !== adapter) {
      throw new Error('A unit-subtree adapter is already registered');
    }
    this.delegate = adapter;
    this.registered = true;
  }

  unitIdsUnder(
    companyId: string,
    unitId: string,
    asOf: platformV1.BusinessDate,
  ): Promise<string[]> {
    return this.delegate.unitIdsUnder(companyId, unitId, asOf);
  }
}
