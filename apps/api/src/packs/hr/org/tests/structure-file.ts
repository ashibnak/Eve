/**
 * Anonymized org structure files for import tests (spec §6 template: units, positions,
 * assignments), with the mess real files have: Persian digits in codes, Arabic yeh/kaf in names,
 * Persian and English words for yes/no, types and kinds, a few proposed positions (unit + title,
 * no position code). Deterministic for a seed.
 */
import ExcelJS from 'exceljs';

export const LEVELS = ['مدیریت عامل', 'معاونت', 'مدیریت', 'اداره', 'تیم', 'گروه', 'بخش', 'واحد'];

export interface SpecUnit {
  code: string;
  name: string;
  level: string;
  parent: string | null;
  supervisor: string | null;
  costCenter: string | null;
}
export interface SpecPosition {
  code: string;
  title: string;
  unit: string;
  type: 'approved' | 'project' | 'temporary';
  supervisory: boolean;
  reportsTo: string | null;
}
export interface SpecAssignment {
  personnelCode: string;
  position: string | null;
  /** For a proposed position: unit code and title instead of a position code. */
  unit?: string;
  title?: string;
  kind: 'primary' | 'acting';
  share: number;
}
export interface StructureSpec {
  units: SpecUnit[];
  positions: SpecPosition[];
  assignments: SpecAssignment[];
}

function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const toPersian = (text: string) => text.replace(/\d/g, (d) => PERSIAN_DIGITS[Number(d)] ?? d);
const toArabicLetters = (text: string) => text.replace(/ی/g, 'ي').replace(/ک/g, 'ك');

/**
 * A company of about `positions` positions in up to 8 levels: every unit has a supervisory head
 * reporting to the parent unit's head, plus staff. About 8% of positions are vacant, some vacant
 * heads have an acting incumbent, and the last three people get proposed positions.
 */
export function generateStructure(options: {
  positions: number;
  personnelCodes: readonly string[];
  seed: number;
}): StructureSpec {
  const random = rng(options.seed);
  const units: SpecUnit[] = [];
  const positions: SpecPosition[] = [];
  let unitNo = 0;
  let positionNo = 0;
  const addUnit = (level: number, parent: string | null) => {
    unitNo += 1;
    const unit: SpecUnit = {
      code: `U${unitNo}`,
      name: `${LEVELS[level]} ${unitNo}`,
      level: LEVELS[level]!,
      parent,
      supervisor: null,
      costCenter: random() < 0.5 ? `CC${100 + (unitNo % 40)}` : null,
    };
    units.push(unit);
    return unit;
  };
  const addPosition = (
    unit: SpecUnit,
    title: string,
    supervisory: boolean,
    reportsTo: string | null,
  ) => {
    positionNo += 1;
    const position: SpecPosition = {
      code: `P${positionNo}`,
      title,
      unit: unit.code,
      type: random() < 0.9 ? 'approved' : random() < 0.5 ? 'project' : 'temporary',
      supervisory,
      reportsTo,
    };
    positions.push(position);
    return position;
  };
  const root = addUnit(0, null);
  const ceo = addPosition(root, 'مدیرعامل', true, null);
  root.supervisor = ceo.code;
  let frontier = [{ unit: root, head: ceo }];
  for (let level = 1; level < LEVELS.length && positions.length < options.positions; level++) {
    const next: typeof frontier = [];
    for (const parent of frontier) {
      const children = level <= 2 ? 4 : 3;
      for (let c = 0; c < children && positions.length < options.positions; c++) {
        const unit = addUnit(level, parent.unit.code);
        const head = addPosition(unit, `رئیس ${unit.name}`, true, parent.head.code);
        unit.supervisor = head.code;
        const staff = level >= 5 ? 3 : 1;
        for (let s = 0; s < staff && positions.length < options.positions; s++) {
          addPosition(unit, `کارشناس ${unit.name}`, false, head.code);
        }
        next.push({ unit, head });
      }
    }
    frontier = next;
  }
  while (positions.length < options.positions) {
    const leaf = frontier[Math.floor(random() * frontier.length)]!;
    addPosition(leaf.unit, `کارشناس ${leaf.unit.name}`, false, leaf.head.code);
  }

  const people = [...options.personnelCodes];
  const assignments: SpecAssignment[] = [];
  const proposed = people.splice(-3);
  let next = 0;
  for (const p of positions) {
    const vacant = p !== ceo && random() < 0.08;
    if (vacant) continue;
    const code = people[next++];
    if (!code) throw new Error('Not enough people for the structure');
    assignments.push({ personnelCode: code, position: p.code, kind: 'primary', share: 1 });
  }
  // A few vacant heads are covered by a staff member acting on top of their own job.
  const filled = new Set(assignments.map((a) => a.position));
  const supervisory = new Set(positions.filter((p) => p.supervisory).map((p) => p.code));
  const staffAssignments = assignments.filter((a) => !supervisory.has(a.position!));
  let acting = 0;
  for (const p of positions) {
    if (!p.supervisory || filled.has(p.code) || acting >= 10) continue;
    const helper = staffAssignments[acting * 7];
    if (!helper) break;
    assignments.push({
      personnelCode: helper.personnelCode,
      position: p.code,
      kind: 'acting',
      share: 1,
    });
    acting += 1;
  }
  for (const [i, code] of proposed.entries()) {
    const unit = units[1 + i]!;
    assignments.push({
      personnelCode: code,
      position: null,
      unit: unit.code,
      title: 'کارشناس پیشنهادی',
      kind: 'primary',
      share: 1,
    });
  }
  return { units, positions, assignments };
}

/**
 * The same company a while later: five units renamed, five vacant staff positions gone, five new
 * positions, and three filled staff positions moved under another unit's head.
 */
export function reviseStructure(spec: StructureSpec): StructureSpec {
  const units = spec.units.map((u) => ({ ...u }));
  let positions = spec.positions.map((p) => ({ ...p }));
  const assigned = new Set(spec.assignments.map((a) => a.position));
  for (const u of units.slice(2, 7)) u.name = `${u.name} (بازآرایی)`;
  const vacantStaff = positions.filter((p) => !p.supervisory && !assigned.has(p.code)).slice(0, 5);
  positions = positions.filter((p) => !vacantStaff.includes(p));
  const heads = positions.filter((p) => p.supervisory);
  let next = Math.max(...spec.positions.map((p) => Number(p.code.slice(1)))) + 1;
  for (let i = 0; i < 5; i++) {
    const head = heads[3 + i]!;
    positions.push({
      code: `P${next++}`,
      title: 'کارشناس تازه',
      unit: head.unit,
      type: 'approved',
      supervisory: false,
      reportsTo: head.code,
    });
  }
  const movable = positions.filter((p) => !p.supervisory && assigned.has(p.code)).slice(0, 3);
  const target = heads[heads.length - 1]!;
  for (const p of movable) {
    p.unit = target.unit;
    p.reportsTo = target.code;
  }
  return { units, positions, assignments: spec.assignments };
}

/** The three-sheet workbook as a structure expert would fill it in. */
export async function structureWorkbook(spec: StructureSpec, seed = 1): Promise<Buffer> {
  const random = rng(seed);
  const messy = (text: string) => (random() < 0.15 ? toArabicLetters(text) : text);
  const code = (text: string) => (random() < 0.1 ? toPersian(text) : text);
  const wb = new ExcelJS.Workbook();
  const unitSheet = wb.addWorksheet('واحدها');
  unitSheet.addRow(['کد واحد', 'نام واحد', 'سطح', 'کد واحد والد', 'مرکز هزینه', 'کد پست سرپرست']);
  for (const u of spec.units) {
    unitSheet.addRow([
      code(u.code),
      messy(u.name),
      u.level,
      u.parent ? code(u.parent) : '',
      u.costCenter ?? '',
      u.supervisor ?? '',
    ]);
  }
  const positionSheet = wb.addWorksheet('پست‌ها');
  positionSheet.addRow([
    'کد پست',
    'عنوان پست',
    'کد واحد',
    'نوع پست',
    'سرپرستی',
    'کد پست بالادست',
    'وضعیت پست',
  ]);
  const typeWord = {
    approved: ['مصوب', 'مصوب', 'approved'],
    project: ['پروژه‌ای', 'پروژه ای'],
    temporary: ['موقت'],
  };
  for (const p of spec.positions) {
    const words = typeWord[p.type];
    positionSheet.addRow([
      code(p.code),
      messy(p.title),
      p.unit,
      words[Math.floor(random() * words.length)],
      p.supervisory ? (random() < 0.8 ? 'بله' : 'yes') : random() < 0.8 ? 'خیر' : 'no',
      p.reportsTo ?? '',
      random() < 0.9 ? 'فعال' : '',
    ]);
  }
  const assignmentSheet = wb.addWorksheet('انتساب‌ها');
  assignmentSheet.addRow(['کد پرسنلی', 'کد پست', 'کد واحد', 'عنوان', 'نوع انتساب', 'سهم زمان']);
  for (const a of spec.assignments) {
    assignmentSheet.addRow([
      code(a.personnelCode),
      a.position ?? '',
      a.unit ?? '',
      a.title ?? '',
      a.kind === 'primary' ? (random() < 0.7 ? 'اصلی' : '') : 'کفالت',
      a.share,
    ]);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
