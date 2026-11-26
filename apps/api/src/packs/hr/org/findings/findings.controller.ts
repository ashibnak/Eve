import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { orgV1 } from '@eve/contracts';
import { z } from 'zod';
import { parseInput } from '../../../../platform/http/validation';
import { FindingsCommands } from './findings.commands';
import { FindingsService } from './findings.service';
import { OrgRuleRunner } from './rule-runner';

const ListQuery = z.object({
  companyId: z.uuid(),
  status: orgV1.FindingStatusSchema.optional(),
  severity: orgV1.SeveritySchema.optional(),
  code: z.string().min(1).optional(),
  subjectId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(5000).optional(),
});
const ReasonBody = z.object({ reason: z.string().trim().min(1).max(1000) });

/** The findings inbox and rule runs over HTTP (spec §5, §9). */
@Controller('org')
export class FindingsController {
  constructor(
    private readonly findings: FindingsService,
    private readonly commands: FindingsCommands,
    private readonly runner: OrgRuleRunner,
  ) {}

  @Get('findings')
  list(@Query() query: unknown) {
    return this.findings.list(
      parseInput(orgV1.OrgTools.listFindings.input, parseInput(ListQuery, query)),
    );
  }

  @Get('findings/:id')
  async get(@Param('id', ParseUUIDPipe) id: string) {
    const finding = await this.findings.get(id);
    if (!finding) throw new NotFoundException('Finding not found');
    return finding;
  }

  @Post('findings/:id/accept')
  accept(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.commands.accept(id, parseInput(ReasonBody, body).reason);
  }

  @Post('findings/:id/reopen')
  reopen(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.commands.reopen(id, parseInput(ReasonBody, body).reason);
  }

  @Post('companies/:id/rule-runs')
  run(@Param('id', ParseUUIDPipe) id: string) {
    return this.runner.runNow(id);
  }

  @Get('companies/:id/rule-runs/latest')
  async latest(@Param('id', ParseUUIDPipe) id: string) {
    const run = await this.findings.latestRun(id);
    if (!run) throw new NotFoundException('No rule run yet');
    return run;
  }
}
