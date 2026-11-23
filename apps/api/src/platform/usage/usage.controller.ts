import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { Permissions } from '../auth/roles';
import { parseInput } from '../http/validation';
import { AccessService } from '../scope/access.service';
import { UsageService } from './usage.service';

const MonthQuery = z.object({
  year: z.coerce.number().int().min(1).max(9999),
  month: z.coerce.number().int().min(1).max(12),
});

/** Aggregate usage per month of the customer's calendar; no names, only counts (ADR-014). */
@Controller('platform/usage')
export class UsageController {
  constructor(
    private readonly usage: UsageService,
    private readonly access: AccessService,
  ) {}

  @Get('monthly')
  async monthly(@Query() query: unknown) {
    const { year, month } = parseInput(MonthQuery, query);
    await this.access.requireFor(Permissions.usageRead, null);
    return this.usage.monthly(year, month);
  }
}
