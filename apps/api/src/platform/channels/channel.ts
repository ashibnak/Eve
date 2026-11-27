import { Injectable } from '@nestjs/common';

/**
 * A message for a person, by template key and parameters. Channels render it in the
 * recipient's language; `secretParams` names parameters that must never be logged (e.g. a code).
 */
export interface OutboundMessage {
  template: string;
  params: Record<string, string>;
  secretParams?: readonly string[];
}

/** A file for a person, e.g. an issued PDF (S11). */
export interface OutboundDocument {
  content: Buffer;
  fileName: string;
  /** Message key for a short caption, rendered like a message. */
  caption?: Omit<OutboundMessage, 'secretParams'>;
}

/**
 * A way to reach a person (ADR-010): Bale (S12) and web chat are the first real adapters; Slack,
 * Teams or WhatsApp later only add an adapter. Channels that cannot carry files omit
 * `sendDocument`.
 */
export interface Channel {
  readonly kind: string;
  send(address: string, message: OutboundMessage): Promise<void>;
  sendDocument?(address: string, document: OutboundDocument): Promise<void>;
}

/** Keeps the last four characters only, e.g. `…4567`, for logs and UI hints. */
export function maskAddress(address: string): string {
  return address.length <= 4 ? '…' : `…${address.slice(-4)}`;
}

@Injectable()
export class ChannelRegistry {
  private readonly channels = new Map<string, Channel>();

  register(channel: Channel): void {
    if (this.channels.has(channel.kind))
      throw new Error(`Channel ${channel.kind} is already registered`);
    this.channels.set(channel.kind, channel);
  }

  has(kind: string): boolean {
    return this.channels.has(kind);
  }

  get(kind: string): Channel {
    const channel = this.channels.get(kind);
    if (!channel) throw new Error(`Channel ${kind} is not registered`);
    return channel;
  }
}
