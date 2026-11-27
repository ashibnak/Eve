import { Logger } from '@nestjs/common';
import { Client } from 'pg';
import type { Clock } from '../../context/clock';
import type { Tx, TxRunner } from '../../context/tx-runner';
import type { PrismaService } from '../../db/prisma.service';
import { renderMessage } from '../../i18n/messages';
import type { InboundHandlers } from '../inbound';
import type { ChannelLinking, LinkOutcome } from '../linking';
import type { BaleClient, ReplyMarkup } from './bale.client';
import { messageText } from './bale.channel';
import { type BaleUpdate, toInbound } from './updates';

const CHANNEL = 'bale';
/** Arbitrary constant key of the session advisory lock that makes one poller per deployment. */
const POLLER_LOCK_KEY = 7_302_514_012n;
const LONG_POLL_SECONDS = 25;

const OUTCOME_MESSAGES: Record<LinkOutcome, Parameters<typeof renderMessage>[0]> = {
  linked: 'channels.link.linked',
  already: 'channels.link.already',
  not_own: 'channels.link.own_only',
  not_found: 'channels.link.not_found',
  too_many: 'channels.link.too_many',
};

export interface BalePollerDeps {
  client: BaleClient;
  prisma: PrismaService;
  txRunner: TxRunner;
  linking: ChannelLinking;
  handlers: InboundHandlers;
  clock: Clock;
  /** Connection string for the dedicated session that holds the poller lock. */
  databaseUrl: string;
}

/**
 * Reads Bale updates by long polling (outbound HTTPS only). One poller per deployment: it holds a
 * PostgreSQL session advisory lock; another instance waits and takes over if this one stops.
 * Each update is recorded as processed in the same transaction as its effect, and the offset is
 * kept in the database, so a restart neither loses nor repeats work. Replies are sent after the
 * commit; a crash in between can lose a reply, never duplicate an effect.
 */
export class BalePoller {
  private readonly logger = new Logger(BalePoller.name);
  private lockClient: Client | null = null;
  private abort: AbortController | null = null;
  private running: Promise<void> | null = null;

  constructor(private readonly deps: BalePollerDeps) {}

  /** Tries to become the poller; false when another instance holds the lock. */
  async acquire(): Promise<boolean> {
    if (this.lockClient) return true;
    const client = new Client({ connectionString: this.deps.databaseUrl });
    await client.connect();
    const { rows } = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [POLLER_LOCK_KEY.toString()],
    );
    if (!rows[0]?.locked) {
      await client.end();
      return false;
    }
    this.lockClient = client;
    return true;
  }

  /** Starts the background loop (application start-up). */
  start(): void {
    if (this.running) return;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.running = (async () => {
      while (!signal.aborted) {
        try {
          if (!(await this.acquire())) {
            await this.pause(30_000, signal);
            continue;
          }
          await this.pollOnce(LONG_POLL_SECONDS, signal);
        } catch (error) {
          if (signal.aborted) break;
          this.logger.error(
            `Bale polling failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          await this.pause(5_000, signal);
        }
      }
    })();
  }

  /** One long poll and the processing of what it returned. Returns how many updates were read. */
  async pollOnce(timeoutSeconds = 0, signal?: AbortSignal): Promise<number> {
    const state = await this.deps.prisma.channelsPollState.findUnique({
      where: { channel: CHANNEL },
    });
    const offset = Number(state?.nextOffset ?? 0n);
    const updates = await this.deps.client.getUpdates(offset, timeoutSeconds, signal);
    for (const { updateId, update } of updates) {
      await this.process(updateId, update);
      await this.deps.prisma.channelsPollState.upsert({
        where: { channel: CHANNEL },
        create: { channel: CHANNEL, nextOffset: BigInt(updateId + 1) },
        update: { nextOffset: BigInt(updateId + 1) },
      });
    }
    return updates.length;
  }

  private async process(updateId: number, update: BaleUpdate | null): Promise<void> {
    const seen = await this.deps.prisma.channelsUpdate.findUnique({
      where: { channel_updateId: { channel: CHANNEL, updateId: BigInt(updateId) } },
    });
    if (seen) return;
    const mark = async (tx: Tx) => {
      await tx.channelsUpdate.create({
        data: { channel: CHANNEL, updateId: BigInt(updateId), receivedAt: this.deps.clock.now() },
      });
    };
    const inbound = update ? toInbound(update) : ({ kind: 'ignored' } as const);
    if (inbound.kind === 'ignored') {
      await this.deps.txRunner.run(mark);
      return;
    }
    if (inbound.kind === 'contact') {
      const outcome = await this.deps.linking.link(
        { channel: CHANNEL, address: inbound.chatId, phone: inbound.phone, own: inbound.own },
        mark,
      );
      await this.reply(
        inbound.chatId,
        OUTCOME_MESSAGES[outcome],
        outcome === 'linked' || outcome === 'already',
      );
      return;
    }
    await this.deps.txRunner.run(mark);
    const userId = await this.deps.linking.userOf(CHANNEL, inbound.chatId);
    if (!userId) {
      await this.reply(inbound.chatId, 'channels.link.welcome', false, {
        keyboard: [
          [
            {
              text: messageText({ template: 'channels.link.share_button', params: {} }),
              request_contact: true,
            },
          ],
        ],
        one_time_keyboard: true,
        resize_keyboard: true,
      });
      return;
    }
    const handler = this.deps.handlers.current;
    if (handler && inbound.kind === 'text') {
      await handler.handle({
        userId,
        channel: CHANNEL,
        address: inbound.chatId,
        text: inbound.text,
      });
      return;
    }
    await this.reply(inbound.chatId, 'channels.services_coming', false);
  }

  private async reply(
    chatId: string,
    key: Parameters<typeof renderMessage>[0],
    removeKeyboard: boolean,
    markup?: ReplyMarkup,
  ): Promise<void> {
    try {
      await this.deps.client.sendMessage(
        chatId,
        messageText({ template: key, params: {} }),
        markup ?? (removeKeyboard ? { remove_keyboard: true } : undefined),
      );
    } catch (error) {
      this.logger.warn(
        `Could not reply on Bale: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private pause(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    this.abort?.abort();
    await this.running?.catch(() => undefined);
    this.running = null;
    if (this.lockClient) {
      await this.lockClient.end().catch(() => undefined);
      this.lockClient = null;
    }
  }
}
