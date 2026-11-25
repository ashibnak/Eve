import { Injectable } from '@nestjs/common';
import { PrismaService } from '../db/prisma.service';
import { AccessService } from './access.service';
import { type ScopedPrisma, scopedPrisma } from './scoped-prisma';

/**
 * How pack code reads its data (CLAUDE.md rule 11): a read-only client limited to what the caller
 * may see for one permission. Packs never get the raw PrismaService (boundary rule); writes go
 * through a transaction from TxRunner inside a command, after the command checked access.
 */
@Injectable()
export class ScopedDb {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
  ) {}

  /** Everything the caller may see with `permission` (403 when nothing). */
  async for(permission: string): Promise<ScopedPrisma> {
    return scopedPrisma(this.prisma, await this.access.require(permission));
  }

  /** Requires `permission` over one company (403 otherwise), then the caller's scope. */
  async forCompany(permission: string, companyId: string): Promise<ScopedPrisma> {
    return scopedPrisma(this.prisma, await this.access.requireFor(permission, companyId));
  }

  /**
   * A read client without scope filtering, for a module that has itself decided the caller may
   * read exactly the rows it is about to read (relationship-based access: a team lead reading
   * their team, a user reading their own link). Never use it to read more than those rows.
   */
  afterOwnCheck(): ScopedPrisma {
    return scopedPrisma(this.prisma, {
      customerWide: true,
      companyIds: new Set(),
      unitIds: new Set(),
    });
  }
}
