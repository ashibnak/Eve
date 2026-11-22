import { createHash, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { platformV1 } from '@eve/contracts';
import { Clock } from '../context/clock';
import { currentContext } from '../context/request-context';
import { type Tx } from '../context/tx-runner';
import { PrismaService } from '../db/prisma.service';
import { canonicalJson, toCanonicalValue } from './canonical-json';

/** One change to record. Actor, source, correlation and request ids come from the context. */
export interface AuditEntry {
  /** What happened, `<component-or-slug>.<entity>.<verb>`, e.g. `platform.config.set`. */
  action: string;
  entityType: string;
  entityId: string;
  companyId: string | null;
  before: unknown;
  after: unknown;
  /** Why the change was made. Required for every change (CLAUDE.md rule 9). */
  reason: string;
}

export interface RecordedAudit {
  id: string;
  seq: bigint;
  hash: string;
}

export type ChainVerification =
  | { ok: true; rows: number }
  | { ok: false; rows: number; brokenAtSeq: bigint; problem: 'prev_hash' | 'hash' };

export const GENESIS_HASH = '0'.repeat(64);

/** Arbitrary constant key for the transaction-scoped advisory lock serializing chain appends. */
const AUDIT_CHAIN_LOCK_KEY = 7_302_514_001n;

/** The hashed content of a row: everything except `seq`, `prev_hash` and `hash`. */
interface HashedContent {
  id: string;
  recorded_at: string;
  company_id: string | null;
  actor: platformV1.Actor;
  source: platformV1.AuditSource;
  action: string;
  entity_type: string;
  entity_id: string;
  before: unknown;
  after: unknown;
  reason: string;
  correlation_id: string;
  request_id: string | null;
  action_id: string | null;
}

export function chainHash(prevHash: string, content: HashedContent): string {
  return createHash('sha256')
    .update(prevHash)
    .update('\n')
    .update(canonicalJson(content))
    .digest('hex');
}

/**
 * Append-only, hash-chained audit log (CLAUDE.md rule 9). Appends take a transaction-scoped
 * advisory lock so the chain is strictly linear; the database forbids UPDATE/DELETE.
 */
@Injectable()
export class AuditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  /** Records an entry inside the caller's transaction, so it commits with the change itself. */
  async record(tx: Tx, entry: AuditEntry): Promise<RecordedAudit> {
    if (entry.reason.trim() === '') throw new Error('Audit entry requires a reason');
    const ctx = currentContext();

    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK_KEY})`;
    const last = await tx.auditLog.findFirst({ orderBy: { seq: 'desc' }, select: { hash: true } });
    const prevHash = last?.hash ?? GENESIS_HASH;

    const content: HashedContent = {
      id: randomUUID(),
      recorded_at: this.clock.now().toISOString(),
      company_id: entry.companyId,
      actor: ctx.actor,
      source: ctx.source,
      action: entry.action,
      entity_type: entry.entityType,
      entity_id: entry.entityId,
      before: toCanonicalValue(entry.before),
      after: toCanonicalValue(entry.after),
      reason: entry.reason,
      correlation_id: ctx.correlationId,
      request_id: ctx.requestId,
      action_id: ctx.actionId,
    };
    const hash = chainHash(prevHash, content);

    const row = await tx.auditLog.create({
      data: {
        id: content.id,
        recordedAt: new Date(content.recorded_at),
        companyId: content.company_id,
        actor: content.actor,
        source: content.source,
        action: content.action,
        entityType: content.entity_type,
        entityId: content.entity_id,
        before: content.before ?? undefined,
        after: content.after ?? undefined,
        reason: content.reason,
        correlationId: content.correlation_id,
        requestId: content.request_id,
        actionId: content.action_id,
        prevHash,
        hash,
      },
      select: { id: true, seq: true, hash: true },
    });
    return row;
  }

  /** Walks the whole chain in order and reports the first row whose links do not match. */
  async verifyChain(batchSize = 1000): Promise<ChainVerification> {
    let expectedPrev = GENESIS_HASH;
    let afterSeq = 0n;
    let rows = 0;
    for (;;) {
      const batch = await this.prisma.auditLog.findMany({
        where: { seq: { gt: afterSeq } },
        orderBy: { seq: 'asc' },
        take: batchSize,
      });
      if (batch.length === 0) return { ok: true, rows };
      for (const row of batch) {
        rows += 1;
        if (row.prevHash !== expectedPrev) {
          return { ok: false, rows, brokenAtSeq: row.seq, problem: 'prev_hash' };
        }
        const content: HashedContent = {
          id: row.id,
          recorded_at: row.recordedAt.toISOString(),
          company_id: row.companyId,
          actor: row.actor as platformV1.Actor,
          source: row.source as platformV1.AuditSource,
          action: row.action,
          entity_type: row.entityType,
          entity_id: row.entityId,
          before: row.before,
          after: row.after,
          reason: row.reason,
          correlation_id: row.correlationId,
          request_id: row.requestId,
          action_id: row.actionId,
        };
        if (chainHash(row.prevHash, content) !== row.hash) {
          return { ok: false, rows, brokenAtSeq: row.seq, problem: 'hash' };
        }
        expectedPrev = row.hash;
        afterSeq = row.seq;
      }
    }
  }
}
