import { Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { UserService } from '../auth/user.service';
import { ConfigService } from '../config/config.service';
import { Clock } from '../context/clock';
import { newCorrelationId, runWithContext } from '../context/request-context';
import { type Tx, TxRunner } from '../context/tx-runner';
import { PrismaService } from '../db/prisma.service';
import {
  HomeJurisdictionSetting,
  JurisdictionRegistry,
} from '../jurisdiction/jurisdiction.registry';
import { ChannelIdentities } from './identity';
import { normalizePhone } from './phone';

/** Failed attempts per chat in 24 hours after which the chat gets no more matching. */
export const MAX_FAILED_ATTEMPTS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

export type LinkOutcome = 'linked' | 'already' | 'not_own' | 'not_found' | 'too_many';

/**
 * Self-service linking of a chat to an employee (S12, product-owner decisions 2026-11-27):
 * the channel must vouch that the shared number is the sender's own, and the number must belong to
 * people employed today. Then the chat becomes the user's address on that channel: messages and
 * one-time login codes go there. Domain-free: people are found and linked through the registered
 * identity directory. Every refusal looks the same from outside except "send your own number".
 */
@Injectable()
export class ChannelLinking {
  private readonly logger = new Logger(ChannelLinking.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly txRunner: TxRunner,
    private readonly audit: AuditService,
    private readonly users: UserService,
    private readonly config: ConfigService,
    private readonly jurisdictions: JurisdictionRegistry,
    private readonly identities: ChannelIdentities,
    private readonly clock: Clock,
  ) {}

  /** The user a chat is linked to, if any. */
  async userOf(channel: string, address: string): Promise<string | null> {
    const link = await this.prisma.channelsLink.findFirst({
      where: { channel, address, endedAt: null },
      select: { userId: true },
    });
    return link?.userId ?? null;
  }

  /**
   * Handles a shared contact. `inTx` runs inside the transaction that records the outcome (the
   * poller marks the update processed there, so a redelivered update has no second effect).
   */
  async link(
    request: { channel: string; address: string; phone: string; own: boolean },
    inTx: (tx: Tx) => Promise<void> = async () => {},
  ): Promise<LinkOutcome> {
    const context = {
      actor: { kind: 'system' as const, id: `channels.${request.channel}` },
      source: 'workflow' as const,
      correlationId: newCorrelationId(),
      causationId: null,
      requestId: null,
      actionId: null,
    };
    return runWithContext(context, () => this.decideAndLink(request, inTx));
  }

  private async decideAndLink(
    request: { channel: string; address: string; phone: string; own: boolean },
    inTx: (tx: Tx) => Promise<void>,
  ): Promise<LinkOutcome> {
    const { channel, address } = request;
    const failures = await this.prisma.channelsLinkAttempt.count({
      where: {
        channel,
        address,
        outcome: { in: ['not_found', 'not_own'] },
        at: { gt: new Date(this.clock.now().getTime() - DAY_MS) },
      },
    });
    if (failures >= MAX_FAILED_ATTEMPTS) {
      await this.txRunner.run(inTx);
      return 'too_many';
    }
    if ((await this.userOf(channel, address)) !== null)
      return this.record(request, 'already', inTx);
    if (!request.own) return this.record(request, 'not_own', inTx);

    const home = this.jurisdictions.get(await this.config.get(HomeJurisdictionSetting));
    const phone = normalizePhone(request.phone, home.phoneCountryCode ?? '');
    const matches = phone ? await this.identities.findEmployedByPhone(phone) : [];
    if (matches.length === 0) return this.record(request, 'not_found', inTx);
    const existing = await this.identities.linkedUserOf(matches);
    const reason = `${channel} account linked by the employee (shared own number)`;

    return this.txRunner.run(async (tx) => {
      const userId =
        existing ??
        (
          await this.users.createChannelUser(tx, {
            username: `${channel}-${address}`.toLowerCase().replace(/[^a-z0-9._-]/g, '_'),
            contactChannel: channel,
            contactAddress: address,
            reason,
          })
        ).id;
      if (existing) await this.users.setContact(tx, userId, { channel, address }, reason);
      // A user who changed accounts on the channel: the old chat stops receiving.
      const now = this.clock.now();
      const previous = await tx.channelsLink.findMany({
        where: { userId, channel, endedAt: null },
        select: { id: true },
      });
      for (const old of previous)
        await tx.channelsLink.update({ where: { id: old.id }, data: { endedAt: now } });
      const created = await tx.channelsLink.create({
        data: { userId, channel, address, linkedAt: now },
      });
      await this.audit.record(tx, {
        action: 'platform.channels.link',
        entityType: 'channels_link',
        entityId: created.id,
        companyId: null,
        before: previous.length > 0 ? { endedLinks: previous.map((p) => p.id) } : null,
        after: { userId, channel, companies: matches.map((m) => m.companyId) },
        reason,
      });
      for (const match of matches) await this.identities.linkUser(tx, { ...match, userId, reason });
      await tx.channelsLinkAttempt.create({
        data: { channel, address, at: now, outcome: 'linked' },
      });
      await inTx(tx);
      this.logger.log(`Linked a ${channel} chat to user ${userId} (${matches.length} company/ies)`);
      return 'linked' as const;
    });
  }

  private async record(
    request: { channel: string; address: string },
    outcome: 'already' | 'not_own' | 'not_found',
    inTx: (tx: Tx) => Promise<void>,
  ): Promise<LinkOutcome> {
    await this.txRunner.run(async (tx) => {
      await tx.channelsLinkAttempt.create({
        data: { channel: request.channel, address: request.address, at: this.clock.now(), outcome },
      });
      await inTx(tx);
    });
    return outcome;
  }
}
