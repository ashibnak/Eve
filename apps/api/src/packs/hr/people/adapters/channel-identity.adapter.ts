import { Injectable, Logger } from '@nestjs/common';
import type { ChannelIdentityDirectory, PersonMatch } from '../../../../platform/channels/identity';
import { normalizePhone } from '../../../../platform/channels/phone';
import { ConfigService } from '../../../../platform/config/config.service';
import { TimeZoneSetting } from '../../../../platform/config/settings';
import { Clock } from '../../../../platform/context/clock';
import type { Tx } from '../../../../platform/context/tx-runner';
import { businessDateIn } from '../../../../platform/dates/dates';
import { JurisdictionRegistry } from '../../../../platform/jurisdiction/jurisdiction.registry';
import { ScopedDb } from '../../../../platform/scope/scoped-db';
import { PeopleWriter } from '../commands/people-writer';
import { PeopleService } from '../service/people.service';

/**
 * people as the platform's channel identity directory (S12): finds who a shared phone number
 * belongs to and links the login, as the single writer of `people_user_link`. Product-owner
 * decision (2026-11-27): only people employed today. A number shared by two employed people of
 * one company is ambiguous, so that company is left out rather than guessed.
 */
@Injectable()
export class PeopleChannelIdentity implements ChannelIdentityDirectory {
  private readonly logger = new Logger(PeopleChannelIdentity.name);

  constructor(
    private readonly db: ScopedDb,
    private readonly people: PeopleService,
    private readonly writer: PeopleWriter,
    private readonly jurisdictions: JurisdictionRegistry,
    private readonly config: ConfigService,
    private readonly clock: Clock,
  ) {}

  async findEmployedByPhone(phone: string): Promise<PersonMatch[]> {
    const rows = await this.db.afterOwnCheck().peoplePerson.findMany({
      where: { contactAddress: { not: null } },
      select: { id: true, companyId: true, contactAddress: true },
    });
    const companies = await this.db.afterOwnCheck().coreCompany.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.companyId))] } },
      select: { id: true, jurisdictionCode: true },
    });
    const countryCode = new Map(
      companies.map((c) => [
        c.id,
        this.jurisdictions.get(c.jurisdictionCode).phoneCountryCode ?? '',
      ]),
    );
    const byCompany = new Map<string, string[]>();
    for (const row of rows) {
      if (normalizePhone(row.contactAddress!, countryCode.get(row.companyId) ?? '') !== phone)
        continue;
      byCompany.set(row.companyId, [...(byCompany.get(row.companyId) ?? []), row.id]);
    }
    const today = businessDateIn(this.clock.now(), await this.config.get(TimeZoneSetting));
    const matches: PersonMatch[] = [];
    for (const [companyId, personIds] of byCompany) {
      const employed = [...(await this.people.employedAmong(companyId, personIds, today))];
      if (employed.length === 1) matches.push({ companyId, personId: employed[0]! });
      else if (employed.length > 1)
        this.logger.warn(
          `A phone number matches ${employed.length} employed people in company ${companyId}; not linked`,
        );
    }
    return matches;
  }

  async linkedUserOf(matches: readonly PersonMatch[]): Promise<string | null> {
    if (matches.length === 0) return null;
    const link = await this.db.afterOwnCheck().peopleUserLink.findFirst({
      where: { endedAt: null, personId: { in: matches.map((m) => m.personId) } },
      orderBy: { linkedAt: 'asc' },
      select: { userId: true },
    });
    return link?.userId ?? null;
  }

  async linkUser(tx: Tx, link: PersonMatch & { userId: string; reason: string }): Promise<void> {
    const person = await tx.peoplePerson.findUniqueOrThrow({
      where: { id: link.personId },
      select: { id: true, companyId: true, personnelCode: true },
    });
    if (person.companyId !== link.companyId) throw new Error('Person is not in that company');
    await this.writer.linkUser(tx, person, link.userId, link.reason);
  }
}
