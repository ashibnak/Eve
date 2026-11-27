import { z } from 'zod';

/**
 * The parts of a Bale Bot API update we use (Telegram-compatible format). Anything else in an
 * update is ignored; an update we cannot read is skipped, never retried forever.
 */
const User = z.object({ id: z.number().int() });
const Chat = z.object({ id: z.number().int(), type: z.string() });
const Contact = z.object({
  phone_number: z.string(),
  user_id: z.number().int().optional(),
});
const Message = z.object({
  message_id: z.number().int(),
  from: User.optional(),
  chat: Chat,
  text: z.string().optional(),
  contact: Contact.optional(),
});
export const UpdateSchema = z.object({
  update_id: z.number().int(),
  message: Message.optional(),
});
export type BaleUpdate = z.infer<typeof UpdateSchema>;

/** What the platform does with an update, independent of Bale's wire format. */
export type Inbound =
  | { kind: 'start'; chatId: string }
  | { kind: 'text'; chatId: string; text: string }
  /** A contact the sender shared; `own` only when Bale says it is the sender's own number. */
  | { kind: 'contact'; chatId: string; phone: string; own: boolean }
  | { kind: 'ignored' };

export function toInbound(update: BaleUpdate): Inbound {
  const message = update.message;
  // Private chats only: a bot added to a group must not link or answer anyone there.
  if (!message || message.chat.type !== 'private' || !message.from) return { kind: 'ignored' };
  const chatId = String(message.chat.id);
  if (message.contact) {
    const own =
      message.contact.user_id !== undefined && message.contact.user_id === message.from.id;
    return { kind: 'contact', chatId, phone: message.contact.phone_number, own };
  }
  if (message.text !== undefined) {
    if (/^\/start(\s|$)/.test(message.text)) return { kind: 'start', chatId };
    return { kind: 'text', chatId, text: message.text };
  }
  return { kind: 'ignored' };
}
