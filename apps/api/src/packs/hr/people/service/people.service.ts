import { Injectable } from '@nestjs/common';
import { peopleV1, type platformV1 } from '@eve/contracts';
import { ConfigService } from '../../../../platform/config/config.service';
import { TimeZoneSetting } from '../../../../platform/config/settings';
import { Clock } from '../../../../platform/context/clock';
import { businessDateIn } from '../../../../platform/dates/dates';
import { ScopedDb } from '../../../../platform/scope/scoped-db';
import { type ScopedPrisma } from '../../../../platform/scope/scoped-prisma';
import { dateOf, toView } from '../model/person';
import { PeoplePermissions } from '../people.permissions';

export interface ListOptions extends peopleV1.AsOfOptions {
  activeOnly?: boolean;
  personnelCode?: string;
  limit?: number;
}

/**
 * The person register, read-only (people/v1 PeopleReadService). Every call reads through the
 * scope layer with the caller's `people.person.read` permission, so a user (or an agent acting for
 * one) only ever sees the companies they may see.
 */
@Injectable()
export class PeopleService implements peopleV1.PeopleReadService {
  constructor(
    private readonly db: ScopedDb,
    private readonly config: ConfigService,
    private readonly clock: Clock,
  ) {}

  async getPerson(
    id: string,
    options: peopleV1.AsOfOptions = {},
  ): Promise<peopleV1.PersonView | null> {
    const db = await this.db.for(PeoplePermissions.read);
    const row = await db.peoplePerson.findUnique({ where: { id } });
    if (!row) return null;
    const asOf = await this.asOf(options);
    return toView(
      row,
      (await this.statusesOn(db, { personId: row.id }, asOf)).get(row.id) ?? null,
      asOf,
    );
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

  private async statusesOn(
    db: ScopedPrisma,
    who: { personId: string } | { companyId: string },
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
