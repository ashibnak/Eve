import { randomUUID } from 'node:crypto';
import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../../../../platform/audit/audit.service';
import { Clock } from '../../../../platform/context/clock';
import {
  defineImportTarget,
  type Finding,
  type ImportContext,
  type ImportTarget,
  type StagedRow,
} from '../../../../platform/connectors/import-target';
import { type Tx } from '../../../../platform/context/tx-runner';
import { type EventDefinition } from '../../../../platform/events/event-registry';
import { RuleRuntime } from '../../../../platform/rules/rule-runtime';
import { ScopedDb } from '../../../../platform/scope/scoped-db';
import {
  AssignmentStarted,
  ManagerChanged,
  PositionChanged,
  PositionCreated,
} from '../events/org.events';
import { OrgEventSink } from '../events/org-event-sink';
import { dateOf } from '../model/period';
import { OrgChangeApproverRole, OrgPermissions } from '../org.permissions';
import { PEOPLE_DIRECTORY_PORT, type PeopleDirectoryPort } from '../ports/people-directory.port';
import { daysBetween, type Violations } from '../rules/common';
import { ORG_RULES } from '../rules/index';
import { managerChanges } from '../rules/managers';
import { buildSnapshot } from '../rules/snapshot';
import {
  AssignmentKindWords,
  loadCurrent,
  PositionStatusWords,
  PositionTypeWords,
  readFile,
} from './structure-model';
import { type ImportPlan, planImport } from './structure-plan';

const Share = z.number().positive().max(1);
/** Spec §5 R4: a re-import more than this many days back needs a change request. */
const REIMPORT_MAX_DAYS_BACK = 30;

/**
 * The structure import (spec §6, F1): three sheets (units, positions, assignments) through the S3
 * pipeline, matched by legacy codes; system codes are generated. The first load of a company is
 * committed by its data owner; a re-import changes a structure in use and is approved by the
 * structure-change approver (decision 2026-11-25). The file is the whole structure: units and
 * positions missing from it are closed (never a filled position); assignments missing from it are
 * reported and left to personnel actions. R1-R15 run on the structure that would result.
 */
@Injectable()
export class StructureImport {
  constructor(
    private readonly db: ScopedDb,
    private readonly audit: AuditService,
    private readonly runtime: RuleRuntime,
    private readonly events: OrgEventSink,
    private readonly clock: Clock,
    @Inject(PEOPLE_DIRECTORY_PORT) private readonly people: PeopleDirectoryPort,
  ) {}

  target(): ImportTarget {
    return defineImportTarget({
      name: 'org.structure',
      permission: OrgPermissions.importStructure,
      approvalChain: [OrgChangeApproverRole.name],
      needsApproval: async (ctx) =>
        (await this.db.afterOwnCheck().orgUnitVersion.findFirst({
          where: { companyId: ctx.companyId },
          select: { id: true },
        })) !== null,
      entities: [
        {
          name: 'unit',
          key: 'unitCode',
          fields: [
            {
              key: 'unitCode',
              kind: 'code',
              required: true,
              aliases: ['کد واحد', 'کد قدیمی واحد', 'Unit code'],
            },
            { key: 'nameFa', kind: 'text', required: true, aliases: ['نام واحد', 'عنوان واحد'] },
            {
              key: 'nameEn',
              kind: 'text',
              required: false,
              aliases: ['نام انگلیسی واحد', 'Unit name'],
            },
            { key: 'level', kind: 'text', required: true, aliases: ['سطح', 'سطح واحد', 'Level'] },
            {
              key: 'parentCode',
              kind: 'code',
              required: false,
              aliases: ['کد واحد والد', 'واحد والد', 'Parent unit'],
            },
            {
              key: 'costCenter',
              kind: 'text',
              required: false,
              aliases: ['مرکز هزینه', 'Cost center'],
            },
            {
              key: 'location',
              kind: 'text',
              required: false,
              aliases: ['محل کار', 'محل', 'Location'],
            },
            {
              key: 'supervisorPositionCode',
              kind: 'code',
              required: false,
              aliases: ['کد پست سرپرست', 'پست سرپرست', 'Supervisor position'],
            },
          ],
        },
        {
          name: 'position',
          key: 'positionCode',
          fields: [
            {
              key: 'positionCode',
              kind: 'code',
              required: true,
              aliases: ['کد پست', 'کد قدیمی پست', 'Position code'],
            },
            { key: 'titleFa', kind: 'text', required: true, aliases: ['عنوان پست', 'Title'] },
            {
              key: 'titleEn',
              kind: 'text',
              required: false,
              aliases: ['عنوان انگلیسی', 'Title (en)'],
            },
            { key: 'unitCode', kind: 'code', required: true, aliases: ['کد واحد', 'Unit code'] },
            {
              key: 'type',
              kind: 'text',
              required: true,
              schema: PositionTypeWords,
              aliases: ['نوع پست', 'Type'],
            },
            {
              key: 'fte',
              kind: 'number',
              required: false,
              schema: Share,
              aliases: ['سهم تمام‌وقت', 'FTE'],
            },
            {
              key: 'supervisory',
              kind: 'boolean',
              required: true,
              aliases: ['سرپرستی', 'پست سرپرستی', 'Supervisory'],
            },
            {
              key: 'reportsToCode',
              kind: 'code',
              required: false,
              aliases: ['کد پست بالادست', 'گزارش به', 'Reports to'],
            },
            {
              key: 'status',
              kind: 'text',
              required: false,
              schema: PositionStatusWords,
              aliases: ['وضعیت پست', 'وضعیت', 'Status'],
            },
          ],
        },
        {
          name: 'assignment',
          // A person may hold several assignments (e.g. primary and acting).
          key: ['personnelCode', 'positionCode', 'kind'],
          fields: [
            {
              key: 'personnelCode',
              kind: 'code',
              required: true,
              aliases: ['کد پرسنلی', 'شماره پرسنلی', 'Personnel code'],
            },
            {
              key: 'positionCode',
              kind: 'code',
              required: false,
              aliases: ['کد پست', 'Position code'],
            },
            { key: 'unitCode', kind: 'code', required: false, aliases: ['کد واحد', 'Unit code'] },
            {
              key: 'title',
              kind: 'text',
              required: false,
              aliases: ['عنوان', 'عنوان شغلی', 'Job title'],
            },
            {
              key: 'kind',
              kind: 'text',
              required: false,
              schema: AssignmentKindWords,
              aliases: ['نوع انتساب', 'Assignment kind'],
            },
            {
              key: 'timeShare',
              kind: 'number',
              required: false,
              schema: Share,
              aliases: ['سهم زمان', 'Time share'],
            },
          ],
        },
      ],
      validate: async (rows, ctx) => {
        const { plan, current } = await this.prepare(rows, ctx);
        const findings: Finding[] = [...plan.findings];
        if (!current.profile) {
          findings.push({
            severity: 'blocking',
            code: 'org.import.no_profile',
            message: 'The system administrator must register the org profile and unit levels first',
          });
        }
        if (
          current.hasStructure &&
          daysBetween(ctx.effectiveDate, ctx.today) > REIMPORT_MAX_DAYS_BACK
        ) {
          findings.push({
            severity: 'blocking',
            code: 'org.import.backdated',
            message: `A re-import more than ${REIMPORT_MAX_DAYS_BACK} days back is not allowed (R4); use a change request`,
          });
        }
        return [...findings, ...(await this.ruleFindings(plan, ctx))];
      },
      diff: async (rows, ctx) => (await this.prepare(rows, ctx)).plan.diff,
      commit: (tx, rows, _diff, ctx) => this.commit(tx, rows, ctx),
    });
  }

  private async prepare(rows: readonly StagedRow[], ctx: ImportContext) {
    const db = this.db.afterOwnCheck();
    const [current, personIds, employed] = await Promise.all([
      loadCurrent(db, ctx.companyId, ctx.effectiveDate),
      this.people.idsByPersonnelCode(ctx.companyId),
      this.people.employed(ctx.companyId, null, ctx.effectiveDate),
    ]);
    const plan = planImport({
      companyId: ctx.companyId,
      effectiveDate: ctx.effectiveDate,
      file: readFile(rows),
      current,
      personIds,
      employed,
    });
    return { plan, current, personIds };
  }

  /** R1-R15 on the structure the file would create: blocking ones stop the commit. */
  private async ruleFindings(plan: ImportPlan, ctx: ImportContext): Promise<Finding[]> {
    const label = new Map<string, string>();
    for (const [code, ref] of plan.unitRef) label.set(ref, `unit ${code}`);
    for (const [code, ref] of plan.positionRef) label.set(ref, `position ${code}`);
    const codeOfPerson = new Map<string, string>();
    const personIds = await this.people.idsByPersonnelCode(ctx.companyId);
    for (const [code, id] of personIds) codeOfPerson.set(id, code);
    const findings: Finding[] = [];
    for (const rule of ORG_RULES.filter((r) => r.nightly && r.severity !== 'info')) {
      const record = await this.runtime.evaluate(
        { id: rule.template.id, version: rule.template.version },
        rule.input(plan.whatIf),
        { asOf: ctx.effectiveDate, companyId: ctx.companyId },
      );
      for (const v of (record.output as Violations).violations) {
        const subject =
          v.subject.type === 'person'
            ? `person ${codeOfPerson.get(v.subject.id) ?? v.subject.id}`
            : v.subject.type === 'company'
              ? 'the company'
              : (label.get(v.subject.id) ?? `${v.subject.type} ${v.subject.id}`);
        findings.push({
          severity: rule.severity === 'blocking' ? 'blocking' : 'warning',
          code: `org.rule.${rule.code}`,
          message: `${rule.code} (${rule.template.description.en}): ${subject}, ${v.key}`,
        });
      }
    }
    return findings;
  }

  private async commit(tx: Tx, rows: readonly StagedRow[], ctx: ImportContext): Promise<void> {
    const { plan, current } = await this.prepare(rows, ctx);
    const blocking = plan.findings.filter((f) => f.severity === 'blocking');
    if (blocking.length > 0 || !current.profile) {
      throw new ConflictException(`The import has ${blocking.length} blocking finding(s)`);
    }
    const before = await buildSnapshot(
      this.db.afterOwnCheck(),
      this.people,
      ctx.companyId,
      ctx.effectiveDate,
    );
    const now = this.clock.now();
    const from = dateOf(ctx.effectiveDate);
    const { companyId } = ctx;
    const reason = `structure import ${ctx.importId}`;

    // System codes for new units and positions, reserved in one step.
    const counters = await tx.orgCompany.update({
      where: { companyId },
      data: {
        nextUnitNo: { increment: plan.units.added.length },
        nextPositionNo: { increment: plan.positions.added.length },
        updatedAt: now,
      },
      select: { codePrefix: true, nextUnitNo: true, nextPositionNo: true },
    });
    const firstUnit = counters.nextUnitNo - plan.units.added.length;
    const firstPosition = counters.nextPositionNo - plan.positions.added.length;
    const real = new Map<string, string>();
    const unitCodes = new Map<string, string>();
    const positionCodes = new Map<string, string>();
    plan.units.added.forEach((u, i) => {
      real.set(plan.unitRef.get(u.code)!, randomUUID());
      unitCodes.set(u.code, `${counters.codePrefix}-U${String(firstUnit + i).padStart(4, '0')}`);
    });
    plan.positions.added.forEach((p, i) => {
      real.set(plan.positionRef.get(p.code)!, randomUUID());
      positionCodes.set(
        p.code,
        `${counters.codePrefix}-P${String(firstPosition + i).padStart(5, '0')}`,
      );
    });
    const resolve = (ref: string | null | undefined) => (ref ? (real.get(ref) ?? ref) : null);
    const unitId = (code: string | null) =>
      code === null ? null : resolve(plan.unitRef.get(code));
    const positionId = (code: string | null) =>
      code === null ? null : resolve(plan.positionRef.get(code));
    const levelId = (name: string) =>
      current.levels.get(name) ?? current.levels.get(name.toLowerCase())!;

    await createInChunks(plan.units.added, (batch) =>
      tx.orgUnit.createMany({
        data: batch.map((u) => ({
          id: unitId(u.code)!,
          companyId,
          code: unitCodes.get(u.code)!,
          createdAt: now,
        })),
      }),
    );
    await createInChunks(plan.positions.added, (batch) =>
      tx.orgPosition.createMany({
        data: batch.map((p) => ({
          id: positionId(p.code)!,
          companyId,
          code: positionCodes.get(p.code)!,
          createdAt: now,
        })),
      }),
    );

    // Close what changes or goes (a period is never rewritten, only ended).
    const closeUnitVersions = [
      ...plan.units.changed.map((c) => c.current.versionId),
      ...plan.units.removed.map((u) => u.versionId),
    ];
    const closePositionVersions = [
      ...plan.positions.changed.map((c) => c.current.versionId),
      ...plan.positions.removed.map((p) => p.versionId),
    ];
    const closeLines = [
      ...plan.positions.lineChanged.flatMap((c) => (c.current.line ? [c.current.line.id] : [])),
      ...plan.positions.removed.flatMap((p) => (p.line ? [p.line.id] : [])),
    ];
    await createInChunks(closeUnitVersions, (ids) =>
      tx.orgUnitVersion.updateMany({ where: { id: { in: ids } }, data: { validTo: from } }),
    );
    await createInChunks(closePositionVersions, (ids) =>
      tx.orgPositionVersion.updateMany({ where: { id: { in: ids } }, data: { validTo: from } }),
    );
    await createInChunks(closeLines, (ids) =>
      tx.orgReportingLine.updateMany({ where: { id: { in: ids } }, data: { validTo: from } }),
    );

    // New versions from the effective date.
    const unitVersions = [
      ...plan.units.added.map((u) => ({ file: u, current: null })),
      ...plan.units.changed,
    ];
    await createInChunks(unitVersions, (batch) =>
      tx.orgUnitVersion.createMany({
        data: batch.map(({ file: u, current: c }) => ({
          unitId: unitId(u.code)!,
          companyId,
          legacyCode: c && u.code === c.code ? c.legacyCode : u.code,
          nameFa: u.nameFa,
          nameEn: u.nameEn,
          levelId: levelId(u.level),
          parentUnitId: unitId(u.parentCode),
          costCenter: u.costCenter,
          location: u.location,
          supervisorPositionId: positionId(u.supervisorCode),
          status: 'active',
          validFrom: from,
          recordedAt: now,
        })),
      }),
    );
    const positionVersions = [
      ...plan.positions.added.map((p) => ({ file: p, current: null })),
      ...plan.positions.changed,
    ];
    await createInChunks(positionVersions, (batch) =>
      tx.orgPositionVersion.createMany({
        data: batch.map(({ file: p, current: c }) => ({
          positionId: positionId(p.code)!,
          companyId,
          legacyCode: p.proposed ? null : c && p.code === c.code ? c.legacyCode : p.code,
          titleFa: p.titleFa,
          titleEn: p.titleEn,
          unitId: unitId(p.unitCode)!,
          jobId: c?.jobId ?? null,
          type: p.type,
          fte: String(p.fte),
          supervisory: p.supervisory,
          status: p.status,
          source: p.proposed ? 'proposed' : 'official',
          validFrom: from,
          recordedAt: now,
        })),
      }),
    );
    const newLines = [
      ...plan.positions.added.filter((p) => p.reportsToCode !== null),
      ...plan.positions.lineChanged.map((c) => c.file).filter((p) => p.reportsToCode !== null),
    ];
    await createInChunks(newLines, (batch) =>
      tx.orgReportingLine.createMany({
        data: batch.map((p) => ({
          companyId,
          fromPositionId: positionId(p.code)!,
          toPositionId: positionId(p.reportsToCode)!,
          kind: 'direct',
          validFrom: from,
          recordedAt: now,
        })),
      }),
    );
    const assignments = plan.assignments.added.map((a) => ({
      id: randomUUID(),
      companyId,
      personId: a.personId,
      positionId: resolve(a.positionRef)!,
      kind: a.file.kind,
      timeShare: String(a.file.timeShare),
      source: 'import',
      actionRef: ctx.importId,
      validFrom: from,
      recordedAt: now,
    }));
    await createInChunks(assignments, (batch) => tx.orgAssignment.createMany({ data: batch }));

    // One audit row per entity changed (source `file`, the import id as action id: set by the pipeline).
    const record = (
      action: string,
      entityType: string,
      entityId: string,
      before: unknown,
      after: unknown,
    ) => this.audit.record(tx, { action, entityType, entityId, companyId, before, after, reason });
    const shown = new Map(plan.diff.map((d) => [`${d.entity}:${d.key}`, d]));
    for (const u of plan.units.added) {
      await record('org.unit.create', 'org_unit', unitId(u.code)!, null, {
        code: unitCodes.get(u.code),
        validFrom: ctx.effectiveDate,
        ...(shown.get(`unit:${u.code}`)?.after as object),
      });
    }
    for (const c of plan.units.changed) {
      const d = shown.get(`unit:${c.file.code}`);
      await record('org.unit.change', 'org_unit', c.current.id, d?.before, {
        validFrom: ctx.effectiveDate,
        ...(d?.after as object),
      });
    }
    for (const u of plan.units.removed) {
      await record(
        'org.unit.close',
        'org_unit',
        u.id,
        shown.get(`unit:${u.legacyCode ?? u.code}`)?.before,
        {
          validTo: ctx.effectiveDate,
        },
      );
    }
    for (const p of plan.positions.added) {
      await record('org.position.create', 'org_position', positionId(p.code)!, null, {
        code: positionCodes.get(p.code),
        validFrom: ctx.effectiveDate,
        ...(shown.get(`position:${p.code}`)?.after as object),
      });
    }
    // A position whose version and line both change is one change.
    const changedPositions = new Map(
      [...plan.positions.changed, ...plan.positions.lineChanged].map((c) => [
        c.current.id,
        c.file.code,
      ]),
    );
    for (const [id, code] of changedPositions) {
      const d = shown.get(`position:${code}`);
      await record('org.position.change', 'org_position', id, d?.before, {
        validFrom: ctx.effectiveDate,
        ...(d?.after as object),
      });
    }
    for (const p of plan.positions.removed) {
      await record(
        'org.position.close',
        'org_position',
        p.id,
        shown.get(`position:${p.legacyCode ?? p.code}`)?.before,
        {
          validTo: ctx.effectiveDate,
        },
      );
    }
    for (const a of assignments) {
      await record('org.assignment.start', 'org_assignment', a.id, null, {
        personId: a.personId,
        positionId: a.positionId,
        kind: a.kind,
        timeShare: Number(a.timeShare),
        validFrom: ctx.effectiveDate,
      });
    }

    // Events, on the effective date (spec §7).
    const emit = <S extends z.ZodType>(event: EventDefinition<S>, payload: z.input<S>) =>
      this.events.emit(
        tx,
        { event, payload, effectiveAt: ctx.effectiveDate, companyId },
        ctx.today,
      );
    for (const p of plan.positions.added) {
      await emit(PositionCreated, {
        position_id: positionId(p.code)!,
        code: positionCodes.get(p.code)!,
        unit_id: unitId(p.unitCode)!,
        job_id: null,
        supervisory: p.supervisory,
      });
    }
    for (const c of plan.positions.changed.filter((x) => x.unitChanged)) {
      await emit(PositionChanged, {
        position_id: c.current.id,
        changed: ['unit'],
        unit_from: c.current.unitId,
        unit_to: unitId(c.file.unitCode)!,
        job_from: c.current.jobId,
        job_to: c.current.jobId,
      });
    }
    for (const a of assignments) {
      await emit(AssignmentStarted, {
        assignment_id: a.id,
        person_id: a.personId,
        position_id: a.positionId,
        kind: a.kind,
        time_share: Number(a.timeShare),
        action_ref: ctx.importId,
      });
    }
    for (const change of managerChanges(before, plan.whatIf)) {
      await emit(ManagerChanged, {
        person_id: change.personId,
        from_manager_person_id: change.from,
        to_manager_person_id: change.to,
      });
    }
  }
}

async function createInChunks<T>(
  items: readonly T[],
  write: (batch: T[]) => Promise<unknown>,
): Promise<void> {
  for (let i = 0; i < items.length; i += 1000) await write(items.slice(i, i + 1000));
}
