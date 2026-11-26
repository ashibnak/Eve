import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { orgV1, platformV1 } from '@eve/contracts';
import type { z } from 'zod';
import { AuditService } from '../../../../platform/audit/audit.service';
import { TxRunner } from '../../../../platform/context/tx-runner';
import { AccessService } from '../../../../platform/scope/access.service';
import { ScopedDb } from '../../../../platform/scope/scoped-db';
import { dateOf, dayOf } from '../model/period';
import { OrgPermissions } from '../org.permissions';
import { PEOPLE_DIRECTORY_PORT, type PeopleDirectoryPort } from '../ports/people-directory.port';
import { OrgRuleChecker } from '../rules/org-rule-checker';
import { buildSnapshot } from '../rules/snapshot';

type UnitCorrection = z.output<typeof orgV1.UnitCorrectionSchema>;
type PositionCorrection = z.output<typeof orgV1.PositionCorrectionSchema>;

/**
 * Data corrections (spec §8 "اصلاح داده"): the data owner fixes a wrong entry with a reason; no
 * organizational decision, so no approval and no events. The version is corrected in place for its
 * whole period (decision 2026-11-25); the audit log keeps what it said before, who, when and why.
 * The blocking rules still run on the result.
 */
@Injectable()
export class OrgCorrections {
  constructor(
    private readonly db: ScopedDb,
    private readonly access: AccessService,
    private readonly txRunner: TxRunner,
    private readonly audit: AuditService,
    private readonly checker: OrgRuleChecker,
    @Inject(PEOPLE_DIRECTORY_PORT) private readonly people: PeopleDirectoryPort,
  ) {}

  async correctUnit(unitId: string, input: UnitCorrection): Promise<{ corrected: true }> {
    const version = await this.db.afterOwnCheck().orgUnitVersion.findFirst({
      where: { unitId, validFrom: dateOf(input.versionFrom) },
    });
    if (!version) throw new NotFoundException(`Unit has no version starting ${input.versionFrom}`);
    await this.access.requireFor(OrgPermissions.correct, version.companyId);
    const c = input.changes;
    if (c.supervisorPositionId)
      await this.requirePosition(version.companyId, c.supervisorPositionId);
    if (c.levelId) {
      const level = await this.db.afterOwnCheck().orgUnitLevel.findFirst({
        where: { id: c.levelId, companyId: version.companyId },
      });
      if (!level) throw new ConflictException('Unknown unit level');
    }
    const before = pick(version, Object.keys(c));
    await this.txRunner.run(async (tx) => {
      await tx.orgUnitVersion.update({ where: { id: version.id }, data: c });
      await this.audit.record(tx, {
        action: 'org.unit.correct',
        entityType: 'org_unit',
        entityId: unitId,
        companyId: version.companyId,
        before: { versionFrom: input.versionFrom, ...before },
        after: {
          versionFrom: input.versionFrom,
          ...c,
          state: { versionFrom: input.versionFrom, changes: c },
        },
        reason: input.reason,
      });
    });
    return { corrected: true };
  }

  async correctPosition(
    positionId: string,
    input: PositionCorrection,
  ): Promise<{ corrected: true }> {
    const version = await this.db.afterOwnCheck().orgPositionVersion.findFirst({
      where: { positionId, validFrom: dateOf(input.versionFrom) },
    });
    if (!version)
      throw new NotFoundException(`Position has no version starting ${input.versionFrom}`);
    await this.access.requireFor(OrgPermissions.correct, version.companyId);
    const c = input.changes;
    if (c.supervisory !== undefined && c.supervisory !== version.supervisory) {
      // Making a position supervisory may give it two primary incumbents (R15): check first. The
      // database trigger checks the version's whole period again on update.
      const asOf = dayOf(version.validFrom) as platformV1.BusinessDate;
      const before = await buildSnapshot(
        this.db.afterOwnCheck(),
        this.people,
        version.companyId,
        asOf,
      );
      const after = {
        ...before,
        positions: before.positions.map((p) =>
          p.id === positionId ? { ...p, supervisory: c.supervisory! } : p,
        ),
      };
      const result = await this.checker.checkChange(before, after);
      if (!result.ok) {
        throw new ConflictException(
          `The correction breaks ${result.violations.map((v) => `${v.code} (${v.key})`).join(', ')}`,
        );
      }
    }
    const previous = pick(version, Object.keys(c));
    await this.txRunner.run(async (tx) => {
      await tx.orgPositionVersion.update({
        where: { id: version.id },
        data: { ...c, ...(c.fte !== undefined ? { fte: String(c.fte) } : {}) },
      });
      await this.audit.record(tx, {
        action: 'org.position.correct',
        entityType: 'org_position',
        entityId: positionId,
        companyId: version.companyId,
        before: { versionFrom: input.versionFrom, ...previous },
        after: {
          versionFrom: input.versionFrom,
          ...c,
          state: { versionFrom: input.versionFrom, changes: c },
        },
        reason: input.reason,
      });
    });
    return { corrected: true };
  }

  private async requirePosition(companyId: string, positionId: string): Promise<void> {
    const found = await this.db.afterOwnCheck().orgPosition.findFirst({
      where: { id: positionId, companyId },
      select: { id: true },
    });
    if (!found) throw new ConflictException('Unknown position');
  }
}

function pick(row: object, keys: string[]): Record<string, unknown> {
  const record = row as Record<string, unknown>;
  return Object.fromEntries(
    keys.map((k) => {
      const v = record[k];
      return [
        k,
        v && typeof v === 'object' && 'toNumber' in v
          ? (v as { toNumber(): number }).toNumber()
          : v,
      ];
    }),
  );
}
