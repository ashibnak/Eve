import { Logger } from '@nestjs/common';
import { type Channel, maskAddress, type OutboundDocument, type OutboundMessage } from './channel';

export interface StubDelivery {
  address: string;
  message: OutboundMessage;
}

/**
 * Stand-in channel until Bale (R2): keeps messages in memory for tests and logs only that a
 * message was sent. Secret parameters (one-time codes) are logged only when
 * EVE_STUB_CHANNEL_REVEAL_SECRETS=true, which is for local development, never production.
 */
export class StubChannel implements Channel {
  readonly kind = 'stub';
  private readonly logger = new Logger(StubChannel.name);
  private readonly deliveries: StubDelivery[] = [];

  constructor(
    private readonly revealSecrets = process.env.EVE_STUB_CHANNEL_REVEAL_SECRETS === 'true',
  ) {}

  send(address: string, message: OutboundMessage): Promise<void> {
    this.deliveries.push({ address, message });
    if (this.deliveries.length > 100) this.deliveries.shift();
    const secrets = new Set(message.secretParams ?? []);
    const shown = Object.fromEntries(
      Object.entries(message.params).map(([k, v]) => [
        k,
        secrets.has(k) && !this.revealSecrets ? '[secret]' : v,
      ]),
    );
    this.logger.log(
      `Stub message "${message.template}" to ${maskAddress(address)} ${JSON.stringify(shown)}`,
    );
    return Promise.resolve();
  }

  private readonly documents: { address: string; document: OutboundDocument }[] = [];

  sendDocument(address: string, document: OutboundDocument): Promise<void> {
    this.documents.push({ address, document });
    if (this.documents.length > 20) this.documents.shift();
    this.logger.log(`Stub document "${document.fileName}" to ${maskAddress(address)}`);
    return Promise.resolve();
  }

  /** The most recent document sent to an address (tests). */
  lastDocumentTo(address: string): OutboundDocument | undefined {
    return this.documents.findLast((d) => d.address === address)?.document;
  }

  /** The most recent message sent to an address (tests and local development). */
  lastTo(address: string): OutboundMessage | undefined {
    return this.deliveries.findLast((d) => d.address === address)?.message;
  }
}
