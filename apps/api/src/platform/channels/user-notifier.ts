import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../db/prisma.service';
import { ChannelRegistry } from './channel';

/**
 * Sends a message to platform users through the channel on their account (the stub in R1, Bale in
 * R2). Best effort: a failed delivery is logged, never rolled back into the business change.
 */
@Injectable()
export class UserNotifier {
  private readonly logger = new Logger(UserNotifier.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly channels: ChannelRegistry,
  ) {}

  async notify(
    userIds: readonly string[],
    template: string,
    params: Record<string, string>,
  ): Promise<number> {
    const users = await this.prisma.authUser.findMany({
      where: { id: { in: [...new Set(userIds)] }, status: 'active' },
      select: { id: true, contactChannel: true, contactAddress: true },
    });
    let sent = 0;
    for (const user of users) {
      try {
        await this.channels
          .get(user.contactChannel)
          .send(user.contactAddress, { template, params });
        sent += 1;
      } catch (error) {
        this.logger.error(`Could not notify user ${user.id}: ${String(error)}`);
      }
    }
    return sent;
  }
}
