import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../db/prisma.service';

/** A database transaction. Audit rows and outbox events are only ever written through one. */
export type Tx = Prisma.TransactionClient;

export interface TxOptions {
  /** How long the transaction may run before it is rolled back. */
  timeoutMs?: number;
}

/** Ordinary commands: a handful of rows. */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Bulk changes that must stay atomic, e.g. committing an import of thousands of rows (each with its
 * audit row and event) or approving a request whose `apply` does that.
 */
export const LONG_TX: TxOptions = { timeoutMs: 15 * 60_000 };

/** Unit of work: the business change, its audit row and its events commit or roll back together. */
@Injectable()
export class TxRunner {
  constructor(private readonly prisma: PrismaService) {}

  run<T>(fn: (tx: Tx) => Promise<T>, options: TxOptions = {}): Promise<T> {
    return this.prisma.$transaction(fn, {
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      // Waiting for a pooled connection is not part of the work itself.
      maxWait: 10_000,
    });
  }
}
