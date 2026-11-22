import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { z } from 'zod';
import { asUser, createPlatform, ensureTimeZone, type Platform } from '../../../test/platform';
import { ConfigChanged } from '../config/config.service';
import { defineSetting } from '../config/settings';
import type { platformV1 } from '@eve/contracts';
import { defineEvent } from './event-registry';

const Flag = defineSetting({
  key: 'test.events_flag',
  schema: z.boolean(),
  scope: 'customer',
  default: false,
});

const Unregistered = defineEvent({
  type: 'test.thing.happened',
  schemaVersion: 1,
  payload: z.object({}),
});

async function waitFor(check: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('events: outbox, relay and idempotent consumers', () => {
  let platform: Platform;
  const received: platformV1.EventMessage<unknown>[] = [];
  let failNext = false;

  beforeAll(async () => {
    const db = inject('db');
    platform = createPlatform(db);
    platform.settings.register(Flag);
    await ensureTimeZone(platform);
    platform.consumers.register({
      name: 'test.config_watcher',
      event: ConfigChanged,
      handle: async (tx, message) => {
        await tx.$queryRaw`SELECT 1`;
        if (failNext) {
          failNext = false;
          throw new Error('handler failed');
        }
        received.push(message);
      },
    });
    await platform.jobs.start(db.appUrl);
    await platform.consumers.start();
  });

  afterAll(() => platform.close());

  it('relays a committed event to its consumer exactly once', async () => {
    const { correlationId } = await asUser(() =>
      platform.config.set({ setting: Flag, companyId: null, value: true, reason: 'relay test' }),
    );
    await platform.relay.relayPending();
    expect(await platform.relay.relayPending()).toBe(0);

    await waitFor(() => received.some((m) => m.correlation_id === correlationId));
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const mine = received.filter((m) => m.correlation_id === correlationId);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      type: 'platform.config.changed',
      payload: { key: 'test.events_flag', company_id: null },
      actor: { kind: 'user', id: 'test-admin' },
      source: 'manual',
    });

    const row = await platform.prisma.eventsOutbox.findFirstOrThrow({ where: { correlationId } });
    expect(row.publishedAt).not.toBeNull();
  });

  it('skips a redelivered event (idempotent on event_id)', async () => {
    const message = received.at(-1);
    expect(message).toBeDefined();
    const before = received.length;
    expect(await platform.consumers.deliver('test.config_watcher', message)).toBe('duplicate');
    expect(received).toHaveLength(before);
  });

  it('leaves no inbox record when the handler fails, so a retry applies it', async () => {
    const { correlationId } = await asUser(() =>
      platform.config.set({ setting: Flag, companyId: null, value: false, reason: 'retry test' }),
    );
    const row = await platform.prisma.eventsOutbox.findFirstOrThrow({ where: { correlationId } });
    const message = {
      event_id: row.eventId,
      type: row.type,
      schema_version: row.schemaVersion,
      occurred_at: row.occurredAt.toISOString(),
      effective_at: row.effectiveAt.toISOString().slice(0, 10),
      correlation_id: row.correlationId,
      causation_id: row.causationId,
      actor: row.actor,
      source: row.source,
      company_id: row.companyId,
      payload: row.payload,
    };

    failNext = true;
    await expect(platform.consumers.deliver('test.config_watcher', message)).rejects.toThrow(
      'handler failed',
    );
    expect(
      await platform.prisma.eventsInbox.count({
        where: { consumer: 'test.config_watcher', eventId: row.eventId },
      }),
    ).toBe(0);
    expect(await platform.consumers.deliver('test.config_watcher', message)).toBe('applied');
  });

  it('refuses to publish an unregistered event type', async () => {
    await expect(
      asUser(() =>
        platform.txRunner.run((tx) =>
          platform.events.publish(tx, {
            event: Unregistered,
            payload: {},
            effectiveAt: '2026-11-22' as platformV1.BusinessDate,
            companyId: null,
          }),
        ),
      ),
    ).rejects.toThrow('not registered');
  });

  it('rejects a payload that does not match the registered schema', async () => {
    await expect(
      asUser(() =>
        platform.txRunner.run((tx) =>
          platform.events.publish(tx, {
            event: ConfigChanged,
            payload: { key: 42 } as never,
            effectiveAt: '2026-11-22' as platformV1.BusinessDate,
            companyId: null,
          }),
        ),
      ),
    ).rejects.toThrow();
  });
});
