import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { orgV1 } from '@eve/contracts';
import type { z } from 'zod';
import { toCanonicalValue } from '../../../../platform/audit/canonical-json';
import { AuditService } from '../../../../platform/audit/audit.service';
import { Clock } from '../../../../platform/context/clock';
import { TxRunner } from '../../../../platform/context/tx-runner';
import { JurisdictionRegistry } from '../../../../platform/jurisdiction/jurisdiction.registry';
import { AccessService } from '../../../../platform/scope/access.service';
import { ScopedDb } from '../../../../platform/scope/scoped-db';
import { OrgPermissions } from '../org.permissions';

export interface OrgProfileView {
  companyId: string;
  nameFa: string;
  nameEn: string | null;
  codePrefix: string;
  legalFields: Record<string, unknown>;
  levels: z.infer<typeof orgV1.UnitLevelSchema>[];
}

/**
 * A company's org profile and unit levels (spec §3, §12), set by the system administrator before
 * the first structure import (product-owner decision 2026-11-25). The code prefix is fixed once a
 * system code exists; a level in use is renamed or moved, never removed.
 */
@Injectable()
export class OrgProfileService {
  constructor(
    private readonly db: ScopedDb,
    private readonly access: AccessService,
    private readonly txRunner: TxRunner,
    private readonly audit: AuditService,
    private readonly jurisdictions: JurisdictionRegistry,
    private readonly clock: Clock,
  ) {}

  async register(
    companyId: string,
    input: orgV1.OrgProfileInput,
    reason: string,
  ): Promise<OrgProfileView> {
    await this.access.requireFor(OrgPermissions.manageCompany, companyId);
    const company = await this.db.afterOwnCheck().coreCompany.findUnique({
      where: { id: companyId },
      select: { jurisdictionCode: true },
    });
    if (!company) throw new NotFoundException('Company not found');
    const legal = this.jurisdictions
      .get(company.jurisdictionCode)
      .companyLegalFields.safeParse(input.legalFields);
    if (!legal.success) {
      throw new BadRequestException(
        `Legal fields: ${legal.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
      );
    }
    const legalFields = toCanonicalValue(legal.data) as Record<string, unknown>;
    await this.txRunner.run(async (tx) => {
      const before = await tx.orgCompany.findUnique({ where: { companyId } });
      const now = this.clock.now();
      if (before && before.codePrefix !== input.codePrefix) {
        if (before.nextUnitNo > 1 || before.nextPositionNo > 1) {
          throw new ConflictException('The code prefix is fixed once system codes exist');
        }
      }
      const clash = await tx.orgCompany.findFirst({
        where: { codePrefix: input.codePrefix, companyId: { not: companyId } },
        select: { companyId: true },
      });
      if (clash) throw new ConflictException(`Code prefix ${input.codePrefix} is in use`);
      const data = {
        nameFa: input.nameFa,
        nameEn: input.nameEn ?? null,
        codePrefix: input.codePrefix,
        legalFields: legalFields as object,
        updatedAt: now,
      };
      const after = before
        ? await tx.orgCompany.update({ where: { companyId }, data })
        : await tx.orgCompany.create({ data: { ...data, companyId, createdAt: now } });
      await this.audit.record(tx, {
        action: before ? 'org.company.profile.change' : 'org.company.profile.create',
        entityType: 'org_company',
        entityId: companyId,
        companyId,
        before: before ? profileFields(before) : null,
        after: profileFields(after),
        reason,
      });
    });
    return this.view(companyId);
  }

  /** Replaces the ordered level list: existing levels by id (all of them), new ones without. */
  async setLevels(
    companyId: string,
    levels: z.infer<typeof orgV1.UnitLevelsInputSchema>,
    reason: string,
  ): Promise<OrgProfileView> {
    await this.access.requireFor(OrgPermissions.manageCompany, companyId);
    await this.txRunner.run(async (tx) => {
      if (
        !(await tx.orgCompany.findUnique({ where: { companyId }, select: { companyId: true } }))
      ) {
        throw new ConflictException('Register the org profile first');
      }
      const existing = await tx.orgUnitLevel.findMany({
        where: { companyId },
        orderBy: { rank: 'asc' },
      });
      const given = new Set(levels.flatMap((l) => (l.id ? [l.id] : [])));
      const unknown = [...given].filter((id) => !existing.some((e) => e.id === id));
      if (unknown.length > 0)
        throw new BadRequestException(`Unknown level id(s): ${unknown.join(', ')}`);
      const missing = existing.filter((e) => !given.has(e.id));
      if (missing.length > 0) {
        throw new ConflictException(
          `Levels are never removed; keep ${missing.map((m) => m.nameFa).join('، ')}`,
        );
      }
      const names = levels.map((l) => l.nameFa);
      if (new Set(names).size !== names.length) throw new BadRequestException('Level names repeat');
      // Ranks are unique per company: move existing ones out of the way, then set the final order.
      for (const level of existing) {
        await tx.orgUnitLevel.update({
          where: { id: level.id },
          data: { rank: level.rank + 1000 },
        });
      }
      for (const [index, level] of levels.entries()) {
        const data = { nameFa: level.nameFa, nameEn: level.nameEn ?? null, rank: index + 1 };
        if (level.id) await tx.orgUnitLevel.update({ where: { id: level.id }, data });
        else await tx.orgUnitLevel.create({ data: { ...data, companyId } });
      }
      await this.audit.record(tx, {
        action: 'org.company.levels.set',
        entityType: 'org_company',
        entityId: companyId,
        companyId,
        before: existing.map((e) => ({
          id: e.id,
          nameFa: e.nameFa,
          nameEn: e.nameEn,
          rank: e.rank,
        })),
        after: levels.map((l, i) => ({
          id: l.id ?? null,
          nameFa: l.nameFa,
          nameEn: l.nameEn ?? null,
          rank: i + 1,
        })),
        reason,
      });
    });
    return this.view(companyId);
  }

  /** The profile and levels, for whoever may read the structure or manage the company. */
  async get(companyId: string): Promise<OrgProfileView | null> {
    const actorCanManage = await this.access
      .requireFor(OrgPermissions.manageCompany, companyId)
      .then(() => true)
      .catch(() => false);
    if (!actorCanManage) await this.access.requireFor(OrgPermissions.read, companyId);
    return this.view(companyId).catch((e: unknown) => {
      if (e instanceof NotFoundException) return null;
      throw e;
    });
  }

  private async view(companyId: string): Promise<OrgProfileView> {
    const db = this.db.afterOwnCheck();
    const [company, levels] = await Promise.all([
      db.orgCompany.findUnique({ where: { companyId } }),
      db.orgUnitLevel.findMany({ where: { companyId }, orderBy: { rank: 'asc' } }),
    ]);
    if (!company) throw new NotFoundException('No org profile for this company');
    return {
      ...profileFields(company),
      companyId,
      levels: levels.map((l) => ({ id: l.id, nameFa: l.nameFa, nameEn: l.nameEn, rank: l.rank })),
    };
  }
}

function profileFields(row: {
  nameFa: string;
  nameEn: string | null;
  codePrefix: string;
  legalFields: unknown;
}) {
  return {
    nameFa: row.nameFa,
    nameEn: row.nameEn,
    codePrefix: row.codePrefix,
    legalFields: row.legalFields as Record<string, unknown>,
  };
}
