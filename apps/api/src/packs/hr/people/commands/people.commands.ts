import { Injectable, NotFoundException } from '@nestjs/common';
import type { peopleV1, platformV1 } from '@eve/contracts';
import { TxRunner } from '../../../../platform/context/tx-runner';
import { ScopedDb } from '../../../../platform/scope/scoped-db';
import { type PersonFields } from '../model/person';
import { PeoplePermissions } from '../people.permissions';
import { PeopleWriter } from './people-writer';

/** Manual changes to the register by the people data owner (each audited, with a reason). */
@Injectable()
export class PeopleCommands {
  constructor(
    private readonly db: ScopedDb,
    private readonly txRunner: TxRunner,
    private readonly writer: PeopleWriter,
  ) {}

  /** Changes a person's employment status from `validFrom` on (past dates allowed, audited). */
  async changeStatus(
    personId: string,
    status: peopleV1.EmploymentStatus,
    validFrom: platformV1.BusinessDate,
    reason: string,
  ): Promise<boolean> {
    const person = await this.visible(personId);
    return this.txRunner.run((tx) =>
      this.writer.changeStatus(tx, person, status, validFrom, reason),
    );
  }

  /** Corrects names, hire date or contact of a person (a data fix, not an HR event). */
  async correct(
    personId: string,
    changes: Partial<Omit<PersonFields, 'personnelCode'>>,
    reason: string,
  ): Promise<boolean> {
    const person = await this.visible(personId);
    return this.txRunner.run((tx) => this.writer.correct(tx, person, changes, reason));
  }

  /** The person if the caller may change it (write permission over its company), else 404. */
  private async visible(personId: string) {
    const db = await this.db.for(PeoplePermissions.write);
    const person = await db.peoplePerson.findUnique({ where: { id: personId } });
    if (!person) throw new NotFoundException('Person not found');
    return person;
  }
}
