import type { peopleV1, platformV1 } from '@eve/contracts';

/** A people_person row as Prisma returns it. */
export interface PersonRow {
  id: string;
  companyId: string;
  personnelCode: string;
  firstNameFa: string;
  lastNameFa: string;
  firstNameEn: string | null;
  lastNameEn: string | null;
  hireDate: Date;
  contactChannel: string | null;
  contactAddress: string | null;
}

/** The fields a person record carries (what an import or a correction sets). */
export interface PersonFields {
  personnelCode: string;
  firstNameFa: string;
  lastNameFa: string;
  firstNameEn: string | null;
  lastNameEn: string | null;
  hireDate: platformV1.BusinessDate;
  contact: { channel: 'bale' | 'sms'; address: string } | null;
}

export const day = (date: Date) => date.toISOString().slice(0, 10) as platformV1.BusinessDate;
export const dateOf = (day: platformV1.BusinessDate) => new Date(`${day}T00:00:00Z`);

export function fieldsOf(row: PersonRow): PersonFields {
  return {
    personnelCode: row.personnelCode,
    firstNameFa: row.firstNameFa,
    lastNameFa: row.lastNameFa,
    firstNameEn: row.firstNameEn,
    lastNameEn: row.lastNameEn,
    hireDate: day(row.hireDate),
    contact:
      row.contactChannel && row.contactAddress
        ? { channel: row.contactChannel as 'bale' | 'sms', address: row.contactAddress }
        : null,
  };
}

export function toView(
  row: PersonRow,
  status: peopleV1.EmploymentStatus | null,
  asOf: platformV1.BusinessDate,
): peopleV1.PersonView {
  const fields = fieldsOf(row);
  return {
    id: row.id,
    companyId: row.companyId,
    personnelCode: row.personnelCode,
    name: {
      first: { fa: row.firstNameFa, en: row.firstNameEn },
      last: { fa: row.lastNameFa, en: row.lastNameEn },
    },
    hireDate: fields.hireDate,
    status,
    asOf,
    contact: fields.contact,
  };
}
