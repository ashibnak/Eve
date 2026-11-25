import { ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { peopleV1, type platformV1 } from '@eve/contracts';
import { ConfigService } from '../../../../platform/config/config.service';
import { TimeZoneSetting } from '../../../../platform/config/settings';
import { Clock } from '../../../../platform/context/clock';
import { currentActor } from '../../../../platform/context/request-context';
import { businessDateIn } from '../../../../platform/dates/dates';
import { AccessService } from '../../../../platform/scope/access.service';
import { ScopedDb } from '../../../../platform/scope/scoped-db';
import { type ScopedPrisma } from '../../../../platform/scope/scoped-prisma';
import { dateOf, toView } from '../model/person';
import { PeoplePermissions } from '../people.permissions';
import { TEAM_PORT, type TeamPort } from '../ports/team.port';

/** Above this many ids, reads go by company and filter in memory (long IN lists are slow). */
const MANY = 500;

export interface ListOptions extends peopleV1.AsOfOptions {
  activeOnly?: boolean;
  personnelCode?: string;
  limit?: number;
}

/**
 * The person register, read-only (people/v1 PeopleReadService). A caller reads a person when
 * their `people.person.read` scope covers the person's company, or when the person is in a team
 * they lead on the date asked (decision 2026-11-25). An agent reads with its user's access.
 */
@Injectable()
export class PeopleService implements peopleV1.PeopleReadService, peopleV1.PeopleDirectoryService {
  constructor(
    private readonly db: ScopedDb,
    private readonly config: ConfigService,
    private readonly clock: Clock,
    private readonly access: AccessService,
    @Inject(TEAM_PORT) private readonly team: TeamPort,
  ) {}

  /** One person, or null when not found or not readable; 403 when the caller reads nobody at all. */
  async getPerson(
    id: string,
    options: peopleV1.AsOfOptions = {},
  ): Promise<peopleV1.PersonView | null> {
    const asOf = await this.asOf(options);
    const { views, scoped } = await this.readable([id], asOf);
    if (views.length === 0 && !scoped) throw new ForbiddenException();
    return views[0] ?? null;
  }

  /**
   * The people among `ids` the caller may read (others are left out, no error). With
   * `companyId`, only people of that company, read by company: fast for whole teams.
   */
  async getMany(
    ids: readonly string[],
    options: peopleV1.GetManyOptions = {},
  ): Promise<peopleV1.PersonView[]> {
    if (ids.length === 0) return [];
    const asOf = await this.asOf(options);
    return (await this.readable([...new Set(ids)], asOf, options.companyId)).views;
  }

  async findByPersonnelCode(
    companyId: string,
    personnelCode: string,
    options: peopleV1.AsOfOptions = {},
  ): Promise<peopleV1.PersonView | null> {
    const db = await this.db.forCompany(PeoplePermissions.read, companyId);
    const row = await db.peoplePerson.findUnique({
      where: { companyId_personnelCode: { companyId, personnelCode } },
    });
    if (!row) return null;
    const asOf = await this.asOf(options);
    return toView(
      row,
      (await this.statusesOn(db, { personId: row.id }, asOf)).get(row.id) ?? null,
      asOf,
    );
  }

  /** People employed on `asOf`: status `active` or `on_leave` (product-owner decision, S4). */
  async listActive(
    companyId: string,
    options: peopleV1.AsOfOptions = {},
  ): Promise<peopleV1.PersonView[]> {
    return this.list(companyId, { ...options, activeOnly: true, limit: Number.MAX_SAFE_INTEGER });
  }

  async list(companyId: string, options: ListOptions = {}): Promise<peopleV1.PersonView[]> {
    const db = await this.db.forCompany(PeoplePermissions.read, companyId);
    const asOf = await this.asOf(options);
    const rows = await db.peoplePerson.findMany({
      where: {
        companyId,
        ...(options.personnelCode ? { personnelCode: options.personnelCode } : {}),
      },
      orderBy: { personnelCode: 'asc' },
    });
    // By company, not by id list: a large company would exceed PostgreSQL's parameter limit.
    const statuses = await this.statusesOn(db, { companyId }, asOf);
    const views = rows.map((r) => toView(r, statuses.get(r.id) ?? null, asOf));
    const filtered = options.activeOnly
      ? views.filter((v) => peopleV1.isActiveStatus(v.status))
      : views;
    return filtered.slice(0, options.limit ?? 1000);
  }

  /** The person the signed-in user is in a company (their link), or null. Reading your own link needs no permission. */
  async myPersonId(companyId: string): Promise<string | null> {
    const actor = currentActor();
    const userId =
      actor?.kind === 'user' ? actor.id : actor?.kind === 'agent' ? actor.onBehalfOf : null;
    if (!userId) return null;
    const link = await this.db.afterOwnCheck().peopleUserLink.findFirst({
      where: { userId, companyId, endedAt: null },
      select: { personId: true },
    });
    return link?.personId ?? null;
  }

  /**
   * Which people of a company are employed on `asOf` (all of them when `personIds` is null). For
   * modules that must know whether someone counts, e.g. org treating a terminated incumbent as a
   * vacancy. It reveals the yes/no only, never personal data, so it needs no people permission.
   */
  async employedAmong(
    companyId: string,
    personIds: readonly string[] | null,
    asOf: platformV1.BusinessDate,
  ): Promise<ReadonlySet<string>> {
    if (personIds?.length === 0) return new Set();
    const day = dateOf(asOf);
    const rows = await this.db.afterOwnCheck().peopleEmploymentStatus.findMany({
      where: {
        companyId,
        ...(personIds ? { personId: { in: [...personIds] } } : {}),
        status: { in: [...peopleV1.ACTIVE_STATUSES] },
        validFrom: { lte: day },
        OR: [{ validTo: null }, { validTo: { gt: day } }],
      },
      select: { personId: true },
    });
    return new Set(rows.map((r) => r.personId));
  }

  /** The company a person record belongs to, or null (an id only, no personal data). */
  async companyOf(personId: string): Promise<string | null> {
    const row = await this.db.afterOwnCheck().peoplePerson.findUnique({
      where: { id: personId },
      select: { companyId: true },
    });
    return row?.companyId ?? null;
  }

  /**
   * Views of the people among `ids` the caller may read: by role scope, else as their team lead.
   * `scoped` tells whether the caller has any people scope at all.
   */
  private async readable(
    ids: readonly string[],
    asOf: platformV1.BusinessDate,
    companyId?: string,
  ): Promise<{ views: peopleV1.PersonView[]; scoped: boolean }> {
    const actor = currentActor();
    if (!actor) throw new UnauthorizedException();
    const db = this.db.afterOwnCheck();
    const wanted = new Set(ids);
    const byCompany = companyId !== undefined && ids.length > MANY;
    // Rows and statuses are read before the check, but nothing leaves this method unless allowed.
    const [scope, rows, statuses] = await Promise.all([
      this.access.scopeFor(actor, PeoplePermissions.read),
      db.peoplePerson
        .findMany({
          where: this.whereIds(ids, companyId),
          // Timestamps are not part of a view; skipping them halves the cost of large reads.
          omit: { createdAt: true, updatedAt: true },
          orderBy: { personnelCode: 'asc' },
        })
        .then((found) => found.filter((r) => wanted.has(r.id))),
      this.statusesOn(db, byCompany ? { companyId } : { personId: { in: [...ids] } }, asOf),
    ]);
    const scoped = scope.customerWide || scope.companyIds.size > 0;
    const allowed = new Set(
      rows.filter((r) => scope.customerWide || scope.companyIds.has(r.companyId)).map((r) => r.id),
    );
    const otherCompanies = new Set(rows.filter((r) => !allowed.has(r.id)).map((r) => r.companyId));
    for (const other of otherCompanies) {
      const lead = await this.myPersonId(other);
      if (!lead) continue;
      const members = await this.team.membersLedBy(other, lead, asOf);
      for (const r of rows) if (r.companyId === other && members.has(r.id)) allowed.add(r.id);
    }
    const views = rows
      .filter((r) => allowed.has(r.id))
      .map((r) => toView(r, statuses.get(r.id) ?? null, asOf));
    return { views, scoped };
  }

  /** Where-clause for person rows by id (optionally of one company); long lists read the company. */
  private whereIds(ids: readonly string[], companyId: string | undefined) {
    if (companyId === undefined) return { id: { in: [...ids] } };
    return ids.length > MANY ? { companyId } : { companyId, id: { in: [...ids] } };
  }

  private async statusesOn(
    db: ScopedPrisma,
    who: { personId: string | { in: string[] } } | { companyId: string },
    asOf: platformV1.BusinessDate,
  ): Promise<Map<string, peopleV1.EmploymentStatus>> {
    const day = dateOf(asOf);
    const rows = await db.peopleEmploymentStatus.findMany({
      where: {
        ...who,
        validFrom: { lte: day },
        OR: [{ validTo: null }, { validTo: { gt: day } }],
      },
      select: { personId: true, status: true },
    });
    return new Map(rows.map((r) => [r.personId, r.status as peopleV1.EmploymentStatus]));
  }

  private async asOf(options: peopleV1.AsOfOptions): Promise<platformV1.BusinessDate> {
    return options.asOf ?? businessDateIn(this.clock.now(), await this.config.get(TimeZoneSetting));
  }
}
