import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { z } from 'zod';
import { parseInput } from '../http/validation';
import { AccessService } from '../scope/access.service';
import { Permissions } from './roles';
import { UserService } from './user.service';

const Reason = z.string().trim().min(1).max(1000);

const CreateUserBody = z.object({
  username: z.string(),
  password: z.string().max(256),
  contactChannel: z.string(),
  contactAddress: z.string().max(200),
  reason: Reason,
});

const GrantBody = z.object({
  role: z.string(),
  scopeKind: z.enum(['customer', 'company', 'unit']),
  companyId: z.uuid().nullable().default(null),
  unitId: z.uuid().nullable().default(null),
  reason: Reason,
});

const RevokeBody = z.object({ reason: Reason });

/** User accounts and role grants; customer-wide system administrators only. */
@Controller('platform/users')
export class UsersController {
  constructor(
    private readonly users: UserService,
    private readonly access: AccessService,
  ) {}

  @Get()
  async list() {
    await this.access.requireFor(Permissions.usersManage, null);
    return this.users.list();
  }

  @Post()
  async create(@Body() body: unknown) {
    await this.access.requireFor(Permissions.usersManage, null);
    return this.users.create(parseInput(CreateUserBody, body));
  }

  @Post(':userId/roles')
  async grant(@Param('userId', ParseUUIDPipe) userId: string, @Body() body: unknown) {
    await this.access.requireFor(Permissions.usersManage, null);
    return this.users.grantRole({ userId, ...parseInput(GrantBody, body) });
  }

  @Post('roles/:assignmentId/revoke')
  @HttpCode(204)
  async revoke(@Param('assignmentId', ParseUUIDPipe) assignmentId: string, @Body() body: unknown) {
    await this.access.requireFor(Permissions.usersManage, null);
    await this.users.revokeRole(assignmentId, parseInput(RevokeBody, body).reason);
  }
}
