import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../db/prisma.service';

/** A database transaction. Audit rows and outbox events are only ever written through one. */
export type Tx = Prisma.TransactionClient;

/** Unit of work: the business change, its audit row and its events commit or roll back together. */
@Injectable()
export class TxRunner {
  constructor(private readonly prisma: PrismaService) {}

  run<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(fn);
  }
}
