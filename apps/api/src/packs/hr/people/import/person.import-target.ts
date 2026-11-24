import { peopleV1, type platformV1 } from '@eve/contracts';
import { z } from 'zod';
import {
  type DiffEntry,
  defineImportTarget,
  type Finding,
  type ImportContext,
  type ImportTarget,
  type StagedRow,
} from '../../../../platform/connectors/import-target';
import { ScopedDb } from '../../../../platform/scope/scoped-db';
import { day, type PersonFields, fieldsOf, type PersonRow } from '../model/person';
import { PeopleWriter } from '../commands/people-writer';
import { PeoplePermissions } from '../people.permissions';

/** Status words as HR offices write them, Persian or English (lower-cased before lookup). */
const STATUS_WORDS: Record<string, peopleV1.EmploymentStatus> = {
  active: 'active',
  فعال: 'active',
  شاغل: 'active',
  on_leave: 'on_leave',
  'on leave': 'on_leave',
  مرخصی: 'on_leave',
  suspended: 'suspended',
  تعلیق: 'suspended',
  terminated: 'terminated',
  'قطع همکاری': 'terminated',
  'پایان کار': 'terminated',
  'خاتمه همکاری': 'terminated',
};

const CHANNEL_WORDS: Record<string, 'bale' | 'sms'> = {
  bale: 'bale',
  بله: 'bale',
  sms: 'sms',
  پیامک: 'sms',
};

const StatusSchema = z
  .string()
  .transform((v) => STATUS_WORDS[v.toLowerCase()] ?? v)
  .pipe(peopleV1.EmploymentStatusSchema);

const ChannelSchema = z
  .string()
  .transform((v) => CHANNEL_WORDS[v.toLowerCase()] ?? v)
  .pipe(peopleV1.ContactChannelSchema);

interface FileRecord {
  fields: PersonFields;
  status: peopleV1.EmploymentStatus;
  /** Optional columns left empty: they never clear an existing value (clearing is a correction). */
  missing: Set<'firstNameEn' | 'lastNameEn' | 'contact'>;
}

interface Existing {
  row: PersonRow;
  status: peopleV1.EmploymentStatus | null;
  hasLaterChange: boolean;
}

function fromStaged(row: StagedRow): FileRecord {
  const v = row.values as Record<string, string | undefined>;
  const missing = new Set<'firstNameEn' | 'lastNameEn' | 'contact'>();
  if (v.firstNameEn === undefined) missing.add('firstNameEn');
  if (v.lastNameEn === undefined) missing.add('lastNameEn');
  if (v.contactChannel === undefined && v.contactAddress === undefined) missing.add('contact');
  return {
    fields: {
      personnelCode: v.personnelCode as string,
      firstNameFa: v.firstNameFa as string,
      lastNameFa: v.lastNameFa as string,
      firstNameEn: v.firstNameEn ?? null,
      lastNameEn: v.lastNameEn ?? null,
      hireDate: v.hireDate as platformV1.BusinessDate,
      contact:
        v.contactChannel && v.contactAddress
          ? { channel: v.contactChannel as 'bale' | 'sms', address: v.contactAddress }
          : null,
    },
    status: v.status as peopleV1.EmploymentStatus,
    missing,
  };
}

/** What the file would set on an existing person: file values, keeping what empty cells leave out. */
function merged(file: FileRecord, existing: PersonRow): PersonFields {
  const current = fieldsOf(existing);
  return {
    ...file.fields,
    firstNameEn: file.missing.has('firstNameEn') ? current.firstNameEn : file.fields.firstNameEn,
    lastNameEn: file.missing.has('lastNameEn') ? current.lastNameEn : file.fields.lastNameEn,
    contact: file.missing.has('contact') ? current.contact : file.fields.contact,
  };
}

/**
 * Import of the person register (S3 pipeline). Committed directly by the people data owner
 * (product-owner decision, S4). People missing from the file are reported, never changed.
 */
export function personImportTarget(deps: { db: ScopedDb; writer: PeopleWriter }): ImportTarget {
  async function existing(ctx: ImportContext): Promise<Map<string, Existing>> {
    const db = await deps.db.forCompany(PeoplePermissions.read, ctx.companyId);
    const [people, periods] = await Promise.all([
      db.peoplePerson.findMany({ where: { companyId: ctx.companyId } }),
      db.peopleEmploymentStatus.findMany({ where: { companyId: ctx.companyId } }),
    ]);
    const byPerson = new Map<string, typeof periods>();
    for (const p of periods) byPerson.set(p.personId, [...(byPerson.get(p.personId) ?? []), p]);
    const result = new Map<string, Existing>();
    for (const row of people) {
      const mine = byPerson.get(row.id) ?? [];
      const inForce = mine.find(
        (p) =>
          day(p.validFrom) <= ctx.effectiveDate &&
          (!p.validTo || day(p.validTo) > ctx.effectiveDate),
      );
      result.set(row.personnelCode, {
        row,
        status: (inForce?.status ?? null) as peopleV1.EmploymentStatus | null,
        hasLaterChange: mine.some((p) => day(p.validFrom) > ctx.effectiveDate),
      });
    }
    return result;
  }

  const snapshot = (fields: PersonFields, status: peopleV1.EmploymentStatus | null) => ({
    ...fields,
    status,
  });

  return defineImportTarget({
    name: 'people.person',
    permission: PeoplePermissions.import,
    entities: [
      {
        name: 'person',
        key: 'personnelCode',
        fields: [
          {
            key: 'personnelCode',
            kind: 'code',
            required: true,
            aliases: ['کد پرسنلی', 'شماره پرسنلی', 'کدپرسنلی', 'Personnel code'],
          },
          { key: 'firstNameFa', kind: 'text', required: true, aliases: ['نام'] },
          { key: 'lastNameFa', kind: 'text', required: true, aliases: ['نام خانوادگی'] },
          {
            key: 'firstNameEn',
            kind: 'text',
            required: false,
            aliases: ['First name', 'نام لاتین'],
          },
          {
            key: 'lastNameEn',
            kind: 'text',
            required: false,
            aliases: ['Last name', 'نام خانوادگی لاتین'],
          },
          {
            key: 'hireDate',
            kind: 'date',
            required: true,
            aliases: ['تاریخ استخدام', 'Hire date'],
          },
          {
            key: 'status',
            kind: 'text',
            required: true,
            schema: StatusSchema,
            aliases: ['وضعیت', 'وضعیت اشتغال', 'Status'],
          },
          {
            key: 'contactChannel',
            kind: 'text',
            required: false,
            schema: ChannelSchema,
            aliases: ['کانال', 'Channel'],
          },
          {
            key: 'contactAddress',
            kind: 'code',
            required: false,
            aliases: ['شناسه یا شماره', 'شماره همراه', 'شناسه بله', 'Contact'],
          },
        ],
      },
    ],

    async validate(rows, ctx) {
      const findings: Finding[] = [];
      const current = await existing(ctx);
      const inFile = new Set<string>();
      for (const row of rows) {
        const v = row.values as Record<string, unknown>;
        const file = fromStaged(row);
        const at = { entity: 'person', key: file.fields.personnelCode, rowNumber: row.rowNumber };
        inFile.add(file.fields.personnelCode);
        if ((v.contactChannel === undefined) !== (v.contactAddress === undefined)) {
          findings.push({
            severity: 'blocking',
            code: 'contact_incomplete',
            message: `${at.key}: contact needs both channel and address`,
            ...at,
          });
        }
        if (file.fields.hireDate > ctx.today) {
          findings.push({
            severity: 'warning',
            code: 'future_hire',
            message: `${at.key}: hire date ${file.fields.hireDate} is in the future`,
            ...at,
          });
        }
        const before = current.get(file.fields.personnelCode);
        if (!before && file.status === 'terminated') {
          findings.push({
            severity: 'warning',
            code: 'new_terminated',
            message: `${at.key}: a new person is imported as terminated`,
            ...at,
          });
        }
        if (before && before.status !== file.status && before.hasLaterChange) {
          findings.push({
            severity: 'blocking',
            code: 'later_status_exists',
            message: `${at.key}: a status change after ${ctx.effectiveDate} already exists; the import cannot change the status before it`,
            ...at,
          });
        }
      }
      for (const [code] of [...current].sort(([a], [b]) => a.localeCompare(b))) {
        if (!inFile.has(code)) {
          findings.push({
            severity: 'warning',
            code: 'not_in_file',
            message: `${code} is in the register but not in this file; nothing changes`,
            entity: 'person',
            key: code,
          });
        }
      }
      return findings;
    },

    async diff(rows, ctx) {
      const current = await existing(ctx);
      return rows.map((row): DiffEntry => {
        const file = fromStaged(row);
        const before = current.get(file.fields.personnelCode);
        if (!before) {
          return {
            entity: 'person',
            key: file.fields.personnelCode,
            kind: 'added',
            before: null,
            after: snapshot(file.fields, file.status),
            rowNumber: row.rowNumber,
          };
        }
        const was = snapshot(fieldsOf(before.row), before.status);
        const will = snapshot(merged(file, before.row), file.status);
        const kind = JSON.stringify(was) === JSON.stringify(will) ? 'unchanged' : 'changed';
        return {
          entity: 'person',
          key: file.fields.personnelCode,
          kind,
          before: was,
          after: will,
          rowNumber: row.rowNumber,
        };
      });
    },

    async commit(tx, rows, diff, ctx) {
      const reason = `people import ${ctx.importId}`;
      const changedCodes = diff.filter((d) => d.kind === 'changed').map((d) => d.key);
      const rowsByCode = new Map(
        (
          await tx.peoplePerson.findMany({
            where: { companyId: ctx.companyId, personnelCode: { in: changedCodes } },
          })
        ).map((r) => [r.personnelCode, r]),
      );
      const files = new Map(
        rows.map((r) => fromStaged(r)).map((f) => [f.fields.personnelCode, f] as const),
      );
      for (const entry of diff) {
        const file = files.get(entry.key);
        if (!file || entry.kind === 'unchanged') continue;
        if (entry.kind === 'added') {
          await deps.writer.create(
            tx,
            ctx.companyId,
            file.fields,
            file.status,
            ctx.effectiveDate,
            reason,
          );
          continue;
        }
        const row = rowsByCode.get(entry.key);
        if (!row) throw new Error(`${entry.key} disappeared during the import`);
        const { personnelCode: _code, ...changes } = merged(file, row);
        await deps.writer.correct(tx, row, changes, reason);
        if ((entry.before as { status: string | null }).status !== file.status) {
          await deps.writer.changeStatus(tx, row, file.status, ctx.effectiveDate, reason);
        }
      }
    },
  });
}
