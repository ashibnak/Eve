import { describe, expect, it } from 'vitest';
import { retryDelayMs } from './bale/bale.client';
import { toInbound, UpdateSchema } from './bale/updates';
import { normalizePhone } from './phone';

describe('phone numbers', () => {
  it.each([
    ['09123456789', '989123456789'],
    ['0912 345 6789', '989123456789'],
    ['0912-345-6789', '989123456789'],
    ['+98 912 345 6789', '989123456789'],
    ['00989123456789', '989123456789'],
    ['989123456789', '989123456789'],
    ['9123456789', '989123456789'],
    ['۰۹۱۲۳۴۵۶۷۸۹', '989123456789'],
    ['+44 20 7946 0958', '442079460958'],
  ])('%s → %s', (raw, expected) => {
    expect(normalizePhone(raw, '98')).toBe(expected);
  });

  it('rejects what is not a phone number', () => {
    expect(normalizePhone('ali.rezaei', '98')).toBeNull();
    expect(normalizePhone('@bale_user', '98')).toBeNull();
    expect(normalizePhone('123', '98')).toBeNull();
    expect(normalizePhone('', '98')).toBeNull();
  });
});

const update = (message: Record<string, unknown>) =>
  UpdateSchema.parse({ update_id: 1, message: { message_id: 1, ...message } });

describe('Bale updates', () => {
  const chat = { id: 555, type: 'private' };

  it('accepts a contact as own only when Bale says it is the sender', () => {
    expect(
      toInbound(
        update({
          from: { id: 555 },
          chat,
          contact: { phone_number: '989121112233', user_id: 555 },
        }),
      ),
    ).toEqual({
      kind: 'contact',
      chatId: '555',
      phone: '989121112233',
      own: true,
    });
    // A forwarded contact card: someone else's number.
    expect(
      toInbound(
        update({
          from: { id: 555 },
          chat,
          contact: { phone_number: '989121112233', user_id: 777 },
        }),
      ),
    ).toMatchObject({ own: false });
    // A typed-in contact without a Bale user behind it.
    expect(
      toInbound(update({ from: { id: 555 }, chat, contact: { phone_number: '989121112233' } })),
    ).toMatchObject({ own: false });
  });

  it('reads /start and text, and ignores groups and other content', () => {
    expect(toInbound(update({ from: { id: 555 }, chat, text: '/start' }))).toEqual({
      kind: 'start',
      chatId: '555',
    });
    expect(toInbound(update({ from: { id: 555 }, chat, text: 'سلام' }))).toEqual({
      kind: 'text',
      chatId: '555',
      text: 'سلام',
    });
    expect(
      toInbound(update({ from: { id: 555 }, chat: { id: -9, type: 'group' }, text: '/start' })),
    ).toEqual({ kind: 'ignored' });
    expect(toInbound(update({ from: { id: 555 }, chat }))).toEqual({ kind: 'ignored' });
    expect(toInbound(UpdateSchema.parse({ update_id: 2 }))).toEqual({ kind: 'ignored' });
  });
});

describe('Bale retries', () => {
  it('retries network errors, 5xx and 429 (honouring retry_after), never other 4xx', () => {
    expect(retryDelayMs(null, undefined, 0)).toBe(500);
    expect(retryDelayMs(502, undefined, 1)).toBe(1000);
    expect(retryDelayMs(429, 3, 0)).toBe(3000);
    expect(retryDelayMs(429, 600, 0)).toBe(30_000);
    expect(retryDelayMs(401, undefined, 0)).toBeNull();
    expect(retryDelayMs(400, undefined, 0)).toBeNull();
    expect(retryDelayMs(403, undefined, 0)).toBeNull();
  });
});
