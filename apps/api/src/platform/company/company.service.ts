import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { Clock } from '../context/clock';
import { TxRunner } from '../context/tx-runner';
import { ConfigService } from '../config/config.service';
import { TimeZoneSetting } from '../config/settings';
import { businessDateIn } from '../dates/dates';
import { PrismaService } from '../db/prisma.service';
import { defineEvent, EventRegistry } from '../events/event-registry';
import { EventPublisher } from '../events/event-publisher';

export const CompanyRegistered = defineEvent({
  type: 'platform.company.registered',
  schemaVersion: 1,
  payload: z.object({ code: z.string(), jurisdiction_code: z.string() }),
});

export interface Company {
  id: string;
  code: string;
  jurisdictionCode: string;
}

export interface RegisterCompanyRequest {
  code: string;
  /** ISO 3166-1 alpha-2, lower case; selects the jurisdiction pack (ADR-010). */
  jurisdictionCode: string;
  reason: string;
}

/**
 * Minimal platform company registry: the unit of access scope and jurisdiction.
 * Names, unit levels and legal fields belong to org (S5), keyed by the same id.
 */
@Injectable()
export class CompanyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly txRunner: TxRunner,
    private readonly audit: AuditService,
    private readonly events: EventPublisher,
    private readonly config: ConfigService,
    private readonly clock: Clock,
    eventRegistry: EventRegistry,
  ) {
    eventRegistry.register(CompanyRegistered);
  }

  async register(request: RegisterCompanyRequest): Promise<Company> {
    const timeZone = await this.config.get(TimeZoneSetting);
    return this.txRunner.run(async (tx) => {
      const company = await tx.coreCompany.create({
        data: { code: request.code, jurisdictionCode: request.jurisdictionCode },
        select: { id: true, code: true, jurisdictionCode: true },
      });
      await this.audit.record(tx, {
        action: 'platform.company.register',
        entityType: 'core_company',
        entityId: company.id,
        companyId: company.id,
        before: null,
        after: company,
        reason: request.reason,
      });
      await this.events.publish(tx, {
        event: CompanyRegistered,
        payload: { code: company.code, jurisdiction_code: company.jurisdictionCode },
        effectiveAt: businessDateIn(this.clock.now(), timeZone),
        companyId: company.id,
      });
      return company;
    });
  }

  findById(id: string): Promise<Company | null> {
    return this.prisma.coreCompany.findUnique({
      where: { id },
      select: { id: true, code: true, jurisdictionCode: true },
    });
  }
}
