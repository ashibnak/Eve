import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createPeople } from './people.harness';
import { randomUUID } from 'node:crypto';
import { FakeBale } from '../../../../../test/fake-bale';
import {
  asUser,
  createPlatform,
  ensureHomeJurisdiction,
  ensureTimeZone,
  type Platform,
  uniqueCompanyCode,
  uniqueUsername,
} from '../../../../../test/platform';
import { renderMessage } from '../../../../platform/i18n/messages';
import { BaleChannel } from '../../../../platform/channels/bale/bale.channel';
import { BaleApiError, BaleClient } from '../../../../platform/channels/bale/bale.client';
import { BalePoller } from '../../../../platform/channels/bale/bale.poller';
import { MAX_FAILED_ATTEMPTS } from '../../../../platform/channels/linking';

const text = (key: Parameters<typeof renderMessage>[0]) => renderMessage(key, {}, 'fa');
const PASSWORD = 'a-long-enough-password';

describe('Bale channel and identity linking (S12)', () => {
  let platform: Platform;
  let people: ReturnType<typeof createPeople>;
  let fake: FakeBale;
  let client: BaleClient;
  let poller: BalePoller;
  const companies: Record<string, string> = {};
  // Unusual numbers per run, so other test files' people never match.
  const base = 9_990_000_000 + Math.floor(Math.random() * 9_000_000);
  const phone = (n: number) => `0${base + n}`;
  const intl = (n: number) => `98${base + n}`;
  let chat = 7_000_000 + Math.floor(Math.random() * 1_000_000);
  const nextChat = () => ++chat;
  const persons = {} as Record<
    'employee' | 'employeeInB' | 'leaver' | 'twinOne' | 'twinTwo' | 'withLogin',
    string
  >;

  async function company(prefix: string) {
    return (
      await asUser(() =>
        platform.companies.register({
          code: uniqueCompanyCode(prefix),
          jurisdictionCode: 'ir',
          reason: 't',
        }),
      )
    ).result.id;
  }

  async function setPhone(personId: string, n: number) {
    await platform.prisma.peoplePerson.update({
      where: { id: personId },
      data: { contactChannel: 'sms', contactAddress: phone(n) },
    });
  }

  beforeAll(async () => {
    platform = createPlatform(inject('db'));
    people = createPeople(platform);
    await ensureTimeZone(platform);
    await ensureHomeJurisdiction(platform);
    fake = new FakeBale();
    await fake.start();
    client = new BaleClient({
      baseUrl: fake.url,
      token: fake.token,
      sleep: () => Promise.resolve(),
    });
    platform.channels.register(new BaleChannel(client));
    poller = new BalePoller({
      client,
      prisma: platform.prisma,
      txRunner: platform.txRunner,
      linking: platform.linking,
      handlers: platform.inboundHandlers,
      clock: platform.clock,
      databaseUrl: inject('db').appUrl,
    });
    // The poller resumes from the stored offset; start this file after anything already confirmed.
    await platform.prisma.channelsPollState
      .deleteMany({ where: { channel: 'bale' } })
      .catch(() => undefined);

    companies.a = await company('BA');
    companies.b = await company('BB');
    let code = 0;
    const person = async (companyId: string, status: 'active' | 'terminated') => {
      const id = randomUUID();
      const now = new Date();
      code += 1;
      await platform.prisma.peoplePerson.create({
        data: {
          id,
          companyId,
          personnelCode: `BL${Date.now().toString(36)}${code}`.toUpperCase(),
          firstNameFa: 'نفر',
          lastNameFa: `شماره ${code}`,
          hireDate: new Date('2020-01-01T00:00:00Z'),
          createdAt: now,
          updatedAt: now,
        },
      });
      await platform.prisma.peopleEmploymentStatus.create({
        data: {
          personId: id,
          companyId,
          status,
          validFrom: new Date('2020-01-01T00:00:00Z'),
          validTo: null,
          recordedAt: now,
        },
      });
      return id;
    };
    persons.employee = await person(companies.a, 'active');
    persons.employeeInB = await person(companies.b, 'active');
    persons.leaver = await person(companies.a, 'terminated');
    persons.twinOne = await person(companies.a, 'active');
    persons.twinTwo = await person(companies.a, 'active');
    persons.withLogin = await person(companies.a, 'active');
    await setPhone(persons.employee, 1);
    await setPhone(persons.employeeInB, 1); // same person's number in a second company
    await setPhone(persons.leaver, 2);
    await setPhone(persons.twinOne, 3); // two employed people share a number: ambiguous
    await setPhone(persons.twinTwo, 3);
    await setPhone(persons.withLogin, 4);
  }, 120_000);

  afterAll(async () => {
    await poller.stop();
    await fake.stop();
    await platform.close();
  });

  const poll = () => poller.pollOnce(0);

  it('greets an unknown chat with a button to share their own number', async () => {
    const c = nextChat();
    fake.text(c, '/start');
    await poll();
    const reply = fake.lastTo(c)!;
    expect(reply.text).toBe(text('channels.link.welcome'));
    expect(reply.replyMarkup?.keyboard?.[0]?.[0]).toEqual({
      text: text('channels.link.share_button'),
      request_contact: true,
    });
  });

  it('links an employee who shares their own number, in every company they work for', async () => {
    const c = nextChat();
    fake.contact(c, `+${intl(1)}`, c);
    await poll();
    expect(fake.lastTo(c)).toMatchObject({
      text: text('channels.link.linked'),
      replyMarkup: { remove_keyboard: true },
    });

    const link = await platform.prisma.channelsLink.findFirstOrThrow({
      where: { channel: 'bale', address: String(c), endedAt: null },
    });
    const user = await platform.prisma.authUser.findUniqueOrThrow({ where: { id: link.userId } });
    expect(user).toMatchObject({
      contactChannel: 'bale',
      contactAddress: String(c),
      status: 'active',
    });
    const personLinks = await platform.prisma.peopleUserLink.findMany({
      where: { userId: user.id, endedAt: null },
    });
    expect(personLinks.map((l) => l.personId).sort()).toEqual(
      [persons.employee, persons.employeeInB].sort(),
    );
    const actions = (
      await platform.prisma.auditLog.findMany({
        where: { entityId: { in: [user.id, link.id, persons.employee] } },
      })
    ).map((r) => r.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'platform.auth.user.create',
        'platform.channels.link',
        'people.person.link_user',
      ]),
    );

    // From now on, messages reach the user in that chat; text gets the interim answer.
    await platform.notifier.notify([user.id], 'channels.services_coming', {});
    expect(fake.lastTo(c)?.text).toBe(text('channels.services_coming'));
    fake.text(c, 'سلام');
    await poll();
    expect(fake.lastTo(c)?.text).toBe(text('channels.services_coming'));

    // Sharing again changes nothing.
    fake.contact(c, `+${intl(1)}`, c);
    await poll();
    expect(fake.lastTo(c)?.text).toBe(text('channels.link.already'));
  });

  it('points an existing login to Bale: its web login code arrives in the chat', async () => {
    const username = uniqueUsername('bale');
    const { result: user } = await asUser(() =>
      platform.users.create({
        username,
        password: PASSWORD,
        contactChannel: 'stub',
        contactAddress: '09120000000',
        reason: 't',
      }),
    );
    const { result: owner } = await asUser(() =>
      platform.users.create({
        username: uniqueUsername('owner'),
        password: PASSWORD,
        contactChannel: 'stub',
        contactAddress: '09120000000',
        reason: 't',
      }),
    );
    await asUser(() =>
      platform.users.grantRole({
        userId: owner.id,
        role: 'people_data_owner',
        scopeKind: 'company',
        companyId: companies.a!,
        unitId: null,
        reason: 't',
      }),
    );
    await asUser(() => people.commands.linkUser(persons.withLogin, user.id, 'existing login'), {
      actor: { kind: 'user', id: owner.id },
    });
    const c = nextChat();
    fake.contact(c, phone(4), c);
    await poll();
    expect(fake.lastTo(c)?.text).toBe(text('channels.link.linked'));
    expect(
      await platform.prisma.authUser.count({
        where: { username: { startsWith: 'bale-' }, id: user.id },
      }),
    ).toBe(0);
    const before = fake.sent.length;
    await platform.auth.verifyPassword(username, PASSWORD);
    const otp = fake.sent.slice(before).find((m) => m.chatId === String(c));
    expect(otp?.text).toMatch(/[0-9]{6}/);
  });

  it('refuses forwarded contacts, unknown numbers, leavers and ambiguous numbers alike', async () => {
    const c = nextChat();
    fake.contact(c, phone(1), c + 1); // someone else's contact card
    await poll();
    expect(fake.lastTo(c)?.text).toBe(text('channels.link.own_only'));

    const replies: string[] = [];
    for (const n of [9, 2, 3]) {
      const chatId = nextChat();
      fake.contact(chatId, phone(n), chatId);
      await poll();
      replies.push(fake.lastTo(chatId)!.text);
    }
    // Unknown, not employed, ambiguous: one and the same answer, no hint of who exists.
    expect(new Set(replies)).toEqual(new Set([text('channels.link.not_found')]));
    expect(
      await platform.prisma.peopleUserLink.count({
        where: { personId: { in: [persons.leaver, persons.twinOne, persons.twinTwo] } },
      }),
    ).toBe(0);
  });

  it(`stops matching a chat after ${MAX_FAILED_ATTEMPTS} failed attempts in a day`, async () => {
    const c = nextChat();
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) fake.contact(c, phone(50 + i), c);
    await poll();
    fake.contact(c, phone(1), c); // even a valid number now
    await poll();
    expect(fake.lastTo(c)?.text).toBe(text('channels.link.too_many'));
  });

  it('processes a redelivered update once and resumes from the stored offset', async () => {
    const c = nextChat();
    const id = fake.text(c, '/start');
    await poll();
    const state = await platform.prisma.channelsPollState.findUniqueOrThrow({
      where: { channel: 'bale' },
    });
    expect(state.nextOffset).toBe(BigInt(id + 1));
    const sentBefore = fake.sent.filter((m) => m.chatId === String(c)).length;
    // A crash before the offset was saved: Bale hands the same update over again.
    await platform.prisma.channelsPollState.update({
      where: { channel: 'bale' },
      data: { nextOffset: BigInt(id) },
    });
    fake.redeliver(id);
    expect(await poll()).toBe(1);
    expect(fake.sent.filter((m) => m.chatId === String(c)).length).toBe(sentBefore);
  });

  it('lets only one poller run per deployment', async () => {
    const second = new BalePoller({
      client,
      prisma: platform.prisma,
      txRunner: platform.txRunner,
      linking: platform.linking,
      handlers: platform.inboundHandlers,
      clock: platform.clock,
      databaseUrl: inject('db').appUrl,
    });
    expect(await poller.acquire()).toBe(true);
    expect(await second.acquire()).toBe(false);
    await second.stop();
  });

  it('sends messages and PDFs, retries 429, and never leaks the token', async () => {
    const bale = platform.channels.get('bale');
    const c = String(nextChat());
    fake.failNext('sendMessage', 429, 1);
    await bale.send(c, { template: 'channels.services_coming', params: {} });
    expect(fake.sent.filter((m) => m.chatId === c)).toHaveLength(1);

    const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF');
    await bale.sendDocument!(c, {
      content: pdf,
      fileName: 'certificate.pdf',
      caption: { template: 'channels.link.linked', params: {} },
    });
    expect(fake.documents.at(-1)).toMatchObject({
      chatId: c,
      fileName: 'certificate.pdf',
      caption: text('channels.link.linked'),
    });
    expect(fake.documents.at(-1)!.content.equals(pdf)).toBe(true);

    const wrong = new BaleClient({
      baseUrl: fake.url,
      token: 'wrong:token-xyz',
      sleep: () => Promise.resolve(),
    });
    const calls = fake.calls.get('sendMessage') ?? 0;
    const error = await wrong.sendMessage(c, 'x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BaleApiError);
    expect((error as Error).message).toContain('401');
    expect((error as Error).message).not.toContain('token-xyz');
    expect(fake.calls.get('sendMessage') ?? 0).toBe(calls); // 401 counted before routing: not retried
  });

  it('hands text from linked users to the registered handler (S13 router)', async () => {
    const received: string[] = [];
    platform.inboundHandlers.use({
      handle: (m) => Promise.resolve(void received.push(`${m.channel}:${m.text}`)),
    });
    const c = nextChat();
    fake.contact(c, `+${intl(1)}`, c); // the employee again, on a new phone: the old chat stops
    await poll();
    expect(fake.lastTo(c)?.text).toBe(text('channels.link.linked'));
    fake.text(c, 'گواهی اشتغال');
    await poll();
    expect(received).toEqual(['bale:گواهی اشتغال']);
    const links = await platform.prisma.channelsLink.findMany({
      where: {
        channel: 'bale',
        userId: (
          await platform.prisma.channelsLink.findFirstOrThrow({ where: { address: String(c) } })
        ).userId,
      },
    });
    expect(links.filter((l) => l.endedAt === null)).toHaveLength(1);
  });
});
