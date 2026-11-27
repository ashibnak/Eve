/**
 * A stand-in for the Bale Bot API on localhost (S12 tests): queued updates for getUpdates, a record
 * of what the bot sent, and programmable failures. Speaks the Telegram-compatible wire format.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface SentMessage {
  chatId: string;
  text: string;
  replyMarkup?: {
    keyboard?: { text: string; request_contact?: boolean }[][];
    remove_keyboard?: boolean;
  };
}
export interface SentDocument {
  chatId: string;
  fileName: string;
  caption: string | null;
  content: Buffer;
}

export class FakeBale {
  readonly token = 'test-token-123:secret';
  private server: Server | null = null;
  private updates: { update_id: number; [key: string]: unknown }[] = [];
  private nextUpdateId = 1;
  readonly sent: SentMessage[] = [];
  readonly documents: SentDocument[] = [];
  /** Requests per method, counted even when answered with an error. */
  readonly calls = new Map<string, number>();
  private failures: { method: string; status: number; retryAfter?: number }[] = [];
  url = '';

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      void this.handle(req).then(({ status, body }) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise((resolve) => this.server?.close(resolve));
  }

  /** The next `method` call answers with this status (and `retry_after` for 429). */
  failNext(method: string, status: number, retryAfter?: number): void {
    this.failures.push({ method, status, retryAfter });
  }

  /** Queues an update; returns its id. */
  push(update: Record<string, unknown>): number {
    const update_id = this.nextUpdateId++;
    this.updates.push({ update_id, ...update });
    return update_id;
  }

  /** Queues the same update again (Bale redelivering after a lost confirmation). */
  redeliver(updateId: number): void {
    const update =
      this.updates.find((u) => u.update_id === updateId) ?? this.delivered.get(updateId);
    if (update) this.updates.push(update);
  }

  private readonly delivered = new Map<number, { update_id: number }>();

  text(chatId: number, text: string, fromId = chatId): number {
    return this.push({
      message: {
        message_id: this.nextUpdateId,
        from: { id: fromId },
        chat: { id: chatId, type: 'private' },
        text,
      },
    });
  }

  contact(
    chatId: number,
    phone: string,
    contactUserId: number | undefined,
    fromId = chatId,
  ): number {
    return this.push({
      message: {
        message_id: this.nextUpdateId,
        from: { id: fromId },
        chat: { id: chatId, type: 'private' },
        contact: {
          phone_number: phone,
          ...(contactUserId === undefined ? {} : { user_id: contactUserId }),
        },
      },
    });
  }

  lastTo(chatId: number | string): SentMessage | undefined {
    return this.sent.findLast((m) => m.chatId === String(chatId));
  }

  private async handle(req: IncomingMessage): Promise<{ status: number; body: unknown }> {
    const match = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? '');
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks);
    if (!match || match[1] !== this.token)
      return { status: 401, body: { ok: false, description: 'Unauthorized' } };
    const method = match[2]!;
    this.calls.set(method, (this.calls.get(method) ?? 0) + 1);
    const failure = this.failures.findIndex((f) => f.method === method);
    if (failure >= 0) {
      const [f] = this.failures.splice(failure, 1);
      return {
        status: f!.status,
        body: {
          ok: false,
          description: 'failure',
          ...(f!.retryAfter ? { parameters: { retry_after: f!.retryAfter } } : {}),
        },
      };
    }
    if (method === 'getUpdates') {
      const { offset } = JSON.parse(raw.toString()) as { offset: number };
      const ready = this.updates.filter((u) => u.update_id >= offset);
      for (const u of ready) this.delivered.set(u.update_id, u);
      // Confirmed (below offset) updates are forgotten, as by the real API.
      this.updates = this.updates.filter((u) => u.update_id >= offset && !ready.includes(u));
      return { status: 200, body: { ok: true, result: ready } };
    }
    if (method === 'sendMessage') {
      const body = JSON.parse(raw.toString()) as {
        chat_id: string;
        text: string;
        reply_markup?: SentMessage['replyMarkup'];
      };
      this.sent.push({
        chatId: String(body.chat_id),
        text: body.text,
        replyMarkup: body.reply_markup,
      });
      return { status: 200, body: { ok: true, result: { message_id: this.sent.length } } };
    }
    if (method === 'sendDocument') {
      const text = raw.toString('latin1');
      const field = (name: string) =>
        new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)\\r\\n`).exec(text)?.[1] ?? null;
      const fileName = /name="document"; filename="([^"]+)"/.exec(text)?.[1] ?? '';
      const start = text.indexOf('%PDF-');
      const end = text.lastIndexOf('%%EOF');
      this.documents.push({
        chatId: field('chat_id') ?? '',
        fileName,
        caption:
          field('caption') === null
            ? null
            : Buffer.from(field('caption')!, 'latin1').toString('utf8'),
        content: start >= 0 && end > start ? raw.subarray(start, end + 5) : Buffer.alloc(0),
      });
      return { status: 200, body: { ok: true, result: { message_id: 1 } } };
    }
    return { status: 404, body: { ok: false, description: 'Not Found' } };
  }
}
