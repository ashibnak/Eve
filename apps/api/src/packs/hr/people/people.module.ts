import { Module, type OnModuleInit } from '@nestjs/common';
import { RoleRegistry } from '../../../platform/auth/roles';
import { ImportService } from '../../../platform/connectors/import.service';
import { EventRegistry } from '../../../platform/events/event-registry';
import { ScopedDb } from '../../../platform/scope/scoped-db';
import { registerScopedModel } from '../../../platform/scope/scoped-prisma';
import { PeopleCommands } from './commands/people.commands';
import { PeopleWriter } from './commands/people-writer';
import { PersonCreated, PersonStatusChanged } from './events/people.events';
import { personImportTarget } from './import/person.import-target';
import { PeopleController } from './people.controller';
import { PeopleDataOwnerRole, PeoplePermissions } from './people.permissions';
import { PeopleService } from './service/people.service';
import { orgTeamProvider } from './adapters/org-team.adapter';

/** people core (ADR-008): the person register org refers to. Owns the people_* tables. */
@Module({
  controllers: [PeopleController],
  providers: [PeopleService, PeopleWriter, PeopleCommands, orgTeamProvider],
  exports: [PeopleService],
})
export class PeopleModule implements OnModuleInit {
  constructor(
    private readonly roles: RoleRegistry,
    private readonly events: EventRegistry,
    private readonly imports: ImportService,
    private readonly db: ScopedDb,
    private readonly writer: PeopleWriter,
  ) {}

  onModuleInit(): void {
    registerScopedModel('PeoplePerson', { companyField: 'companyId' });
    registerScopedModel('PeopleEmploymentStatus', { companyField: 'companyId' });
    registerScopedModel('PeopleUserLink', { companyField: 'companyId' });
    this.roles.register(PeopleDataOwnerRole);
    // Product-owner decision (2026-11-25): auditors read people.
    this.roles.extend('auditor', [PeoplePermissions.read]);
    this.events.register(PersonCreated, PersonStatusChanged);
    this.imports.registerTarget(personImportTarget({ db: this.db, writer: this.writer }));
  }
}
