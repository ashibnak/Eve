import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { peopleV1, platformV1 } from '@eve/contracts';
import { z } from 'zod';
import { parseInput } from '../../../platform/http/validation';
import { PeopleCommands } from './commands/people.commands';
import { PeopleService } from './service/people.service';

const ListQuery = z.object({
  companyId: z.uuid(),
  asOf: platformV1.BusinessDateSchema.optional(),
  active: z.enum(['true', 'false']).optional(),
  personnelCode: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(5000).optional(),
});
const AsOfQuery = z.object({ asOf: platformV1.BusinessDateSchema.optional() });
const StatusBody = z.object({
  status: peopleV1.EmploymentStatusSchema,
  validFrom: platformV1.BusinessDateSchema,
  reason: z.string().trim().min(1).max(1000),
});
const Name = z.string().trim().min(1).max(100);
const CorrectBody = z.object({
  changes: z
    .object({
      firstNameFa: Name,
      lastNameFa: Name,
      firstNameEn: Name.nullable(),
      lastNameEn: Name.nullable(),
      hireDate: platformV1.BusinessDateSchema,
      contact: z
        .object({ channel: peopleV1.ContactChannelSchema, address: z.string().trim().min(1) })
        .nullable(),
    })
    .partial()
    .strict(),
  reason: z.string().trim().min(1).max(1000),
});

/** The person register over HTTP; every call is limited to the caller's scope. */
@Controller('people/persons')
export class PeopleController {
  constructor(
    private readonly people: PeopleService,
    private readonly commands: PeopleCommands,
  ) {}

  @Get()
  list(@Query() query: unknown) {
    const q = parseInput(ListQuery, query);
    return this.people.list(q.companyId, {
      ...(q.asOf ? { asOf: q.asOf } : {}),
      ...(q.active ? { activeOnly: q.active === 'true' } : {}),
      ...(q.personnelCode ? { personnelCode: q.personnelCode } : {}),
      ...(q.limit ? { limit: q.limit } : {}),
    });
  }

  @Get(':id')
  async get(@Param('id', ParseUUIDPipe) id: string, @Query() query: unknown) {
    const { asOf } = parseInput(AsOfQuery, query);
    const person = await this.people.getPerson(id, asOf ? { asOf } : {});
    if (!person) throw new NotFoundException('Person not found');
    return person;
  }

  @Post(':id/status')
  async changeStatus(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { status, validFrom, reason } = parseInput(StatusBody, body);
    return { changed: await this.commands.changeStatus(id, status, validFrom, reason) };
  }

  @Patch(':id')
  async correct(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { changes, reason } = parseInput(CorrectBody, body);
    return { changed: await this.commands.correct(id, changes, reason) };
  }
}
