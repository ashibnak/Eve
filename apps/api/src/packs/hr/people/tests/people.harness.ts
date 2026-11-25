/**
 * Test wiring for the people module on top of the hand-built test platform (same wiring as
 * PeopleModule, without Nest), plus an anonymized people-file generator.
 */
import ExcelJS from 'exceljs';
import type { Platform } from '../../../../../test/platform';
import { registerScopedModel } from '../../../../platform/scope/scoped-prisma';
import { PeopleCommands } from '../commands/people.commands';
import { PeopleWriter } from '../commands/people-writer';
import { PersonCreated, PersonStatusChanged } from '../events/people.events';
import { personImportTarget } from '../import/person.import-target';
import { PeopleDataOwnerRole, PeoplePermissions } from '../people.permissions';
import { PeopleService } from '../service/people.service';

export function createPeople(platform: Platform) {
  registerScopedModel('PeoplePerson', { companyField: 'companyId' });
  registerScopedModel('PeopleEmploymentStatus', { companyField: 'companyId' });
  registerScopedModel('PeopleUserLink', { companyField: 'companyId' });
  if (!platform.roles.has(PeopleDataOwnerRole.name)) platform.roles.register(PeopleDataOwnerRole);
  platform.roles.extend('auditor', [PeoplePermissions.read]);
  platform.eventRegistry.register(PersonCreated, PersonStatusChanged);
  const writer = new PeopleWriter(platform.audit, platform.events, platform.clock);
  const service = new PeopleService(platform.scopedDb, platform.config, platform.clock);
  const commands = new PeopleCommands(platform.scopedDb, platform.txRunner, writer, platform.users);
  platform.imports.registerTarget(personImportTarget({ db: platform.scopedDb, writer }));
  return { writer, service, commands };
}

/** Deterministic pseudo-random numbers, so a fixture is the same on every run. */
function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

const FIRST = [
  'علی',
  'مریم',
  'رضا',
  'زهرا',
  'حسین',
  'فاطمه',
  'مهدی',
  'سارا',
  'امیر',
  'نرگس',
  'کاوه',
  'لیلا',
];
const LAST = [
  'کریمی',
  'احمدی',
  'رضایی',
  'محمدی',
  'حسینی',
  'یزدانی',
  'کاظمی',
  'نیک‌نام',
  'رحیمی',
  'تهرانی',
];
const LATIN_FIRST = [
  'Ali',
  'Maryam',
  'Reza',
  'Zahra',
  'Hossein',
  'Fatemeh',
  'Mehdi',
  'Sara',
  'Amir',
  'Narges',
  'Kaveh',
  'Leila',
];

const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const toPersian = (text: string) => text.replace(/\d/g, (d) => PERSIAN_DIGITS[Number(d)] ?? d);
/** How Arabic keyboards type Persian ی and ک. */
const toArabicLetters = (text: string) => text.replace(/ی/g, 'ي').replace(/ک/g, 'ك');

export interface FixturePerson {
  code: string;
  status: 'active' | 'on_leave' | 'suspended';
}

export const PEOPLE_HEADERS = [
  'کد پرسنلی',
  'نام',
  'نام خانوادگی',
  'نام لاتین',
  'تاریخ استخدام',
  'وضعیت',
  'کانال',
  'شناسه یا شماره',
];

/**
 * An anonymized people sheet with the mess real HR files have: Arabic yeh/kaf, Persian digits in
 * codes and phone numbers, Jalali text dates mixed with Excel dates, Persian and English status
 * words, optional Latin names and contacts. Returns the file and what it contains.
 */
export async function generatePeopleFile(
  count: number,
  seed: number,
  codePrefix = '',
): Promise<{ content: Buffer; people: FixturePerson[] }> {
  const random = rng(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('پرسنل');
  ws.addRow(PEOPLE_HEADERS);
  const people: FixturePerson[] = [];
  for (let i = 0; i < count; i += 1) {
    const code = `${codePrefix}${10_000 + i}`;
    const firstIndex = Math.floor(random() * FIRST.length);
    let first = FIRST[firstIndex] as string;
    let last = pick(LAST);
    if (random() < 0.15) {
      first = toArabicLetters(first);
      last = toArabicLetters(last);
    }
    const roll = random();
    const status: FixturePerson['status'] =
      roll < 0.9 ? 'active' : roll < 0.97 ? 'on_leave' : 'suspended';
    const statusWord = {
      active: pick(['فعال', 'فعال', 'شاغل', 'active']),
      on_leave: pick(['مرخصی', 'on_leave']),
      suspended: 'تعلیق',
    }[status];
    const year = 1385 + Math.floor(random() * 20);
    const month = 1 + Math.floor(random() * 12);
    const dayOfMonth = 1 + Math.floor(random() * 28);
    const hire: string | Date =
      random() < 0.7
        ? toPersianMaybe(
            `${year}/${String(month).padStart(2, '0')}/${String(dayOfMonth).padStart(2, '0')}`,
            random() < 0.3,
          )
        : new Date(
            Date.UTC(
              2005 + Math.floor(random() * 20),
              Math.floor(random() * 12),
              1 + Math.floor(random() * 28),
            ),
          );
    const hasContact = random() < 0.5;
    const mobile = `0912${String(Math.floor(random() * 10_000_000)).padStart(7, '0')}`;
    ws.addRow([
      random() < 0.1 ? toPersian(code) : code,
      first,
      last,
      random() < 0.4 ? LATIN_FIRST[firstIndex] : '',
      hire,
      statusWord,
      hasContact ? pick(['بله', 'پیامک', 'sms']) : '',
      hasContact ? (random() < 0.5 ? toPersian(mobile) : mobile) : '',
    ]);
    people.push({ code, status });
  }
  return { content: Buffer.from(await wb.xlsx.writeBuffer()), people };
}

function toPersianMaybe(text: string, persian: boolean): string {
  return persian ? toPersian(text) : text;
}
