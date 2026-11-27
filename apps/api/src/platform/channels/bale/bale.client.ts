import { z } from 'zod';
import { type BaleUpdate, UpdateSchema } from './updates';

export class BaleApiError extends Error {
  constructor(
    readonly method: string,
    readonly status: number | null,
    detail: string,
  ) {
    // Never the URL: it carries the bot token.
    super(`Bale ${method} failed${status === null ? '' : ` (${status})`}: ${detail}`);
  }
}

const Reply = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  description: z.string().optional(),
  parameters: z.object({ retry_after: z.number().optional() }).optional(),
});

/** Whether and when to try again after a failed call (null: give up). */
export function retryDelayMs(
  status: number | null,
  retryAfterSeconds: number | undefined,
  attempt: number,
): number | null {
  if (status === 429) return Math.min((retryAfterSeconds ?? 1) * 1000, 30_000);
  if (status === null || status >= 500) return 500 * 2 ** attempt; // network error or server side
  return null; // 4xx: our request is wrong (e.g. 401 bad token, 400 blocked chat); retrying will not help
}

export interface KeyboardButton {
  text: string;
  request_contact?: boolean;
}
export interface ReplyMarkup {
  keyboard?: KeyboardButton[][];
  one_time_keyboard?: boolean;
  resize_keyboard?: boolean;
  remove_keyboard?: boolean;
}

export interface BaleClientOptions {
  baseUrl: string;
  token: string;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Thin client for the Bale Bot API (Telegram-compatible). Outbound HTTPS only. Retries network
 * errors, 5xx and 429 a few times; a send may then, rarely, arrive twice (at-least-once).
 */
export class BaleClient {
  private readonly maxAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: BaleClientOptions) {
    this.maxAttempts = options.maxAttempts ?? 3;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private url(method: string): string {
    return `${this.options.baseUrl.replace(/\/$/, '')}/bot${this.options.token}/${method}`;
  }

  private async call(
    method: string,
    body: FormData | object,
    signal?: AbortSignal,
    retry = true,
  ): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      let status: number | null = null;
      let retryAfter: number | undefined;
      let detail: string;
      try {
        const isForm = body instanceof FormData;
        const response = await fetch(this.url(method), {
          method: 'POST',
          headers: isForm ? undefined : { 'content-type': 'application/json' },
          body: isForm ? body : JSON.stringify(body),
          signal,
        });
        status = response.status;
        const reply = Reply.safeParse(await response.json().catch(() => null));
        if (response.ok && reply.success && reply.data.ok) return reply.data.result;
        retryAfter = reply.success ? reply.data.parameters?.retry_after : undefined;
        detail = reply.success ? (reply.data.description ?? 'not ok') : 'unreadable reply';
      } catch (error) {
        if (signal?.aborted) throw error;
        detail = error instanceof Error ? error.name : 'network error';
      }
      const delay =
        retry && attempt + 1 < this.maxAttempts ? retryDelayMs(status, retryAfter, attempt) : null;
      if (delay === null) throw new BaleApiError(method, status, detail);
      await this.sleep(delay);
    }
  }

  /** Long poll: waits up to `timeoutSeconds` for updates after `offset`. Not retried here. */
  async getUpdates(
    offset: number,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<{ updateId: number; update: BaleUpdate | null }[]> {
    const result = await this.call(
      'getUpdates',
      { offset, timeout: timeoutSeconds, allowed_updates: ['message'] },
      signal,
      false,
    );
    if (!Array.isArray(result)) throw new BaleApiError('getUpdates', null, 'result is not a list');
    return result.map((raw) => {
      const id = z.object({ update_id: z.number().int() }).safeParse(raw);
      if (!id.success) throw new BaleApiError('getUpdates', null, 'update without update_id');
      const parsed = UpdateSchema.safeParse(raw);
      return { updateId: id.data.update_id, update: parsed.success ? parsed.data : null };
    });
  }

  async sendMessage(chatId: string, text: string, replyMarkup?: ReplyMarkup): Promise<void> {
    await this.call('sendMessage', {
      chat_id: chatId,
      text,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }

  async sendDocument(
    chatId: string,
    content: Buffer,
    fileName: string,
    caption?: string,
  ): Promise<void> {
    // A fresh form per attempt would be needed if a body stream were consumed; FormData with a Blob
    // can be re-sent, so one form serves all attempts.
    const form = new FormData();
    form.set('chat_id', chatId);
    if (caption) form.set('caption', caption);
    form.set(
      'document',
      new Blob([new Uint8Array(content)], { type: 'application/pdf' }),
      fileName,
    );
    await this.call('sendDocument', form);
  }
}
