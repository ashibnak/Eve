import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { platformV1 } from '@eve/contracts';
import { z } from 'zod';
import { ApprovalService } from '../approvals/approval.service';
import { ApprovalTypeRegistry, defineApprovalRequestType } from '../approvals/request-types';
import { AuditService } from '../audit/audit.service';
import { canonicalJson, toCanonicalValue } from '../audit/canonical-json';
import { ConfigService } from '../config/config.service';
import { SettingsRegistry, TimeZoneSetting } from '../config/settings';
import { Clock } from '../context/clock';
import { currentActor, runAs, withFlow } from '../context/request-context';
import { LONG_TX, type Tx, TxRunner } from '../context/tx-runner';
import { businessDateIn } from '../dates/dates';
import { PrismaService } from '../db/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import { defineEvent, EventRegistry } from '../events/event-registry';
import { EventPublisher } from '../events/event-publisher';
import { JurisdictionRegistry } from '../jurisdiction/jurisdiction.registry';
import { AccessService } from '../scope/access.service';
import { FileStore } from './file-store';
import {
  convertCell,
  type DiffEntry,
  type Finding,
  type ImportContext,
  type ImportMapping,
  type ImportTarget,
  MappingSchema,
  type StagedRow,
} from './import-target';
import { ImportSettings } from './import.settings';
import { detectFormat, readWorkbook, type Sheet, WorkbookError } from './workbook';

export type ImportStatus =
  | 'uploaded'
  | 'mapped'
  | 'validated'
  | 'previewed'
  | 'awaiting_approval'
  | 'committed'
  | 'discarded';

export const ImportCommitted = defineEvent({
  type: 'platform.import.committed',
  schemaVersion: 1,
  payload: z.object({
    import_id: z.uuid(),
    target: z.string(),
    file_sha256: z.string(),
    added: z.number().int(),
    changed: z.number().int(),
    removed: z.number().int(),
  }),
});

export interface UploadRequest {
  target: string;
  companyId: string;
  effectiveDate: platformV1.BusinessDate;
  sourceName: string;
  fileName: string;
  content: Buffer;
}

export interface SheetSummary {
  name: string;
  headers: string[];
  rowCount: number;
}

export interface RowError {
  field?: string;
  message: string;
}

const CommitPayload = z.object({ importId: z.uuid(), reason: z.string().min(1) });

const OPEN: readonly ImportStatus[] = ['uploaded', 'mapped', 'validated', 'previewed'];

/**
 * The file-import pipeline (ADR-011): upload → map → validate → preview → commit, as a state
 * machine on PostgreSQL. Domain-free: targets (modules) supply checks, diff and commit. A commit is
 * one transaction with source `file` and the import id as action id, so every change it makes is
 * traceable to the uploaded file (kept, with its SHA-256, as evidence).
 */
@Injectable()
export class ImportService {
  private readonly logger = new Logger(ImportService.name);
  private readonly targets = new Map<string, ImportTarget>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly txRunner: TxRunner,
    private readonly audit: AuditService,
    private readonly events: EventPublisher,
    private readonly config: ConfigService,
    private readonly clock: Clock,
    private readonly access: AccessService,
    private readonly jurisdictions: JurisdictionRegistry,
    private readonly files: FileStore,
    private readonly approvals: ApprovalService,
    private readonly approvalTypes: ApprovalTypeRegistry,
    settings: SettingsRegistry,
    eventRegistry: EventRegistry,
  ) {
    settings.register(...Object.values(ImportSettings));
    eventRegistry.register(ImportCommitted);
  }

  /** Registers a module's import target (and its approval request type, if commits need approval). */
  registerTarget(target: ImportTarget): void {
    if (this.targets.has(target.name))
      throw new Error(`Import target ${target.name} is already registered`);
    this.targets.set(target.name, target);
    if (target.approvalChain) {
      this.approvalTypes.register(
        defineApprovalRequestType({
          type: `${target.name}.import.commit`,
          payload: CommitPayload,
          defaultChain: target.approvalChain,
          apply: (tx, request) =>
            this.executeCommit(
              tx,
              request.payload.importId,
              request.payload.reason,
              'awaiting_approval',
            ),
        }),
      );
    }
  }

  async upload(request: UploadRequest) {
    const actor = this.requireUser();
    const target = this.target(request.target);
    await this.access.requireFor(target.permission, request.companyId);
    const sourceName = request.sourceName.trim();
    if (sourceName === '' || sourceName.length > 100)
      throw new BadRequestException('sourceName is required (max 100)');

    const [maxBytes, maxRows] = await Promise.all([
      this.config.get(ImportSettings.maxBytes),
      this.config.get(ImportSettings.maxRows),
    ]);
    if (request.content.length > maxBytes) {
      throw new BadRequestException(
        `The file is ${request.content.length} bytes; the limit is ${maxBytes}`,
      );
    }
    let sheets: Sheet[];
    let format: 'xlsx' | 'csv';
    try {
      format = detectFormat(request.fileName);
      sheets = await readWorkbook(request.content, format, maxRows);
    } catch (error) {
      if (error instanceof WorkbookError) throw new BadRequestException(error.message);
      throw error;
    }
    if (sheets.length === 0)
      throw new BadRequestException('The file has no sheet with a header row');

    const stored = await this.files.put(request.content);
    const summaries: SheetSummary[] = sheets.map((s) => ({
      name: s.name,
      headers: s.headers,
      rowCount: s.rows.length,
    }));
    const mapping = await this.suggestMapping(target, request.companyId, sourceName, summaries);
    const now = this.clock.now();

    return this.txRunner.run(async (tx) => {
      const created = await tx.connectorsImport.create({
        data: {
          target: target.name,
          sourceName,
          companyId: request.companyId,
          effectiveDate: new Date(`${request.effectiveDate}T00:00:00Z`),
          status: 'uploaded',
          fileName: request.fileName,
          fileFormat: format,
          fileSize: stored.size,
          fileSha256: stored.ref,
          fileRef: stored.ref,
          sheets: toCanonicalValue(summaries),
          mapping: mapping ?? undefined,
          createdBy: actor,
          createdAt: now,
          updatedAt: now,
        },
      });
      await this.audit.record(tx, {
        action: 'platform.import.upload',
        entityType: 'connectors_import',
        entityId: created.id,
        companyId: request.companyId,
        before: null,
        after: {
          target: target.name,
          sourceName,
          fileName: request.fileName,
          sha256: stored.ref,
          sheets: summaries.map((s) => ({ name: s.name, rows: s.rowCount })),
        },
        reason: 'file uploaded for import',
      });
      return this.view(created);
    });
  }

  /** Applies a column mapping: converts and stages every row; optionally saves the mapping. */
  async map(id: string, mappingInput: unknown, save: boolean) {
    const actor = this.requireUser();
    const mapping = MappingSchema.parse(mappingInput);
    const imp = await this.load(id);
    const target = this.target(imp.target);
    await this.access.requireFor(target.permission, imp.companyId);
    this.requireStatus(imp.status, OPEN);
    const summaries = imp.sheets as unknown as SheetSummary[];
    this.checkMapping(target, mapping, summaries);

    if (!imp.fileRef) throw new ConflictException('The file of this import was purged');
    const sheets = await readWorkbook(
      await this.files.get(imp.fileRef),
      imp.fileFormat as 'xlsx' | 'csv',
      Number.MAX_SAFE_INTEGER,
    );
    const calendar = await this.calendarOf(imp.companyId);
    const staged = this.stage(target, mapping, sheets, calendar);
    const rowsWithErrors = staged.filter((r) => r.errors.length > 0).length;
    const now = this.clock.now();

    await this.txRunner.run(async (tx) => {
      await tx.connectorsImportRow.deleteMany({ where: { importId: id } });
      if (staged.length > 0) {
        await tx.connectorsImportRow.createMany({
          data: staged.map((r) => ({
            importId: id,
            sheet: r.sheet,
            rowNumber: r.rowNumber,
            entity: r.entity,
            key: r.key || null,
            values: toCanonicalValue(r.values) as object,
            errors: r.errors as unknown as object,
          })),
        });
      }
      await tx.connectorsImport.update({
        where: { id },
        data: {
          mapping: toCanonicalValue(mapping) as object,
          status: 'mapped',
          counts: { rows: staged.length, rowsWithErrors },
          findings: Prisma.DbNull,
          diff: Prisma.DbNull,
          updatedAt: now,
        },
      });
      if (save) {
        const existing = await tx.connectorsMapping.findUnique({
          where: {
            target_companyId_sourceName: {
              target: imp.target,
              companyId: imp.companyId,
              sourceName: imp.sourceName,
            },
          },
        });
        const saved = await tx.connectorsMapping.upsert({
          where: {
            target_companyId_sourceName: {
              target: imp.target,
              companyId: imp.companyId,
              sourceName: imp.sourceName,
            },
          },
          create: {
            target: imp.target,
            companyId: imp.companyId,
            sourceName: imp.sourceName,
            mapping: toCanonicalValue(mapping) as object,
            updatedBy: actor,
            updatedAt: now,
          },
          update: {
            mapping: toCanonicalValue(mapping) as object,
            updatedBy: actor,
            updatedAt: now,
          },
        });
        await this.audit.record(tx, {
          action: 'platform.import.mapping.save',
          entityType: 'connectors_mapping',
          entityId: saved.id,
          companyId: imp.companyId,
          before: existing?.mapping ?? null,
          after: mapping,
          reason: `mapping saved for source "${imp.sourceName}"`,
        });
      }
    });
    return this.get(id);
  }

  /** Runs the target's domain checks on the staged rows; structural errors are blocking findings. */
  async validate(id: string) {
    this.requireUser();
    const imp = await this.load(id);
    const target = this.target(imp.target);
    await this.access.requireFor(target.permission, imp.companyId);
    this.requireStatus(imp.status, ['mapped', 'validated', 'previewed']);
    const { clean, withErrors } = await this.stagedRows(id);
    const findings: Finding[] = withErrors.map((r) => ({
      severity: 'blocking',
      code: 'row_error',
      message: r.errors.map((e) => e.message).join('; '),
      entity: r.entity,
      key: r.key,
      rowNumber: r.rowNumber,
    }));
    findings.push(...(await target.validate(clean, await this.context(imp))));
    await this.prisma.connectorsImport.update({
      where: { id },
      data: {
        status: 'validated',
        findings: toCanonicalValue(findings) as object,
        diff: Prisma.DbNull,
        updatedAt: this.clock.now(),
      },
    });
    return this.get(id);
  }

  /** Compares the staged rows with current data, through the target. */
  async preview(id: string) {
    this.requireUser();
    const imp = await this.load(id);
    const target = this.target(imp.target);
    await this.access.requireFor(target.permission, imp.companyId);
    this.requireStatus(imp.status, ['validated', 'previewed']);
    const { clean } = await this.stagedRows(id);
    const diff = await target.diff(clean, await this.context(imp));
    await this.prisma.connectorsImport.update({
      where: { id },
      data: {
        status: 'previewed',
        diff: toCanonicalValue(diff) as object,
        counts: { ...(imp.counts as object), ...summarize(diff) },
        updatedAt: this.clock.now(),
      },
    });
    return this.get(id);
  }

  /** Commits directly, or submits for approval when the target requires it. */
  async commit(id: string, reason: string) {
    this.requireUser();
    if (reason.trim() === '') throw new BadRequestException('A reason is required');
    const imp = await this.load(id);
    const target = this.target(imp.target);
    await this.access.requireFor(target.permission, imp.companyId);
    this.requireStatus(imp.status, ['previewed']);
    this.requireCommittable(imp);

    if (target.approvalChain) {
      const request = await this.approvals.submit({
        type: `${target.name}.import.commit`,
        companyId: imp.companyId,
        payload: { importId: id, reason },
        reason,
      });
      await this.prisma.connectorsImport.update({
        where: { id },
        data: {
          status: 'awaiting_approval',
          approvalRequestId: request.id,
          updatedAt: this.clock.now(),
        },
      });
      return this.get(id);
    }
    await this.txRunner.run((tx) => this.executeCommit(tx, id, reason, 'previewed'), LONG_TX);
    return this.get(id);
  }

  async discard(id: string, reason: string) {
    this.requireUser();
    const imp = await this.load(id);
    await this.access.requireFor(this.target(imp.target).permission, imp.companyId);
    this.requireStatus(imp.status, [...OPEN, 'awaiting_approval']);
    if (imp.status === 'awaiting_approval' && imp.approvalRequestId) {
      const request = await this.prisma.approvalsRequest.findUnique({
        where: { id: imp.approvalRequestId },
      });
      if (request && (request.status === 'pending' || request.status === 'returned')) {
        throw new ConflictException('Cancel the approval request first');
      }
    }
    await this.txRunner.run(async (tx) => {
      await tx.connectorsImport.update({
        where: { id },
        data: { status: 'discarded', updatedAt: this.clock.now() },
      });
      await this.audit.record(tx, {
        action: 'platform.import.discard',
        entityType: 'connectors_import',
        entityId: id,
        companyId: imp.companyId,
        before: { status: imp.status },
        after: { status: 'discarded' },
        reason,
      });
    });
    return this.get(id);
  }

  async get(id: string) {
    const imp = await this.load(id);
    await this.access.requireFor(this.target(imp.target).permission, imp.companyId);
    const errors = await this.prisma.connectorsImportRow.findMany({
      where: { importId: id, NOT: { errors: { equals: [] } } },
      orderBy: [{ sheet: 'asc' }, { rowNumber: 'asc' }],
      take: 500,
      select: { sheet: true, rowNumber: true, entity: true, key: true, errors: true },
    });
    return { ...this.view(imp), rowErrors: errors };
  }

  /**
   * Retention (product-owner decision S3): imports that were discarded or abandoned for the
   * retention period lose their staged rows and file. Committed imports keep their file forever.
   */
  async purgeExpired(): Promise<number> {
    const days = await this.config.get(ImportSettings.retentionDays);
    const cutoff = new Date(this.clock.now().getTime() - days * 86_400_000);
    const expired = await this.prisma.connectorsImport.findMany({
      where: {
        status: { notIn: ['committed', 'awaiting_approval'] },
        purgedAt: null,
        updatedAt: { lt: cutoff },
      },
      select: { id: true, companyId: true, status: true, fileRef: true },
    });
    for (const imp of expired) {
      await runAs({ kind: 'system', id: 'connectors:retention' }, () =>
        this.txRunner.run(async (tx) => {
          await tx.connectorsImportRow.deleteMany({ where: { importId: imp.id } });
          await tx.connectorsImport.update({
            where: { id: imp.id },
            data: {
              status: 'discarded',
              fileRef: null,
              findings: Prisma.DbNull,
              diff: Prisma.DbNull,
              purgedAt: this.clock.now(),
            },
          });
          await this.audit.record(tx, {
            action: 'platform.import.purge',
            entityType: 'connectors_import',
            entityId: imp.id,
            companyId: imp.companyId,
            before: { status: imp.status, file: imp.fileRef },
            after: { status: 'discarded', file: null },
            reason: `retention: no activity for ${days} days`,
          });
        }),
      );
      if (imp.fileRef) {
        const stillNeeded = await this.prisma.connectorsImport.count({
          where: { fileRef: imp.fileRef, status: { in: ['committed', 'awaiting_approval'] } },
        });
        if (stillNeeded === 0) await this.files.delete(imp.fileRef);
      }
    }
    if (expired.length > 0) this.logger.log(`Purged ${expired.length} expired import(s)`);
    return expired.length;
  }

  /** The commit itself: re-checks, re-diffs under lock, applies through the target, records. */
  private async executeCommit(
    tx: Tx,
    id: string,
    reason: string,
    expected: ImportStatus,
  ): Promise<void> {
    const [locked] = await tx.$queryRaw<{ status: string }[]>`
      SELECT status FROM connectors_import WHERE id = ${id}::uuid FOR UPDATE`;
    if (!locked) throw new NotFoundException('Import not found');
    if (locked.status !== expected) throw new ConflictException(`Import is ${locked.status}`);
    const imp = await tx.connectorsImport.findUniqueOrThrow({ where: { id } });
    this.requireCommittable(imp);
    const target = this.target(imp.target);
    const context = await this.context(imp);
    const { clean } = await this.stagedRows(id);

    // Data may have changed since the preview the user approved: refuse rather than surprise.
    const diff = await target.diff(clean, context);
    if (canonicalJson(diff) !== canonicalJson(imp.diff)) {
      throw new ConflictException(
        'The data changed since the preview; preview again before committing',
      );
    }
    await withFlow({ source: 'file', actionId: id }, async () => {
      await target.commit(tx, clean, diff, context);
      const counts = summarize(diff);
      await tx.connectorsImport.update({
        where: { id },
        data: { status: 'committed', committedAt: this.clock.now(), updatedAt: this.clock.now() },
      });
      await this.audit.record(tx, {
        action: 'platform.import.commit',
        entityType: 'connectors_import',
        entityId: id,
        companyId: imp.companyId,
        before: { status: expected },
        after: {
          status: 'committed',
          target: imp.target,
          fileName: imp.fileName,
          sha256: imp.fileSha256,
          ...counts,
        },
        reason,
      });
      await this.events.publish(tx, {
        event: ImportCommitted,
        payload: {
          import_id: id,
          target: imp.target,
          file_sha256: imp.fileSha256,
          added: counts.added,
          changed: counts.changed,
          removed: counts.removed,
        },
        effectiveAt: context.effectiveDate,
        companyId: imp.companyId,
      });
    });
  }

  private requireCommittable(imp: { findings: unknown; counts: unknown }): void {
    const findings = (imp.findings ?? []) as Finding[];
    const blocking = findings.filter((f) => f.severity === 'blocking').length;
    if (blocking > 0)
      throw new ConflictException(
        `${blocking} blocking finding(s) must be fixed before committing`,
      );
    const rowsWithErrors = (imp.counts as { rowsWithErrors?: number }).rowsWithErrors ?? 0;
    if (rowsWithErrors > 0) throw new ConflictException(`${rowsWithErrors} row(s) have errors`);
  }

  private stage(
    target: ImportTarget,
    mapping: ImportMapping,
    sheets: Sheet[],
    calendar: platformV1.JurisdictionCalendar,
  ): (StagedRow & { errors: RowError[] })[] {
    const staged: (StagedRow & { errors: RowError[] })[] = [];
    const seenKeys = new Map<string, number>();
    for (const sheet of sheets) {
      const sheetMapping = mapping[sheet.name];
      if (!sheetMapping) continue;
      const entity = target.entities.find((e) => e.name === sheetMapping.entity);
      if (!entity) continue;
      const headerOf = new Map(
        Object.entries(sheetMapping.columns).map(([header, field]) => [field, header]),
      );
      for (const row of sheet.rows) {
        const values: Record<string, unknown> = {};
        const errors: RowError[] = [];
        for (const field of entity.fields) {
          const header = headerOf.get(field.key);
          const result = convertCell(
            field,
            header === undefined ? undefined : row.cells[header],
            calendar,
          );
          if ('error' in result) errors.push({ field: field.key, message: result.error });
          else if (result.value !== undefined) values[field.key] = result.value;
        }
        const key = typeof values[entity.key] === 'string' ? (values[entity.key] as string) : '';
        const dedupe = `${entity.name}:${key}`;
        if (key && seenKeys.has(dedupe)) {
          errors.push({
            field: entity.key,
            message: `${entity.key} "${key}" also appears in row ${seenKeys.get(dedupe)}`,
          });
        } else if (key) {
          seenKeys.set(dedupe, row.rowNumber);
        }
        staged.push({
          entity: entity.name,
          sheet: sheet.name,
          rowNumber: row.rowNumber,
          key,
          values,
          errors,
        });
      }
    }
    return staged;
  }

  private checkMapping(target: ImportTarget, mapping: ImportMapping, sheets: SheetSummary[]): void {
    const problems: string[] = [];
    const mappedEntities = new Set<string>();
    for (const [sheetName, sheetMapping] of Object.entries(mapping)) {
      const sheet = sheets.find((s) => s.name === sheetName);
      const entity = target.entities.find((e) => e.name === sheetMapping.entity);
      if (!sheet) problems.push(`no sheet "${sheetName}" in the file`);
      if (!entity) problems.push(`no entity "${sheetMapping.entity}" in ${target.name}`);
      if (!sheet || !entity) continue;
      mappedEntities.add(entity.name);
      const fields = Object.values(sheetMapping.columns);
      for (const [header, field] of Object.entries(sheetMapping.columns)) {
        if (!sheet.headers.includes(header))
          problems.push(`sheet "${sheetName}" has no column "${header}"`);
        if (!entity.fields.some((f) => f.key === field))
          problems.push(`${entity.name} has no field "${field}"`);
      }
      for (const field of entity.fields.filter((f) => f.required)) {
        if (!fields.includes(field.key))
          problems.push(`sheet "${sheetName}": required field "${field.key}" is not mapped`);
      }
      const duplicates = fields.filter((f, i) => fields.indexOf(f) !== i);
      if (duplicates.length > 0)
        problems.push(`sheet "${sheetName}": ${[...new Set(duplicates)].join(', ')} mapped twice`);
    }
    if (mappedEntities.size === 0) problems.push('map at least one sheet');
    if (problems.length > 0) throw new BadRequestException({ error: 'invalid_mapping', problems });
  }

  /** Saved mapping for this source (if it still fits the file), else header = field key or alias. */
  private async suggestMapping(
    target: ImportTarget,
    companyId: string,
    sourceName: string,
    sheets: SheetSummary[],
  ): Promise<ImportMapping | null> {
    const saved = await this.prisma.connectorsMapping.findUnique({
      where: { target_companyId_sourceName: { target: target.name, companyId, sourceName } },
    });
    if (saved) {
      const mapping = MappingSchema.parse(saved.mapping);
      const fits = Object.entries(mapping).every(([sheetName, m]) => {
        const sheet = sheets.find((s) => s.name === sheetName);
        return (
          sheet !== undefined && Object.keys(m.columns).every((h) => sheet.headers.includes(h))
        );
      });
      if (fits) return mapping;
    }
    const suggestion: ImportMapping = {};
    for (const sheet of sheets) {
      for (const entity of target.entities) {
        const columns: Record<string, string> = {};
        for (const header of sheet.headers) {
          const match = entity.fields.find(
            (f) =>
              f.key.toLowerCase() === header.toLowerCase() ||
              (f.aliases ?? []).some((a) => a === header),
          );
          if (match && !Object.values(columns).includes(match.key)) columns[header] = match.key;
        }
        if (Object.values(columns).includes(entity.key)) {
          suggestion[sheet.name] = { entity: entity.name, columns };
          break;
        }
      }
    }
    return Object.keys(suggestion).length > 0 ? suggestion : null;
  }

  private async stagedRows(id: string) {
    const rows = await this.prisma.connectorsImportRow.findMany({
      where: { importId: id },
      orderBy: [{ sheet: 'asc' }, { rowNumber: 'asc' }],
    });
    const toStaged = (r: (typeof rows)[number]) => ({
      entity: r.entity,
      sheet: r.sheet,
      rowNumber: r.rowNumber,
      key: r.key ?? '',
      values: r.values as Record<string, unknown>,
      errors: r.errors as unknown as RowError[],
    });
    const all = rows.map(toStaged);
    return {
      clean: all.filter((r) => r.errors.length === 0),
      withErrors: all.filter((r) => r.errors.length > 0),
    };
  }

  private async context(imp: {
    id: string;
    companyId: string;
    effectiveDate: Date;
  }): Promise<ImportContext> {
    return {
      importId: imp.id,
      companyId: imp.companyId,
      effectiveDate: imp.effectiveDate.toISOString().slice(0, 10) as platformV1.BusinessDate,
      today: businessDateIn(this.clock.now(), await this.config.get(TimeZoneSetting)),
    };
  }

  private async calendarOf(companyId: string): Promise<platformV1.JurisdictionCalendar> {
    const company = await this.prisma.coreCompany.findUniqueOrThrow({ where: { id: companyId } });
    return this.jurisdictions.get(company.jurisdictionCode).calendar;
  }

  private async load(id: string) {
    const imp = await this.prisma.connectorsImport.findUnique({ where: { id } });
    if (!imp) throw new NotFoundException('Import not found');
    return imp;
  }

  private target(name: string): ImportTarget {
    const target = this.targets.get(name);
    if (!target) throw new BadRequestException(`Unknown import target ${name}`);
    return target;
  }

  private requireStatus(status: string, allowed: readonly ImportStatus[]): void {
    if (!allowed.includes(status as ImportStatus)) {
      throw new ConflictException(`Import is ${status}; expected ${allowed.join(' or ')}`);
    }
  }

  private requireUser(): string {
    const actor = currentActor();
    if (!actor) throw new UnauthorizedException();
    if (actor.kind !== 'user') throw new ForbiddenException('Imports are run by people');
    return actor.id;
  }

  private view(imp: {
    id: string;
    target: string;
    sourceName: string;
    companyId: string;
    effectiveDate: Date;
    status: string;
    fileName: string;
    fileFormat: string;
    fileSize: number;
    fileSha256: string;
    sheets: unknown;
    mapping: unknown;
    counts: unknown;
    findings: unknown;
    diff: unknown;
    approvalRequestId: string | null;
    createdBy: string;
    createdAt: Date;
    committedAt: Date | null;
    purgedAt: Date | null;
  }) {
    return {
      id: imp.id,
      target: imp.target,
      sourceName: imp.sourceName,
      companyId: imp.companyId,
      effectiveDate: imp.effectiveDate.toISOString().slice(0, 10),
      status: imp.status as ImportStatus,
      file: {
        name: imp.fileName,
        format: imp.fileFormat,
        size: imp.fileSize,
        sha256: imp.fileSha256,
      },
      sheets: imp.sheets as SheetSummary[],
      mapping: imp.mapping as ImportMapping | null,
      counts: imp.counts as Record<string, number>,
      findings: (imp.findings ?? null) as Finding[] | null,
      diff: (imp.diff ?? null) as DiffEntry[] | null,
      approvalRequestId: imp.approvalRequestId,
      createdBy: imp.createdBy,
      createdAt: imp.createdAt,
      committedAt: imp.committedAt,
      purgedAt: imp.purgedAt,
    };
  }
}

function summarize(diff: readonly DiffEntry[]) {
  const count = (kind: DiffEntry['kind']) => diff.filter((d) => d.kind === kind).length;
  return {
    added: count('added'),
    changed: count('changed'),
    removed: count('removed'),
    unchanged: count('unchanged'),
  };
}
