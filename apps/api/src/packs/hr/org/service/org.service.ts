import { AsyncLocalStorage } from 'node:async_hooks';
import { ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { orgV1, platformV1 } from '@eve/contracts';
import { ConfigService } from '../../../../platform/config/config.service';
import { TimeZoneSetting } from '../../../../platform/config/settings';
import { Clock } from '../../../../platform/context/clock';
import { currentActor } from '../../../../platform/context/request-context';
import { businessDateIn } from '../../../../platform/dates/dates';
import { AccessService, type ResolvedScope } from '../../../../platform/scope/access.service';
import { ScopedDb } from '../../../../platform/scope/scoped-db';
import { type ScopedPrisma } from '../../../../platform/scope/scoped-prisma';
import { dateOf, dayOf, validOn } from '../model/period';
import { OrgPermissions } from '../org.permissions';
import { PEOPLE_DIRECTORY_PORT, type PeopleDirectoryPort } from '../ports/people-directory.port';

type Input<K extends keyof typeof orgV1.OrgTools> = orgV1.OrgToolInput<K>;

type SupervisingKind = 'primary' | 'acting' | 'temporary_supervision';
const SUPERVISING: readonly SupervisingKind[] = ['primary', 'acting', 'temporary_supervision'];
const KIND_RANK: Record<orgV1.AssignmentKind, number> = {
  primary: 0,
  acting: 1,
  temporary_supervision: 2,
  project: 3,
};
/** Guard against a cycle in bad data: no company has a direct line this deep. */
const MAX_DEPTH = 100;

/**
 * Company-wide reads shared within one service call (and the people reads it triggers, which call
 * back into org for team-lead access). Nothing outlives the call, so nothing can go stale.
 */
const callCache = new AsyncLocalStorage<Map<string, Promise<unknown>>>();

function shared<T>(key: string, load: () => Promise<T>): Promise<T> {
  const cache = callCache.getStore();
  if (!cache) return load();
  let found = cache.get(key) as Promise<T> | undefined;
  if (!found) {
    found = load();
    cache.set(key, found);
  }
  return found;
}

interface AssignmentRow {
  personId: string;
  positionId: string;
  kind: string;
  timeShare: { toNumber(): number };
  /** Absent on bulk reads (a Date per row is costly); then ties go by person id. */
  validFrom?: Date;
}

interface Candidate {
  personId: string;
  via: SupervisingKind;
}

/**
 * Order of incumbents on a position: primary, acting, temporary supervision, project; then the
 * larger time share, the earlier start, the person id. Sorting thousands of rows, so it compares
 * plain numbers and strings (no Decimal or locale-aware comparison).
 */
function byPrecedence<T extends AssignmentRow>(rows: readonly T[]): T[] {
  const keyed = rows.map((row) => ({
    row,
    rank: KIND_RANK[row.kind as orgV1.AssignmentKind],
    share: row.timeShare.toNumber(),
    since: row.validFrom?.getTime() ?? 0,
  }));
  keyed.sort(
    (a, b) =>
      a.rank - b.rank ||
      b.share - a.share ||
      a.since - b.since ||
      (a.row.personId < b.row.personId ? -1 : a.row.personId > b.row.personId ? 1 : 0),
  );
  return keyed.map((k) => k.row);
}

function hasScope(scope: ResolvedScope): boolean {
  return scope.customerWide || scope.companyIds.size > 0;
}

function covers(scope: ResolvedScope, companyId: string): boolean {
  return scope.customerWide || scope.companyIds.has(companyId);
}

/**
 * org read services (spec §7), one per agent tool in `contracts/org/v1`. All answer for a business
 * date (`asOf`, default today in the customer's zone) from the version rows valid on that date.
 *
 * Access: `org.structure.read` over the company (org_data_owner, auditor); a linked user about
 * themselves (position, manager, chain, informed: spec §2); a team lead for the team of a
 * supervisory position they hold. Incumbent names appear only for people the caller may read.
 */
@Injectable()
export class OrgService implements orgV1.OrgReadService, orgV1.OrgTeamService {
  constructor(
    private readonly db: ScopedDb,
    private readonly access: AccessService,
    private readonly config: ConfigService,
    private readonly clock: Clock,
    @Inject(PEOPLE_DIRECTORY_PORT) private readonly people: PeopleDirectoryPort,
  ) {}

  async getPosition(input: Input<'getPosition'>): Promise<orgV1.PositionView | null> {
    const identity = await this.db.afterOwnCheck().orgPosition.findUnique({
      where: { id: input.positionId },
      select: { companyId: true },
    });
    if (!identity) return null;
    const db = await this.db.forCompany(OrgPermissions.read, identity.companyId);
    const asOf = await this.asOf(input.asOf);
    const day = dateOf(asOf);
    const [version, parent, assignments] = await Promise.all([
      db.orgPositionVersion.findFirst({
        where: { positionId: input.positionId, ...validOn(day) },
        include: { position: { select: { code: true } } },
      }),
      db.orgReportingLine.findFirst({
        where: { fromPositionId: input.positionId, kind: 'direct', ...validOn(day) },
        select: { toPositionId: true },
      }),
      db.orgAssignment.findMany({
        where: { positionId: input.positionId, ...validOn(day) },
        select: assignmentFields,
      }),
    ]);
    if (!version) return null;
    const incumbents =
      (await this.incumbents(identity.companyId, assignments, asOf)).get(input.positionId) ?? [];
    return {
      ...positionFields(version),
      reportsToPositionId: parent?.toPositionId ?? null,
      occupancy: incumbents.some((i) => i.kind === 'primary' && i.active) ? 'filled' : 'vacant',
      incumbents,
      asOf,
    };
  }

  async getPersonPosition(input: Input<'getPersonPosition'>): Promise<orgV1.PersonPosition[]> {
    const reader = await this.personReader(input.personId);
    if (!reader) return [];
    const asOf = await this.asOf(input.asOf);
    const rows = await reader.db.orgAssignment.findMany({
      where: { personId: input.personId, ...validOn(dateOf(asOf)) },
      select: assignmentFields,
    });
    return byPrecedence(rows).map((r) => ({
      positionId: r.positionId,
      kind: r.kind as orgV1.AssignmentKind,
      timeShare: r.timeShare.toNumber(),
      validFrom: dayOf(r.validFrom),
    }));
  }

  async getManager(input: Input<'getManager'>): Promise<orgV1.Manager | null> {
    return (await this.getApprovalChain({ ...input, levels: 1 }))[0] ?? null;
  }

  /**
   * Spec §3: from the position above the person's primary position, its primary incumbent, else
   * its acting or temporary supervisor, else the next position up. A closed position, or an
   * incumbent not employed on the date, counts as vacant. A person appears at most once.
   */
  async getApprovalChain(input: Input<'getApprovalChain'>): Promise<orgV1.Manager[]> {
    const reader = await this.personReader(input.personId);
    if (!reader) return [];
    const asOf = await this.asOf(input.asOf);
    const day = dateOf(asOf);
    const own = await this.primaryPosition(reader.db, input.personId, day);
    if (!own) return [];
    const above = await this.ancestors(reader.db, own, day);
    const candidates = await this.supervisors(reader.db, reader.companyId, above, asOf);
    const seen = new Set([input.personId]);
    const chain: orgV1.Manager[] = [];
    for (const [index, positionId] of above.entries()) {
      if (chain.length >= input.levels) break;
      const found = candidates.get(positionId)?.find((c) => !seen.has(c.personId));
      if (!found) continue;
      seen.add(found.personId);
      chain.push({ personId: found.personId, positionId, via: found.via, levelsUp: index + 1 });
    }
    return chain;
  }

  /** Incumbents of the positions the person's primary position reports to by dotted or project line. */
  async getInformed(input: Input<'getInformed'>): Promise<Omit<orgV1.Manager, 'levelsUp'>[]> {
    const reader = await this.personReader(input.personId);
    if (!reader) return [];
    const asOf = await this.asOf(input.asOf);
    const day = dateOf(asOf);
    const own = await this.primaryPosition(reader.db, input.personId, day);
    if (!own) return [];
    const lines = await reader.db.orgReportingLine.findMany({
      where: { fromPositionId: own, kind: { in: ['dotted', 'project'] }, ...validOn(day) },
      select: { toPositionId: true },
      orderBy: { toPositionId: 'asc' },
    });
    const targets = [...new Set(lines.map((l) => l.toPositionId))];
    const candidates = await this.supervisors(reader.db, reader.companyId, targets, asOf);
    return targets.flatMap((positionId) => {
      const found = candidates.get(positionId)?.find((c) => c.personId !== input.personId);
      return found ? [{ personId: found.personId, positionId, via: found.via }] : [];
    });
  }

  getTeam(input: Input<'getTeam'>): Promise<orgV1.TeamMember[]> {
    return callCache.run(new Map(), () => this.team(input));
  }

  private async team(input: Input<'getTeam'>): Promise<orgV1.TeamMember[]> {
    const identity = await this.db.afterOwnCheck().orgPosition.findUnique({
      where: { id: input.positionId },
      select: { companyId: true },
    });
    if (!identity) return [];
    const asOf = await this.asOf(input.asOf);
    const day = dateOf(asOf);
    const db = await this.teamReader(identity.companyId, input.positionId, asOf);
    let members: { positionId: string; depth: number }[];
    let assignments: AssignmentRow[];
    if (input.depth === 'direct') {
      members = await this.subtree(db, identity.companyId, [input.positionId], day, 1);
      assignments = await assignmentsOf(
        db,
        identity.companyId,
        members.map((m) => m.positionId),
        day,
      );
    } else {
      // A subtree can be the whole company: read its assignments alongside the lines.
      const [found, all] = await Promise.all([
        this.subtree(db, identity.companyId, [input.positionId], day, MAX_DEPTH),
        assignmentsOf(db, identity.companyId, null, day),
      ]);
      const inTeam = new Set(found.map((m) => m.positionId));
      members = found;
      assignments = all.filter((a) => inTeam.has(a.positionId));
    }

    const incumbents = await this.incumbents(identity.companyId, assignments, asOf);
    return members.map((m) => ({ ...m, incumbents: incumbents.get(m.positionId) ?? [] }));
  }

  async getStructure(input: Input<'getStructure'>): Promise<orgV1.Structure> {
    const db = await this.db.forCompany(OrgPermissions.read, input.companyId);
    const asOf = await this.asOf(input.asOf);
    const [structure, employed] = await Promise.all([
      loadStructure(db, input.companyId, dateOf(asOf)),
      this.people.employed(input.companyId, null, asOf),
    ]);
    const parents = new Map(structure.lines.map((l) => [l.fromPositionId, l.toPositionId]));
    const counts = new Map<string, number>();
    const filled = new Set<string>();
    for (const a of structure.assignments) {
      counts.set(a.positionId, (counts.get(a.positionId) ?? 0) + 1);
      if (a.kind === 'primary' && employed.has(a.personId)) filled.add(a.positionId);
    }
    return {
      companyId: input.companyId,
      asOf,
      units: structure.units.map(unitView),
      positions: structure.positions.map((p) => ({
        ...positionFields(p),
        reportsToPositionId: parents.get(p.positionId) ?? null,
        occupancy: filled.has(p.positionId) ? ('filled' as const) : ('vacant' as const),
        incumbentCount: counts.get(p.positionId) ?? 0,
        asOf,
      })),
    };
  }

  /**
   * What changed between two dates: units and positions by their facts (incl. the line above),
   * and people whose primary position differs. Only rows with a version boundary between the two
   * dates can differ, so only those are compared.
   */
  async diffStructure(input: Input<'diffStructure'>): Promise<orgV1.StructureDiff> {
    const db = await this.db.forCompany(OrgPermissions.read, input.companyId);
    const [low, high] = [input.from, input.to].sort();
    const boundary = {
      companyId: input.companyId,
      OR: [
        { validFrom: { gt: dateOf(low!), lte: dateOf(high!) } },
        { validTo: { gt: dateOf(low!), lte: dateOf(high!) } },
      ],
    };
    const [units, positions, lines, moves] = await Promise.all([
      db.orgUnitVersion.findMany({ where: boundary, select: { unitId: true } }),
      db.orgPositionVersion.findMany({ where: boundary, select: { positionId: true } }),
      db.orgReportingLine.findMany({
        where: { ...boundary, kind: 'direct' },
        select: { fromPositionId: true },
      }),
      db.orgAssignment.findMany({
        where: { ...boundary, kind: 'primary' },
        select: { personId: true },
      }),
    ]);
    const only: Only = {
      unitIds: [...new Set(units.map((u) => u.unitId))],
      positionIds: [
        ...new Set([...positions.map((p) => p.positionId), ...lines.map((l) => l.fromPositionId)]),
      ],
      personIds: [...new Set(moves.map((a) => a.personId))],
    };
    const [before, after] = await Promise.all([
      loadStructure(db, input.companyId, dateOf(input.from), only),
      loadStructure(db, input.companyId, dateOf(input.to), only),
    ]);
    const unitSig = (s: Structure) =>
      new Map(s.units.map((u) => [u.unitId, JSON.stringify(unitView(u))]));
    const positionSig = (s: Structure) => {
      const parents = new Map(s.lines.map((l) => [l.fromPositionId, l.toPositionId]));
      return new Map(
        s.positions.map((p) => [
          p.positionId,
          JSON.stringify({ ...positionFields(p), up: parents.get(p.positionId) ?? null }),
        ]),
      );
    };
    const primaries = (s: Structure) =>
      new Map(
        s.assignments.filter((a) => a.kind === 'primary').map((a) => [a.personId, a.positionId]),
      );
    const from = primaries(before);
    const to = primaries(after);
    const moved = [...new Set([...from.keys(), ...to.keys()])]
      .sort()
      .filter((p) => from.get(p) !== to.get(p))
      .map((personId) => ({
        personId,
        fromPositionId: from.get(personId) ?? null,
        toPositionId: to.get(personId) ?? null,
      }));
    return {
      from: input.from,
      to: input.to,
      units: compare(unitSig(before), unitSig(after)),
      positions: compare(positionSig(before), positionSig(after)),
      moved,
    };
  }

  /**
   * People in the team a person leads on `asOf` (for people's team-lead reads): incumbents of the
   * positions below the supervisory positions they hold, along direct lines. A lead not employed
   * on the date leads nobody. Ids only; the caller decides what to show.
   */
  async teamMembersLedBy(
    companyId: string,
    leadPersonId: string,
    asOf: platformV1.BusinessDate,
  ): Promise<ReadonlySet<string>> {
    const db = this.db.afterOwnCheck();
    const day = dateOf(asOf);
    const roots = await this.ledPositions(db, companyId, leadPersonId, asOf);
    if (roots.length === 0) return new Set();
    const [subtree, rows] = await Promise.all([
      this.subtree(db, companyId, roots, day, MAX_DEPTH),
      assignmentsOf(db, companyId, null, day),
    ]);
    const members = new Set(subtree.map((m) => m.positionId));
    return new Set(
      rows
        .filter((r) => members.has(r.positionId) && r.personId !== leadPersonId)
        .map((r) => r.personId),
    );
  }

  /** Who may read a person's position and managers: company org readers, or the person themself. */
  private async personReader(
    personId: string,
  ): Promise<{ db: ScopedPrisma; companyId: string } | null> {
    const scope = await this.scope();
    const companyId = await this.people.companyOf(personId);
    if (!companyId) {
      if (!hasScope(scope)) throw new ForbiddenException();
      return null;
    }
    if (covers(scope, companyId)) {
      return { db: await this.db.forCompany(OrgPermissions.read, companyId), companyId };
    }
    if ((await this.people.me(companyId)) === personId) {
      return { db: this.db.afterOwnCheck(), companyId };
    }
    throw new ForbiddenException();
  }

  /** Company org readers, or the lead of this (supervisory) position on the date. */
  private async teamReader(
    companyId: string,
    positionId: string,
    asOf: platformV1.BusinessDate,
  ): Promise<ScopedPrisma> {
    if (covers(await this.scope(), companyId)) {
      return this.db.forCompany(OrgPermissions.read, companyId);
    }
    const me = await this.people.me(companyId);
    const db = this.db.afterOwnCheck();
    if (me && (await this.ledPositions(db, companyId, me, asOf)).includes(positionId)) return db;
    throw new ForbiddenException();
  }

  /** Supervisory, not closed positions a person holds as primary, acting or temporary supervisor. */
  private async ledPositions(
    db: ScopedPrisma,
    companyId: string,
    personId: string,
    asOf: platformV1.BusinessDate,
  ): Promise<string[]> {
    const day = dateOf(asOf);
    if (!(await this.people.employed(companyId, [personId], asOf)).has(personId)) return [];
    const held = await db.orgAssignment.findMany({
      where: { companyId, personId, kind: { in: [...SUPERVISING] }, ...validOn(day) },
      select: { positionId: true },
    });
    if (held.length === 0) return [];
    const supervisory = await db.orgPositionVersion.findMany({
      where: {
        positionId: { in: held.map((h) => h.positionId) },
        supervisory: true,
        status: { not: 'closed' },
        ...validOn(day),
      },
      select: { positionId: true },
    });
    return supervisory.map((s) => s.positionId);
  }

  private async primaryPosition(db: ScopedPrisma, personId: string, day: Date) {
    const row = await db.orgAssignment.findFirst({
      where: { personId, kind: 'primary', ...validOn(day) },
      select: { positionId: true },
    });
    return row?.positionId ?? null;
  }

  /** Positions above, nearest first, along direct lines. */
  private async ancestors(db: ScopedPrisma, positionId: string, day: Date): Promise<string[]> {
    const chain: string[] = [];
    const seen = new Set([positionId]);
    let current = positionId;
    while (chain.length < MAX_DEPTH) {
      const line = await db.orgReportingLine.findFirst({
        where: { fromPositionId: current, kind: 'direct', ...validOn(day) },
        select: { toPositionId: true },
      });
      if (!line || seen.has(line.toPositionId)) break;
      seen.add(line.toPositionId);
      chain.push(line.toPositionId);
      current = line.toPositionId;
    }
    return chain;
  }

  /**
   * Positions below `roots` along direct lines, breadth first, with their depth. Direct reports
   * take one query; deeper walks read the company's direct lines once and walk them in memory.
   */
  private async subtree(
    db: ScopedPrisma,
    companyId: string,
    roots: readonly string[],
    day: Date,
    maxDepth: number,
  ): Promise<{ positionId: string; depth: number }[]> {
    const read = (where: object) =>
      db.orgReportingLine.findMany({
        where: { companyId, kind: 'direct', ...where, ...validOn(day) },
        select: { fromPositionId: true, toPositionId: true },
      });
    const lines =
      maxDepth === 1
        ? await read({ toPositionId: { in: [...roots] } })
        : await shared(`lines:${companyId}:${day.toISOString()}`, () => read({}));
    const children = new Map<string, string[]>();
    for (const l of lines) {
      const list = children.get(l.toPositionId);
      if (list) list.push(l.fromPositionId);
      else children.set(l.toPositionId, [l.fromPositionId]);
    }
    const found: { positionId: string; depth: number }[] = [];
    const seen = new Set(roots);
    let frontier = [...roots];
    for (let depth = 1; frontier.length > 0 && depth <= maxDepth; depth++) {
      const next: string[] = [];
      for (const parent of frontier) {
        for (const child of (children.get(parent) ?? []).sort()) {
          if (seen.has(child)) continue;
          seen.add(child);
          next.push(child);
          found.push({ positionId: child, depth });
        }
      }
      frontier = next;
    }
    return found;
  }

  /** Per position: employed supervising incumbents in order of precedence (closed = none). */
  private async supervisors(
    db: ScopedPrisma,
    companyId: string,
    positionIds: readonly string[],
    asOf: platformV1.BusinessDate,
  ): Promise<Map<string, Candidate[]>> {
    if (positionIds.length === 0) return new Map();
    const day = dateOf(asOf);
    const [open, assignments] = await Promise.all([
      db.orgPositionVersion.findMany({
        where: { positionId: { in: [...positionIds] }, status: { not: 'closed' }, ...validOn(day) },
        select: { positionId: true },
      }),
      db.orgAssignment.findMany({
        where: {
          positionId: { in: [...positionIds] },
          kind: { in: [...SUPERVISING] },
          ...validOn(day),
        },
        select: assignmentFields,
      }),
    ]);
    const employed = await this.people.employed(
      companyId,
      [...new Set(assignments.map((a) => a.personId))],
      asOf,
    );
    const openIds = new Set(open.map((o) => o.positionId));
    const result = new Map<string, Candidate[]>();
    for (const a of byPrecedence(assignments)) {
      if (!openIds.has(a.positionId) || !employed.has(a.personId)) continue;
      const list = result.get(a.positionId) ?? [];
      list.push({ personId: a.personId, via: a.kind as SupervisingKind });
      result.set(a.positionId, list);
    }
    return result;
  }

  /** Incumbents per position, with employment and (when readable) code and name. */
  private async incumbents(
    companyId: string,
    assignments: readonly AssignmentRow[],
    asOf: platformV1.BusinessDate,
  ): Promise<Map<string, orgV1.Incumbent[]>> {
    const ids = [...new Set(assignments.map((a) => a.personId))];
    if (ids.length === 0) return new Map();
    const cards = await this.people.cards(companyId, ids, asOf);
    // Cards carry employment; ask only about the people the caller may not read.
    const unread = ids.filter((id) => !cards.has(id));
    const employed = await this.people.employed(
      companyId,
      unread.length > 500 ? null : unread,
      asOf,
    );
    const result = new Map<string, orgV1.Incumbent[]>();
    for (const a of byPrecedence(assignments)) {
      const card = cards.get(a.personId);
      const list = result.get(a.positionId) ?? [];
      list.push({
        personId: a.personId,
        kind: a.kind as orgV1.AssignmentKind,
        timeShare: a.timeShare.toNumber(),
        active: card ? card.employed : employed.has(a.personId),
        personnelCode: card?.personnelCode ?? null,
        name: card?.name ?? null,
      });
      result.set(a.positionId, list);
    }
    return result;
  }

  private async scope(): Promise<ResolvedScope> {
    const actor = currentActor();
    if (!actor) throw new UnauthorizedException();
    return this.access.scopeFor(actor, OrgPermissions.read);
  }

  private async asOf(asOf: platformV1.BusinessDate | undefined): Promise<platformV1.BusinessDate> {
    return asOf ?? businessDateIn(this.clock.now(), await this.config.get(TimeZoneSetting));
  }
}

const assignmentFields = {
  personId: true,
  positionId: true,
  kind: true,
  timeShare: true,
  validFrom: true,
} as const;

/** Company-wide assignment reads skip the start date (see AssignmentRow). */
const bulkAssignmentFields = {
  personId: true,
  positionId: true,
  kind: true,
  timeShare: true,
} as const;

/** Ids to restrict `loadStructure` to (for a diff); absent = the whole company. */
interface Only {
  unitIds: string[];
  positionIds: string[];
  personIds: string[];
}

/**
 * What is valid on `day` in a company (or only for some ids). Codes are read apart: an include
 * would add a query with every id in it.
 */
async function loadStructure(db: ScopedPrisma, companyId: string, day: Date, only?: Only) {
  const skip = <T>(ids: string[] | undefined, read: () => Promise<T[]>): Promise<T[]> =>
    ids?.length === 0 ? Promise.resolve([]) : read();
  const [units, unitCodes, positions, positionCodes, lines, assignments] = await Promise.all([
    skip(only?.unitIds, () =>
      db.orgUnitVersion.findMany({
        where: { companyId, ...(only ? { unitId: { in: only.unitIds } } : {}), ...validOn(day) },
        omit: {
          id: true,
          recordedAt: true,
          validFrom: true,
          validTo: true,
          costCenter: true,
          location: true,
        },
        orderBy: { unitId: 'asc' },
      }),
    ),
    skip(only?.unitIds, () =>
      db.orgUnit.findMany({
        where: { companyId, ...(only ? { id: { in: only.unitIds } } : {}) },
        select: { id: true, code: true },
      }),
    ),
    skip(only?.positionIds, () =>
      db.orgPositionVersion.findMany({
        where: {
          companyId,
          ...(only ? { positionId: { in: only.positionIds } } : {}),
          ...validOn(day),
        },
        omit: { id: true, recordedAt: true, validFrom: true, validTo: true },
        orderBy: { positionId: 'asc' },
      }),
    ),
    skip(only?.positionIds, () =>
      db.orgPosition.findMany({
        where: { companyId, ...(only ? { id: { in: only.positionIds } } : {}) },
        select: { id: true, code: true },
      }),
    ),
    skip(only?.positionIds, () =>
      db.orgReportingLine.findMany({
        where: {
          companyId,
          kind: 'direct',
          ...(only ? { fromPositionId: { in: only.positionIds } } : {}),
          ...validOn(day),
        },
        select: { fromPositionId: true, toPositionId: true },
      }),
    ),
    skip(only?.personIds, () =>
      db.orgAssignment.findMany({
        where: {
          companyId,
          ...(only ? { personId: { in: only.personIds }, kind: 'primary' } : {}),
          ...validOn(day),
        },
        select: { personId: true, positionId: true, kind: true },
      }),
    ),
  ]);
  const unitCode = new Map(unitCodes.map((u) => [u.id, u.code]));
  const positionCode = new Map(positionCodes.map((p) => [p.id, p.code]));
  return {
    units: units.map((u) => ({ ...u, unit: { code: unitCode.get(u.unitId) ?? '' } })),
    positions: positions.map((p) => ({
      ...p,
      position: { code: positionCode.get(p.positionId) ?? '' },
    })),
    lines,
    assignments,
  };
}

/**
 * Assignments on `day` of some positions (null = all of the company); a long list reads the
 * company and filters in memory.
 */
async function assignmentsOf(
  db: ScopedPrisma,
  companyId: string,
  positionIds: readonly string[] | null,
  day: Date,
): Promise<AssignmentRow[]> {
  if (positionIds === null) {
    return shared(`assignments:${companyId}:${day.toISOString()}`, () =>
      db.orgAssignment.findMany({
        where: { companyId, ...validOn(day) },
        select: bulkAssignmentFields,
      }),
    );
  }
  if (positionIds.length === 0) return [];
  if (positionIds.length <= 500) {
    return db.orgAssignment.findMany({
      where: { positionId: { in: [...positionIds] }, ...validOn(day) },
      select: assignmentFields,
    });
  }
  const wanted = new Set(positionIds);
  const rows = await db.orgAssignment.findMany({
    where: { companyId, ...validOn(day) },
    select: bulkAssignmentFields,
  });
  return rows.filter((r) => wanted.has(r.positionId));
}

type Structure = Awaited<ReturnType<typeof loadStructure>>;

function unitView(u: Structure['units'][number]): orgV1.UnitView {
  return {
    id: u.unitId,
    companyId: u.companyId,
    code: u.unit.code,
    legacyCode: u.legacyCode,
    name: { fa: u.nameFa, en: u.nameEn },
    levelId: u.levelId,
    parentUnitId: u.parentUnitId,
    supervisorPositionId: u.supervisorPositionId,
    status: u.status as orgV1.UnitView['status'],
  };
}

function positionFields(p: Structure['positions'][number]) {
  return {
    id: p.positionId,
    companyId: p.companyId,
    code: p.position.code,
    legacyCode: p.legacyCode,
    title: { fa: p.titleFa, en: p.titleEn },
    unitId: p.unitId,
    jobId: p.jobId,
    type: p.type as orgV1.PositionView['type'],
    fte: p.fte.toNumber(),
    supervisory: p.supervisory,
    status: p.status as orgV1.PositionView['status'],
    source: p.source as orgV1.PositionView['source'],
  };
}

function compare(before: Map<string, string>, after: Map<string, string>) {
  const added = [...after.keys()].filter((id) => !before.has(id)).sort();
  const removed = [...before.keys()].filter((id) => !after.has(id)).sort();
  const changed = [...after.keys()]
    .filter((id) => before.has(id) && before.get(id) !== after.get(id))
    .sort();
  return { added, removed, changed };
}
