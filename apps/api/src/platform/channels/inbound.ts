/** A message from a linked user, independent of the channel it came through. */
export interface InboundMessage {
  userId: string;
  channel: string;
  address: string;
  text: string;
}

/** What answers linked users. S13's router registers one; until then the default answers. */
export interface InboundHandler {
  handle(message: InboundMessage): Promise<void>;
}

export class InboundHandlers {
  private handler: InboundHandler | null = null;

  use(handler: InboundHandler): void {
    if (this.handler && this.handler !== handler)
      throw new Error('An inbound handler is already registered');
    this.handler = handler;
  }

  get current(): InboundHandler | null {
    return this.handler;
  }
}
