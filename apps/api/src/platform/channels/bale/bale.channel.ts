import { isMessageKey, renderMessage } from '../../i18n/messages';
import type { Channel, OutboundDocument, OutboundMessage } from '../channel';
import type { BaleClient } from './bale.client';

/** Renders a message key in the recipient's language (Persian until users carry a locale). */
export function messageText(message: Omit<OutboundMessage, 'secretParams'>): string {
  if (!isMessageKey(message.template)) throw new Error(`Unknown message ${message.template}`);
  return renderMessage(message.template, message.params, 'fa');
}

/** Bale (S12): the address is the user's private chat id with the bot. */
export class BaleChannel implements Channel {
  readonly kind = 'bale';

  constructor(private readonly client: BaleClient) {}

  async send(address: string, message: OutboundMessage): Promise<void> {
    await this.client.sendMessage(address, messageText(message));
  }

  async sendDocument(address: string, document: OutboundDocument): Promise<void> {
    await this.client.sendDocument(
      address,
      document.content,
      document.fileName,
      document.caption ? messageText(document.caption) : undefined,
    );
  }
}
