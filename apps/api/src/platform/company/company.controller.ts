import { Body, Controller, Get, Post } from '@nestjs/common';
import { z } from 'zod';
import { Permissions } from '../auth/roles';
import { PrismaService } from '../db/prisma.service';
import { parseInput } from '../http/validation';
import { AccessService } from '../scope/access.service';
import { scopedPrisma } from '../scope/scoped-prisma';
import { CompanyService } from './company.service';

const RegisterBody = z.object({
  code: z.string().trim().min(1).max(32),
  jurisdictionCode: z.string().regex(/^[a-z]{2}$/),
  reason: z.string().trim().min(1).max(1000),
});

@Controller('platform/companies')
export class CompanyController {
  constructor(
    private readonly companies: CompanyService,
    private readonly access: AccessService,
    private readonly prisma: PrismaService,
  ) {}

  /** Companies the caller may see. */
  @Get()
  async list() {
    const scope = await this.access.require(Permissions.companyRead);
    return scopedPrisma(this.prisma, scope).coreCompany.findMany({
      orderBy: { code: 'asc' },
      select: { id: true, code: true, jurisdictionCode: true },
    });
  }

  @Post()
  async register(@Body() body: unknown) {
    await this.access.requireFor(Permissions.companyManage, null);
    return this.companies.register(parseInput(RegisterBody, body));
  }
}
