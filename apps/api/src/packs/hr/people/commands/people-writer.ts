import { ConflictException, Injectable } from '@nestjs/common';
import type { peopleV1, platformV1 } from '@eve/contracts';
import { AuditService } from '../../../../platform/audit/audit.service';
import { Clock } from '../../../../platform/context/clock';
import { type Tx } from '../../../../platform/context/tx-runner';
import { EventPublisher } from '../../../../platform/events/event-publisher';
import { PersonCreated, PersonStatusChanged } from '../events/people.events';
import { dateOf, day, type PersonFields, fieldsOf, type PersonRow } from '../model/person';

/**
 * The only writer of people data (CLAUDE.md rule 8). Every method runs inside the caller's
 * transaction and writes its own audit row and events, so commands and file imports share the
 * exact same rules.
 */
@Injectable()
export class PeopleWriter {
  constructor(
    private readonly audit: AuditService,
    private readonly events: EventPublisher,
    private readonly clock: Clock,
  ) {}

  /** Adds a person with an initial status from `from` (the register knows nothing earlier). */
  async create(
    tx: Tx,
    companyId: string,
    fields: PersonFields,
    status: peopleV1.EmploymentStatus,
    from: platformV1.BusinessDate,
    reason: string,
  ): Promise<string> {
    const now = this.clock.now();
    const person = await tx.peoplePerson.create({
      data: {
        companyId,
        personnelCode: fields.personnelCode,
        firstNameFa: fields.firstNameFa,
        lastNameFa: fields.lastNameFa,
        firstNameEn: fields.firstNameEn,
        lastNameEn: fields.lastNameEn,
        hireDate: dateOf(fields.hireDate),
        contactChannel: fields.contact?.channel ?? null,
        contactAddress: fields.contact?.address ?? null,
        createdAt: now,
        updatedAt: now,
      },
      select: { id: true },
    });
    await tx.peopleEmploymentStatus.create({
      data: { personId: person.id, companyId, status, validFrom: dateOf(from), recordedAt: now },
    });
    await this.audit.record(tx, {
      action: 'people.person.create',
      entityType: 'people_person',
      entityId: person.id,
      companyId,
      before: null,
      after: { ...fields, status, statusFrom: from },
      reason,
    });
    await this.events.publish(tx, {
      event: PersonCreated,
      payload: { person_id: person.id, personnel_code: fields.personnelCode, status },
      effectiveAt: from,
      companyId,
    });
    return person.id;
  }

  /** Data correction of identity fields (names, hire date, contact). Returns false if nothing changed. */
  async correct(
    tx: Tx,
    person: PersonRow,
    changes: Partial<Omit<PersonFields, 'personnelCode'>>,
    reason: string,
  ): Promise<boolean> {
    const current = fieldsOf(person);
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(changes) as [keyof PersonFields, unknown][]) {
      if (value === undefined) continue;
      if (JSON.stringify(current[key]) !== JSON.stringify(value)) {
        before[key] = current[key];
        after[key] = value;
      }
    }
    if (Object.keys(after).length === 0) return false;
    const next = { ...current, ...changes } as PersonFields;
    await tx.peoplePerson.update({
      where: { id: person.id },
      data: {
        firstNameFa: next.firstNameFa,
        lastNameFa: next.lastNameFa,
        firstNameEn: next.firstNameEn,
        lastNameEn: next.lastNameEn,
        hireDate: dateOf(next.hireDate),
        contactChannel: next.contact?.channel ?? null,
        contactAddress: next.contact?.address ?? null,
        updatedAt: this.clock.now(),
      },
    });
    await this.audit.record(tx, {
      action: 'people.person.correct',
      entityType: 'people_person',
      entityId: person.id,
      companyId: person.companyId,
      before,
      after,
      reason,
    });
    return true;
  }

  /**
   * Changes the status from `from` on: the period in force closes at `from`, a new one opens.
   * Refused when a later change exists (correcting history after it is out of R1 scope) or when a
   * period already starts on that date. Returns false when the status is already in force.
   */
  async changeStatus(
    tx: Tx,
    person: { id: string; companyId: string; personnelCode: string },
    status: peopleV1.EmploymentStatus,
    from: platformV1.BusinessDate,
    reason: string,
  ): Promise<boolean> {
    await tx.$executeRaw`SELECT 1 FROM people_person WHERE id = ${person.id}::uuid FOR UPDATE`;
    const periods = await tx.peopleEmploymentStatus.findMany({
      where: { personId: person.id },
      orderBy: { validFrom: 'asc' },
    });
    if (periods.some((p) => day(p.validFrom) > from)) {
      throw new ConflictException(
        `${person.personnelCode}: a later status change exists; ${from} cannot be inserted before it`,
      );
    }
    const inForce = periods.find(
      (p) => day(p.validFrom) <= from && (!p.validTo || day(p.validTo) > from),
    );
    if (inForce?.status === status) return false;
    if (inForce && day(inForce.validFrom) === from) {
      throw new ConflictException(`${person.personnelCode}: a status already starts on ${from}`);
    }
    const now = this.clock.now();
    if (inForce) {
      await tx.peopleEmploymentStatus.update({
        where: { id: inForce.id },
        data: { validTo: dateOf(from) },
      });
    }
    await tx.peopleEmploymentStatus.create({
      data: {
        personId: person.id,
        companyId: person.companyId,
        status,
        validFrom: dateOf(from),
        recordedAt: now,
      },
    });
    const previous = (inForce?.status ?? null) as peopleV1.EmploymentStatus | null;
    await this.audit.record(tx, {
      action: 'people.person.status_change',
      entityType: 'people_person',
      entityId: person.id,
      companyId: person.companyId,
      before: { status: previous },
      after: { status, validFrom: from },
      reason,
    });
    await this.events.publish(tx, {
      event: PersonStatusChanged,
      payload: {
        person_id: person.id,
        personnel_code: person.personnelCode,
        from: previous,
        to: status,
      },
      effectiveAt: from,
      companyId: person.companyId,
    });
    return true;
  }
  /**
   * Links a login to this person for the person's company, ending any earlier link of either
   * (one login per person per company). Returns false if exactly this link already exists.
   */
  async linkUser(
    tx: Tx,
    person: { id: string; companyId: string; personnelCode: string },
    userId: string,
    reason: string,
  ): Promise<boolean> {
    const current = await tx.peopleUserLink.findMany({
      where: {
        endedAt: null,
        OR: [{ personId: person.id }, { userId, companyId: person.companyId }],
      },
    });
    if (current.some((l) => l.personId === person.id && l.userId === userId)) return false;
    const now = this.clock.now();
    for (const link of current) {
      await tx.peopleUserLink.update({ where: { id: link.id }, data: { endedAt: now } });
    }
    await tx.peopleUserLink.create({
      data: { userId, companyId: person.companyId, personId: person.id, linkedAt: now },
    });
    await this.audit.record(tx, {
      action: 'people.person.link_user',
      entityType: 'people_person',
      entityId: person.id,
      companyId: person.companyId,
      before: { links: current.map((l) => ({ userId: l.userId, personId: l.personId })) },
      after: { userId, personId: person.id },
      reason,
    });
    return true;
  }
}
