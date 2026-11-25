import { type FactoryProvider } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { platformV1 } from '@eve/contracts';
import { OrgService } from '../../org/service/index';
import { TEAM_PORT, type TeamPort } from '../ports/team.port';

/** TeamPort over org's public service. org also reads people, so it is resolved lazily. */
export class OrgTeamAdapter implements TeamPort {
  constructor(private readonly org: () => Pick<OrgService, 'teamMembersLedBy'>) {}

  membersLedBy(
    companyId: string,
    leadPersonId: string,
    asOf: platformV1.BusinessDate,
  ): Promise<ReadonlySet<string>> {
    return this.org().teamMembersLedBy(companyId, leadPersonId, asOf);
  }
}

/** Nest wiring: org and people depend on each other, so neither module imports the other. */
export const orgTeamProvider: FactoryProvider<TeamPort> = {
  provide: TEAM_PORT,
  useFactory: (refs: ModuleRef) =>
    new OrgTeamAdapter(() => refs.get(OrgService, { strict: false })),
  inject: [ModuleRef],
};
