import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { Permissions } from '../auth/roles';
import { PrismaService } from '../db/prisma.service';
import { parseInput } from '../http/validation';
import { AccessService } from '../scope/access.service';
import { scopedPrisma } from '../scope/scoped-prisma';

const AuditQuery = z.object({
  companyId: z.uuid().optional(),
  beforeSeq: z.coerce.bigint().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** Read-only audit log for auditors, newest first, limited to the caller's scope. */
@Controller('platform/audit')
export class AuditController {
  constructor(
    private readonly access: AccessService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  async list(@Query() query: unknown) {
    const { companyId, beforeSeq, limit } = parseInput(AuditQuery, query);
    const scope = companyId
      ? await this.access.requireFor(Permissions.auditRead, companyId)
      : await this.access.require(Permissions.auditRead);
    const rows = await scopedPrisma(this.prisma, scope).auditLog.findMany({
      where: {
        ...(companyId ? { companyId } : {}),
        ...(beforeSeq !== undefined ? { seq: { lt: beforeSeq } } : {}),
      },
      orderBy: { seq: 'desc' },
      take: limit,
    });
    return rows.map((row) => ({ ...row, seq: row.seq.toString() }));
  }
}
