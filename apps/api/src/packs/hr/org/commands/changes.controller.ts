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
import { ChangeRequests } from './change-requests';
import { OrgCorrections } from './corrections';

const ListQuery = z.object({ companyId: z.uuid() });
const ResubmitBody = orgV1.ChangeRequestInputSchema.omit({ companyId: true }).extend({
  note: z.string().trim().min(1).max(1000),
});

/**
 * Structure change requests and data corrections over HTTP (spec §8). Approving, rejecting and
 * returning a request go through `/platform/approvals` like every other approval.
 */
@Controller('org')
export class ChangesController {
  constructor(
    private readonly requests: ChangeRequests,
    private readonly corrections: OrgCorrections,
  ) {}

  @Post('change-requests')
  submit(@Body() body: unknown) {
    return this.requests.submit(parseInput(orgV1.ChangeRequestInputSchema, body));
  }

  @Get('change-requests')
  list(@Query() query: unknown) {
    return this.requests.list(parseInput(ListQuery, query).companyId);
  }

  @Get('change-requests/:id')
  async get(@Param('id', ParseUUIDPipe) id: string) {
    const request = await this.requests.get(id);
    if (!request) throw new NotFoundException('Change request not found');
    return request;
  }

  @Post('change-requests/:id/resubmit')
  resubmit(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { note, ...input } = parseInput(ResubmitBody, body);
    return this.requests.resubmit(id, input, note);
  }

  @Post('units/:id/corrections')
  correctUnit(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.corrections.correctUnit(id, parseInput(orgV1.UnitCorrectionSchema, body));
  }

  @Post('positions/:id/corrections')
  correctPosition(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.corrections.correctPosition(id, parseInput(orgV1.PositionCorrectionSchema, body));
  }
}
