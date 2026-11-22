/**
 * Builds the platform services by hand for integration tests (same wiring as the Nest modules,
 * without the HTTP layer) against a test database.
 */
import { Client } from 'pg';
import { AuditService } from '../src/platform/audit/audit.service';
import { CompanyService } from '../src/platform/company/company.service';
import { ConfigService } from '../src/platform/config/config.service';
import { SettingsRegistry, TimeZoneSetting } from '../src/platform/config/settings';
import { Clock } from '../src/platform/context/clock';
import {
  newCorrelationId,
  type RequestContext,
  runWithContext,
} from '../src/platform/context/request-context';
import { TxRunner } from '../src/platform/context/tx-runner';
import { PrismaService } from '../src/platform/db/prisma.service';
import { EventConsumers } from '../src/platform/events/event-consumers';
import { EventPublisher } from '../src/platform/events/event-publisher';
import { EventRegistry } from '../src/platform/events/event-registry';
import { OutboxRelay } from '../src/platform/events/outbox-relay';
import { JobsService } from '../src/platform/jobs/jobs.service';
import type { TestDatabase } from './database';

export function createPlatform(db: TestDatabase) {
  process.env.DATABASE_URL = db.appUrl;
  const prisma = new PrismaService();
  const clock = new Clock();
  const txRunner = new TxRunner(prisma);
  const audit = new AuditService(prisma, clock);
  const eventRegistry = new EventRegistry();
  const events = new EventPublisher(eventRegistry, clock);
  const settings = new SettingsRegistry();
  const config = new ConfigService(prisma, txRunner, settings, audit, events, clock, eventRegistry);
  const companies = new CompanyService(
    prisma,
    txRunner,
    audit,
    events,
    config,
    clock,
    eventRegistry,
  );
  const jobs = new JobsService();
  const relay = new OutboxRelay(txRunner, jobs);
  const consumers = new EventConsumers(eventRegistry, txRunner, jobs);
  return {
    prisma,
    clock,
    txRunner,
    audit,
    eventRegistry,
    events,
    settings,
    config,
    companies,
    jobs,
    relay,
    consumers,
    async close() {
      await jobs.onApplicationShutdown();
      relay.onApplicationShutdown();
      await prisma.$disconnect();
    },
  };
}

export type Platform = ReturnType<typeof createPlatform>;

/** Runs `fn` as a test user with a fresh correlation id; returns the result and that id. */
export async function asUser<T>(
  fn: () => Promise<T>,
  overrides: Partial<RequestContext> = {},
): Promise<{ result: T; correlationId: string }> {
  const context: RequestContext = {
    actor: { kind: 'user', id: 'test-admin' },
    source: 'manual',
    correlationId: newCorrelationId(),
    causationId: null,
    requestId: null,
    actionId: null,
    ...overrides,
  };
  const result = await runWithContext(context, fn);
  return { result, correlationId: context.correlationId };
}

/** Ensures the customer time zone is set (other settings and events depend on it). */
export async function ensureTimeZone(platform: Platform): Promise<void> {
  await asUser(() =>
    platform.config.set({
      setting: TimeZoneSetting,
      companyId: null,
      value: 'Asia/Tehran',
      reason: 'test setup',
    }),
  );
}

/** A raw connection, e.g. as the owner role to tamper with rows deliberately. */
export async function rawClient(url: string): Promise<Client> {
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

let companySeq = 0;
export function uniqueCompanyCode(prefix = 'C'): string {
  companySeq += 1;
  return `${prefix}${Date.now().toString(36).toUpperCase()}${companySeq}`;
}
