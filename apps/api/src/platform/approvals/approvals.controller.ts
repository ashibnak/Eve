import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { z } from 'zod';
import { parseInput } from '../http/validation';
import { ApprovalService } from './approval.service';

const OptionalNote = z.object({ note: z.string().trim().max(2000).nullable().default(null) });
const RequiredNote = z.object({ note: z.string().trim().min(1).max(2000) });
const ResubmitBody = z.object({ payload: z.unknown(), note: z.string().trim().min(1).max(2000) });

/** Approval inbox and actions. Who may act is decided per request by its chain (in the service). */
@Controller('platform/approvals')
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalService) {}

  /** Requests waiting for a step the caller can approve now. */
  @Get('inbox')
  inbox() {
    return this.approvals.inbox();
  }

  /** Requests the caller submitted. */
  @Get('mine')
  mine() {
    return this.approvals.mine();
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.approvals.get(id);
  }

  @Post(':id/approve')
  approve(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.approvals.approve(id, parseInput(OptionalNote, body ?? {}).note);
  }

  @Post(':id/reject')
  reject(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.approvals.reject(id, parseInput(RequiredNote, body).note);
  }

  @Post(':id/return')
  returnToRequester(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.approvals.returnToRequester(id, parseInput(RequiredNote, body).note);
  }

  @Post(':id/resubmit')
  resubmit(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { payload, note } = parseInput(ResubmitBody, body);
    return this.approvals.resubmit(id, payload, note);
  }

  @Post(':id/cancel')
  cancel(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.approvals.cancel(id, parseInput(RequiredNote, body).note);
  }
}
