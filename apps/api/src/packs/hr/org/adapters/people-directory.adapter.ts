import { type FactoryProvider } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { peopleV1, type platformV1 } from '@eve/contracts';
import { PeopleService } from '../../people/service/index';
import {
  PEOPLE_DIRECTORY_PORT,
  type PeopleDirectoryPort,
  type PersonCard,
} from '../ports/people-directory.port';

type People = Pick<
  PeopleService,
  'getMany' | 'employedAmong' | 'myPersonId' | 'companyOf' | 'idsByPersonnelCode' | 'myCompanies'
>;

/** PeopleDirectoryPort over people's public service (resolved lazily: people also reads org). */
export class PeopleDirectoryAdapter implements PeopleDirectoryPort {
  constructor(private readonly people: () => People) {}

  async cards(
    companyId: string,
    personIds: readonly string[],
    asOf: platformV1.BusinessDate,
  ): Promise<ReadonlyMap<string, PersonCard>> {
    const views = await this.people().getMany(personIds, { asOf, companyId });
    return new Map(
      views.map((v) => [
        v.id,
        {
          personnelCode: v.personnelCode,
          name: { first: v.name.first.fa, last: v.name.last.fa },
          employed: peopleV1.isActiveStatus(v.status),
        },
      ]),
    );
  }

  employed(
    companyId: string,
    personIds: readonly string[] | null,
    asOf: platformV1.BusinessDate,
  ): Promise<ReadonlySet<string>> {
    return this.people().employedAmong(companyId, personIds, asOf);
  }

  me(companyId: string): Promise<string | null> {
    return this.people().myPersonId(companyId);
  }

  companyOf(personId: string): Promise<string | null> {
    return this.people().companyOf(personId);
  }

  myCompanies(): Promise<string[]> {
    return this.people().myCompanies();
  }

  idsByPersonnelCode(companyId: string): Promise<ReadonlyMap<string, string>> {
    return this.people().idsByPersonnelCode(companyId);
  }
}

/** Nest wiring: org and people depend on each other, so neither module imports the other. */
export const peopleDirectoryProvider: FactoryProvider<PeopleDirectoryPort> = {
  provide: PEOPLE_DIRECTORY_PORT,
  useFactory: (refs: ModuleRef) =>
    new PeopleDirectoryAdapter(() => refs.get(PeopleService, { strict: false })),
  inject: [ModuleRef],
};
