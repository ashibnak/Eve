/**
 * Test fixtures for org: rows inserted directly (org has no write path before S7/S8), plus
 * people records with a status. Never used outside tests.
 */
import { randomUUID } from 'node:crypto';
import type { orgV1, peopleV1 } from '@eve/contracts';
import type { Platform } from '../../../../../test/platform';

const SINCE = new Date('2020-01-01T00:00:00Z');
const day = (d: string) => new Date(`${d}T00:00:00Z`);

export interface Period {
  from?: string;
  to?: string | null;
}

function period(p: Period = {}) {
  return { validFrom: p.from ? day(p.from) : SINCE, validTo: p.to ? day(p.to) : null };
}

/** Builds one company's structure; ids are generated here so rows can be batch-inserted. */
export class OrgFixture {
  private units = 0;
  private positions = 0;
  private persons = 0;
  readonly rows = {
    units: [] as { id: string; code: string }[],
    unitVersions: [] as Record<string, unknown>[],
    positions: [] as { id: string; code: string }[],
    positionVersions: [] as Record<string, unknown>[],
    lines: [] as Record<string, unknown>[],
    assignments: [] as Record<string, unknown>[],
    people: [] as Record<string, unknown>[],
    statuses: [] as Record<string, unknown>[],
  };

  constructor(
    readonly companyId: string,
    readonly prefix: string,
  ) {}

  unit(name: string, parentUnitId: string | null = null): string {
    const id = randomUUID();
    this.units += 1;
    this.rows.units.push({ id, code: `${this.prefix}-U${String(this.units).padStart(4, '0')}` });
    this.rows.unitVersions.push({
      unitId: id,
      companyId: this.companyId,
      nameFa: name,
      parentUnitId,
      status: 'active',
      ...period(),
    });
    return id;
  }

  /** Sets a unit's supervisor position (R6). */
  supervise(unitId: string, positionId: string): void {
    const version = this.rows.unitVersions.find((v) => v.unitId === unitId);
    if (!version) throw new Error('Unknown unit');
    version.supervisorPositionId = positionId;
  }

  position(
    unitId: string,
    title: string,
    options: {
      supervisory?: boolean;
      reportsTo?: string | null;
      status?: orgV1.PositionView['status'];
      source?: orgV1.PositionView['source'];
      titleEn?: string;
    } & Period = {},
  ): string {
    const id = randomUUID();
    this.positions += 1;
    this.rows.positions.push({
      id,
      code: `${this.prefix}-P${String(this.positions).padStart(5, '0')}`,
    });
    this.rows.positionVersions.push({
      positionId: id,
      companyId: this.companyId,
      titleFa: title,
      titleEn: options.titleEn ?? null,
      unitId,
      type: 'approved',
      fte: '1',
      supervisory: options.supervisory ?? false,
      status: options.status ?? 'active',
      source: options.source ?? 'official',
      ...period(options),
    });
    if (options.reportsTo) this.line(id, options.reportsTo, 'direct', options);
    return id;
  }

  line(from: string, to: string, kind: orgV1.LineKind, p: Period = {}): void {
    this.rows.lines.push({
      companyId: this.companyId,
      fromPositionId: from,
      toPositionId: to,
      kind,
      ...period(p),
    });
  }

  person(status: peopleV1.EmploymentStatus = 'active', name = 'نفر'): string {
    const id = randomUUID();
    this.persons += 1;
    this.rows.people.push({
      id,
      companyId: this.companyId,
      personnelCode: String(this.persons).padStart(6, '0'),
      firstNameFa: name,
      lastNameFa: `شماره ${this.persons}`,
      hireDate: SINCE,
    });
    this.rows.statuses.push({ personId: id, companyId: this.companyId, status, ...period() });
    return id;
  }

  assign(
    personId: string,
    positionId: string,
    kind: orgV1.AssignmentKind = 'primary',
    p: Period = {},
  ): void {
    this.rows.assignments.push({
      companyId: this.companyId,
      personId,
      positionId,
      kind,
      timeShare: '1',
      source: 'import',
      ...period(p),
    });
  }

  /** Inserts everything built so far (as the application role, like any test). */
  async save(platform: Pick<Platform, 'prisma'>, nameFa = 'شرکت آزمایشی'): Promise<void> {
    const db = platform.prisma;
    const now = new Date();
    const stamp = <T extends object>(rows: T[], field: string) =>
      rows.map((r) => ({ ...r, [field]: now }));
    await db.orgCompany.upsert({
      where: { companyId: this.companyId },
      update: {},
      create: {
        companyId: this.companyId,
        nameFa,
        codePrefix: this.prefix,
        createdAt: now,
        updatedAt: now,
      },
    });
    const chunks = async <T>(rows: T[], insert: (batch: T[]) => Promise<unknown>) => {
      for (let i = 0; i < rows.length; i += 2000) await insert(rows.slice(i, i + 2000));
    };
    await chunks(stamp(this.rows.people, 'createdAt'), (data) =>
      db.peoplePerson.createMany({ data: data.map((r) => ({ ...r, updatedAt: now })) as never }),
    );
    await chunks(stamp(this.rows.statuses, 'recordedAt'), (data) =>
      db.peopleEmploymentStatus.createMany({ data: data as never }),
    );
    await chunks(
      this.rows.units.map((u) => ({ ...u, companyId: this.companyId, createdAt: now })),
      (data) => db.orgUnit.createMany({ data }),
    );
    await chunks(
      this.rows.positions.map((p) => ({ ...p, companyId: this.companyId, createdAt: now })),
      (data) => db.orgPosition.createMany({ data }),
    );
    await chunks(stamp(this.rows.unitVersions, 'recordedAt'), (data) =>
      db.orgUnitVersion.createMany({ data: data as never }),
    );
    await chunks(stamp(this.rows.positionVersions, 'recordedAt'), (data) =>
      db.orgPositionVersion.createMany({ data: data as never }),
    );
    await chunks(stamp(this.rows.lines, 'recordedAt'), (data) =>
      db.orgReportingLine.createMany({ data: data as never }),
    );
    await chunks(stamp(this.rows.assignments, 'recordedAt'), (data) =>
      db.orgAssignment.createMany({ data: data as never }),
    );
    // Leave the company's code counters past the codes used here, like a real write would.
    const counters = await db.orgCompany.findUniqueOrThrow({
      where: { companyId: this.companyId },
    });
    await db.orgCompany.update({
      where: { companyId: this.companyId },
      data: {
        nextUnitNo: Math.max(counters.nextUnitNo, this.units + 1),
        nextPositionNo: Math.max(counters.nextPositionNo, this.positions + 1),
      },
    });
    for (const key of Object.keys(this.rows) as (keyof typeof this.rows)[]) this.rows[key] = [];
  }
}

/** Deterministic pseudo-random numbers, so the fixture is the same on every run. */
function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

/**
 * About `target` positions in 8 levels: each unit has a supervisory head position reporting to
 * the parent unit's head, plus staff positions. About 8% vacant, 3% of vacant heads covered by an
 * acting incumbent, 2% terminated incumbents, some dotted lines.
 */
export function largeCompany(fixture: OrgFixture, target = 6000, seed = 7) {
  const random = rng(seed);
  const heads: string[] = [];
  const staff: string[] = [];
  const root = fixture.unit('مدیرعامل');
  const ceo = fixture.position(root, 'مدیرعامل', { supervisory: true });
  fixture.supervise(root, ceo);
  heads.push(ceo);
  let frontier = [{ unit: root, head: ceo }];
  let count = 1;
  for (let level = 2; level <= 8 && count < target; level++) {
    const next: typeof frontier = [];
    for (const parent of frontier) {
      const children = level <= 3 ? 4 : 3;
      for (let c = 0; c < children && count < target; c++) {
        const unit = fixture.unit(`واحد ${level}-${count}`, parent.unit);
        const head = fixture.position(unit, `رئیس واحد ${count}`, {
          supervisory: true,
          reportsTo: parent.head,
        });
        fixture.supervise(unit, head);
        heads.push(head);
        count += 1;
        const staffCount = level >= 6 ? 3 : 1;
        for (let s = 0; s < staffCount && count < target; s++) {
          staff.push(fixture.position(unit, `کارشناس ${count}`, { reportsTo: head }));
          count += 1;
        }
        next.push({ unit, head });
      }
    }
    frontier = next;
  }
  // Fill up to the target with staff under random leaf heads.
  const leaves = frontier;
  while (count < target) {
    const leaf = leaves[Math.floor(random() * leaves.length)]!;
    staff.push(fixture.position(leaf.unit, `کارشناس ${count}`, { reportsTo: leaf.head }));
    count += 1;
  }
  const all = [...heads, ...staff];
  const headSet = new Set(heads);
  const people: { personId: string; positionId: string }[] = [];
  for (const positionId of all) {
    const roll = random();
    if (roll < 0.08) {
      if (headSet.has(positionId) && random() < 0.4) {
        fixture.assign(fixture.person(), positionId, 'acting');
      }
      continue;
    }
    const personId = fixture.person(roll < 0.1 ? 'terminated' : 'active');
    fixture.assign(personId, positionId);
    people.push({ personId, positionId });
  }
  const dotted = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const from = all[Math.floor(random() * all.length)]!;
    const to = heads[Math.floor(random() * heads.length)]!;
    if (from === to || dotted.has(`${from}>${to}`)) continue;
    dotted.add(`${from}>${to}`);
    fixture.line(from, to, 'dotted');
  }
  return { ceo, heads, staff, people };
}
