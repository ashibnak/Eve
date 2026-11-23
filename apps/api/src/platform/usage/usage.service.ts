import { Injectable } from '@nestjs/common';
import type { platformV1 } from '@eve/contracts';
import { ConfigService } from '../config/config.service';
import { TimeZoneSetting } from '../config/settings';
import { Clock } from '../context/clock';
import { businessDateIn } from '../dates/dates';
import { PrismaService } from '../db/prisma.service';
import {
  HomeJurisdictionSetting,
  JurisdictionRegistry,
} from '../jurisdiction/jurisdiction.registry';

export interface MonthlyUsage {
  jurisdiction: string;
  calendar: string;
  year: number;
  month: number;
  /** Gregorian dates covered: `from` inclusive, `to` exclusive. */
  from: platformV1.BusinessDate;
  to: platformV1.BusinessDate;
  activeUsers: number;
  /** Authenticated API requests per module. */
  requests: Record<string, number>;
  /** Model tokens per module (none in R1). */
  tokens: Record<string, { in: number; out: number }>;
}

const asDate = (day: platformV1.BusinessDate) => new Date(`${day}T00:00:00.000Z`);

/**
 * Usage counters and the monthly aggregate (ADR-014). Counters are telemetry, not business data:
 * they are not audited, and they hold no names, only user ids for the active-user count.
 */
@Injectable()
export class UsageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly jurisdictions: JurisdictionRegistry,
    private readonly clock: Clock,
  ) {}

  /** Counts one authenticated request to a module and marks the user active today. */
  async recordRequest(userId: string, module: string): Promise<void> {
    const day = asDate(businessDateIn(this.clock.now(), await this.config.get(TimeZoneSetting)));
    await this.prisma.$executeRaw`
      INSERT INTO usage_daily (day, module, metric, count) VALUES (${day}::date, ${module}, 'requests', 1)
      ON CONFLICT (day, module, metric) DO UPDATE SET count = usage_daily.count + 1`;
    await this.prisma.$executeRaw`
      INSERT INTO usage_active_user (day, user_id) VALUES (${day}::date, ${userId}::uuid)
      ON CONFLICT DO NOTHING`;
  }

  /** Usage for one month of the customer's home-jurisdiction calendar (e.g. Azar 1405). */
  async monthly(year: number, month: number): Promise<MonthlyUsage> {
    const pack = this.jurisdictions.get(await this.config.get(HomeJurisdictionSetting));
    const { from, to } = pack.calendar.monthRange(year, month);
    const days = { gte: asDate(from), lt: asDate(to) };

    const [active, requests, tokens] = await Promise.all([
      this.prisma.usageActiveUser.findMany({
        where: { day: days },
        distinct: ['userId'],
        select: { userId: true },
      }),
      this.prisma.usageDaily.groupBy({
        by: ['module'],
        where: { day: days, metric: 'requests' },
        _sum: { count: true },
      }),
      this.prisma.usageLedger.groupBy({
        by: ['module'],
        where: { day: days },
        _sum: { tokensIn: true, tokensOut: true },
      }),
    ]);

    return {
      jurisdiction: pack.code,
      calendar: pack.calendar.id,
      year,
      month,
      from,
      to,
      activeUsers: active.length,
      requests: Object.fromEntries(requests.map((r) => [r.module, Number(r._sum.count ?? 0n)])),
      tokens: Object.fromEntries(
        tokens.map((t) => [t.module, { in: t._sum.tokensIn ?? 0, out: t._sum.tokensOut ?? 0 }]),
      ),
    };
  }
}
