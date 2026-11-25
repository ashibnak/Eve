import type { platformV1 } from '@eve/contracts';
import type { UnitSubtreePort } from '../../../../platform/scope/ports/unit-subtree.port';
import type { ScopedDb } from '../../../../platform/scope/scoped-db';
import { dateOf, validOn } from '../model/period';

/**
 * The platform's unit-subtree port (CLAUDE.md rule 11), answered from org's unit tree. It runs
 * while the platform resolves a caller's scope, so it reads the tree without scope filtering and
 * returns unit ids only.
 */
export class OrgUnitSubtreeAdapter implements UnitSubtreePort {
  constructor(private readonly db: ScopedDb) {}

  async unitIdsUnder(
    companyId: string,
    unitId: string,
    asOf: platformV1.BusinessDate,
  ): Promise<string[]> {
    const units = await this.db.afterOwnCheck().orgUnitVersion.findMany({
      where: { companyId, ...validOn(dateOf(asOf)) },
      select: { unitId: true, parentUnitId: true },
    });
    if (!units.some((u) => u.unitId === unitId)) return [];
    const children = new Map<string, string[]>();
    for (const u of units) {
      if (!u.parentUnitId) continue;
      children.set(u.parentUnitId, [...(children.get(u.parentUnitId) ?? []), u.unitId]);
    }
    const found = new Set([unitId]);
    const queue = [unitId];
    for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
      for (const child of children.get(id) ?? []) {
        if (found.has(child)) continue;
        found.add(child);
        queue.push(child);
      }
    }
    return [...found];
  }
}
