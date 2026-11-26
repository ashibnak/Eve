import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { orgV1, platformV1 } from '@eve/contracts';
import ExcelJS from 'exceljs';
import { ConfigService } from '../../../../platform/config/config.service';
import { TimeZoneSetting } from '../../../../platform/config/settings';
import { Clock } from '../../../../platform/context/clock';
import { currentActor } from '../../../../platform/context/request-context';
import { businessDateIn } from '../../../../platform/dates/dates';
import { type Locale, type MessageKey, renderMessage } from '../../../../platform/i18n/messages';
import { AccessService, type ResolvedScope } from '../../../../platform/scope/access.service';
import { ScopedDb } from '../../../../platform/scope/scoped-db';
import { dayOf } from '../model/period';
import { OrgChangeApproverRole, OrgPermissions } from '../org.permissions';
import { PEOPLE_DIRECTORY_PORT, type PeopleDirectoryPort } from '../ports/people-directory.port';
import { OrgService } from './org.service';

const covers = (scope: ResolvedScope, companyId: string) =>
  scope.customerWide || scope.companyIds.has(companyId);

/**
 * Reads the web UI needs besides the agent tools (S9): the companies a caller works in and what
 * they may do there, a position's dated history, and the positions table as an Excel file.
 */
@Injectable()
export class OrgWorkspace {
  constructor(
    private readonly db: ScopedDb,
    private readonly access: AccessService,
    private readonly org: OrgService,
    private readonly config: ConfigService,
    private readonly clock: Clock,
    @Inject(PEOPLE_DIRECTORY_PORT) private readonly people: PeopleDirectoryPort,
  ) {}

  /** Companies with an org profile the caller reads (by role or as a linked person). */
  async companies(): Promise<orgV1.CompanyWorkspace[]> {
    const actor = currentActor();
    if (!actor) throw new UnauthorizedException();
    const permissions = {
      readStructure: OrgPermissions.read,
      manageFindings: OrgPermissions.manageFindings,
      importStructure: OrgPermissions.importStructure,
      requestChange: OrgPermissions.requestChange,
      correct: OrgPermissions.correct,
      manageCompany: OrgPermissions.manageCompany,
    } as const;
    const scopes = Object.fromEntries(
      await Promise.all(
        Object.entries(permissions).map(
          async ([k, p]) => [k, await this.access.scopeFor(actor, p)] as const,
        ),
      ),
    ) as Record<keyof typeof permissions, ResolvedScope>;
    const grants = await this.access.grantsOf(actor);
    const linked = new Set(await this.people.myCompanies());
    const profiles = await this.db.afterOwnCheck().orgCompany.findMany({
      select: { companyId: true, nameFa: true, nameEn: true, codePrefix: true },
      orderBy: { nameFa: 'asc' },
    });
    const result: orgV1.CompanyWorkspace[] = [];
    for (const p of profiles) {
      const can = {
        readStructure: covers(scopes.readStructure, p.companyId),
        manageFindings: covers(scopes.manageFindings, p.companyId),
        importStructure: covers(scopes.importStructure, p.companyId),
        requestChange: covers(scopes.requestChange, p.companyId),
        correct: covers(scopes.correct, p.companyId),
        approveChange: grants.some(
          (g) =>
            g.role === OrgChangeApproverRole.name &&
            (g.scopeKind === 'customer' || g.companyId === p.companyId),
        ),
        manageCompany: covers(scopes.manageCompany, p.companyId),
      };
      if (!Object.values(can).some(Boolean) && !linked.has(p.companyId)) continue;
      result.push({
        ...p,
        myPersonId: linked.has(p.companyId) ? await this.people.me(p.companyId) : null,
        can,
      });
    }
    return result;
  }

  /** A position's versions, lines and assignments over time (null when it does not exist). */
  async history(positionId: string): Promise<orgV1.PositionHistory | null> {
    const identity = await this.db.afterOwnCheck().orgPosition.findUnique({
      where: { id: positionId },
      select: { companyId: true, code: true },
    });
    if (!identity) return null;
    const db = await this.db.forCompany(OrgPermissions.read, identity.companyId);
    const [versions, lines, assignments] = await Promise.all([
      db.orgPositionVersion.findMany({ where: { positionId }, orderBy: { validFrom: 'asc' } }),
      db.orgReportingLine.findMany({
        where: { fromPositionId: positionId },
        include: { toPosition: { select: { code: true } } },
        orderBy: { validFrom: 'asc' },
      }),
      db.orgAssignment.findMany({ where: { positionId }, orderBy: { validFrom: 'asc' } }),
    ]);
    const unitIds = [...new Set(versions.map((v) => v.unitId))];
    const units = await db.orgUnitVersion.findMany({
      where: { unitId: { in: unitIds } },
      select: { unitId: true, nameFa: true, validFrom: true },
      orderBy: { validFrom: 'desc' },
    });
    const unitName = new Map<string, string>();
    for (const u of units) if (!unitName.has(u.unitId)) unitName.set(u.unitId, u.nameFa);
    const today = await this.today();
    const cards = await this.people.cards(
      identity.companyId,
      [...new Set(assignments.map((a) => a.personId))],
      today,
    );
    const day = (d: Date | null) => (d ? dayOf(d) : null);
    return {
      positionId,
      code: identity.code,
      versions: versions.map((v) => ({
        validFrom: dayOf(v.validFrom),
        validTo: day(v.validTo),
        legacyCode: v.legacyCode,
        title: { fa: v.titleFa, en: v.titleEn },
        unitId: v.unitId,
        unitName: unitName.get(v.unitId) ?? null,
        type: v.type as orgV1.PositionView['type'],
        fte: v.fte.toNumber(),
        supervisory: v.supervisory,
        status: v.status as orgV1.PositionView['status'],
        source: v.source as orgV1.PositionView['source'],
      })),
      lines: lines.map((l) => ({
        kind: l.kind as orgV1.LineKind,
        toPositionId: l.toPositionId,
        toCode: l.toPosition.code,
        validFrom: dayOf(l.validFrom),
        validTo: day(l.validTo),
      })),
      assignments: assignments.map((a) => {
        const card = cards.get(a.personId);
        return {
          personId: a.personId,
          personnelCode: card?.personnelCode ?? null,
          name: card?.name ?? null,
          kind: a.kind as orgV1.AssignmentKind,
          timeShare: a.timeShare.toNumber(),
          source: a.source,
          orderNumber: a.orderNumber,
          validFrom: dayOf(a.validFrom),
          validTo: day(a.validTo),
        };
      }),
    };
  }

  /** The positions table of a company as of a date, as an .xlsx file (same columns as the UI). */
  async positionsWorkbook(
    companyId: string,
    asOf?: platformV1.BusinessDate,
    locale: Locale = 'fa',
  ): Promise<Buffer> {
    const structure = await this.org.getStructure({ companyId, ...(asOf ? { asOf } : {}) });
    const unitOf = new Map(structure.units.map((u) => [u.id, u]));
    const codeOf = new Map(structure.positions.map((p) => [p.id, p.code]));
    const m = (key: string) =>
      renderMessage(`org.export.positions.${key}` as MessageKey, {}, locale);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(m('sheet'), { views: [{ rightToLeft: locale === 'fa' }] });
    sheet.addRow(
      [
        'code',
        'legacy',
        'title',
        'unit_code',
        'unit',
        'type',
        'fte',
        'supervisory',
        'status',
        'source',
        'occupancy',
        'incumbents',
        'reports_to',
        'as_of',
      ].map(m),
    );
    for (const p of structure.positions) {
      const unit = unitOf.get(p.unitId);
      sheet.addRow([
        p.code,
        p.legacyCode ?? '',
        locale === 'fa' ? p.title.fa : (p.title.en ?? p.title.fa),
        unit?.code ?? '',
        locale === 'fa' ? (unit?.name.fa ?? '') : (unit?.name.en ?? unit?.name.fa ?? ''),
        p.type,
        p.fte,
        m(p.supervisory ? 'yes' : 'no'),
        p.status,
        p.source,
        p.occupancy,
        p.incumbentCount,
        p.reportsToPositionId ? (codeOf.get(p.reportsToPositionId) ?? '') : '',
        structure.asOf,
      ]);
    }
    sheet.getRow(1).font = { bold: true };
    return Buffer.from(await workbook.xlsx.writeBuffer());
  }

  private async today(): Promise<platformV1.BusinessDate> {
    return businessDateIn(this.clock.now(), await this.config.get(TimeZoneSetting));
  }
}
