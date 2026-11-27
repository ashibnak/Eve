/**
 * Builds the platform services by hand for integration tests (same wiring as the Nest modules,
 * without the HTTP layer) against a test database.
 */
import { Client } from 'pg';
import { ApprovalService } from '../src/platform/approvals/approval.service';
import { ApprovalTypeRegistry } from '../src/platform/approvals/request-types';
import { AuditService } from '../src/platform/audit/audit.service';
import { AuthService } from '../src/platform/auth/auth.service';
import { RoleRegistry } from '../src/platform/auth/roles';
import { UserService } from '../src/platform/auth/user.service';
import { ChannelRegistry } from '../src/platform/channels/channel';
import { LocalDiskFileStore } from '../src/platform/files/file-store';
import { ImportService } from '../src/platform/connectors/import.service';
import { DocumentService } from '../src/platform/documents/document.service';
import { ChromiumPdfRenderer } from '../src/platform/documents/pdf';
import { DocumentTemplateRegistry } from '../src/platform/documents/template';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StubChannel } from '../src/platform/channels/stub.channel';
import { UserNotifier } from '../src/platform/channels/user-notifier';
import { ChannelIdentities } from '../src/platform/channels/identity';
import { InboundHandlers } from '../src/platform/channels/inbound';
import { ChannelLinking } from '../src/platform/channels/linking';
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
import {
  HomeJurisdictionSetting,
  JurisdictionRegistry,
} from '../src/platform/jurisdiction/jurisdiction.registry';
import { jurisdiction as ir } from '@eve/jurisdiction-ir';
import { AccessService } from '../src/platform/scope/access.service';
import { ScopedDb } from '../src/platform/scope/scoped-db';
import { UsageService } from '../src/platform/usage/usage.service';
import { ParamVersionsService } from '../src/platform/rules/param-versions.service';
import { RuleParamsChanged, ruleParamsChangeType } from '../src/platform/rules/rule-params.request';
import { RuleRegistry } from '../src/platform/rules/rule-registry';
import { RuleRuntime } from '../src/platform/rules/rule-runtime';
import { UnitSubtreeRegistry } from '../src/platform/scope/unit-subtree.registry';
import type { TestDatabase } from './database';

/** A clock tests can move forward, e.g. past a code's expiry or a lockout. */
export class TestClock extends Clock {
  private offsetMs = 0;

  override now(): Date {
    return new Date(Date.now() + this.offsetMs);
  }

  advance(ms: number): void {
    this.offsetMs += ms;
  }

  /** Moves the clock to an exact instant; time keeps running from there. */
  setTime(instant: Date): void {
    this.offsetMs = instant.getTime() - Date.now();
  }

  reset(): void {
    this.offsetMs = 0;
  }
}

export function createPlatform(db: TestDatabase) {
  process.env.DATABASE_URL = db.appUrl;
  const prisma = new PrismaService();
  const clock = new TestClock();
  const txRunner = new TxRunner(prisma);
  const audit = new AuditService(prisma, clock);
  const eventRegistry = new EventRegistry();
  const events = new EventPublisher(eventRegistry, clock);
  const settings = new SettingsRegistry();
  const config = new ConfigService(prisma, txRunner, settings, audit, events, clock, eventRegistry);
  settings.register(HomeJurisdictionSetting);
  const jurisdictions = new JurisdictionRegistry([ir]);
  const companies = new CompanyService(
    prisma,
    txRunner,
    audit,
    events,
    config,
    clock,
    jurisdictions,
    eventRegistry,
  );
  const jobs = new JobsService();
  const relay = new OutboxRelay(txRunner, jobs);
  const consumers = new EventConsumers(eventRegistry, txRunner, jobs);
  const stubChannel = new StubChannel(false);
  const channels = new ChannelRegistry();
  channels.register(stubChannel);
  const roles = new RoleRegistry();
  const auth = new AuthService(prisma, txRunner, audit, config, channels, clock, settings);
  const users = new UserService(prisma, txRunner, audit, config, channels, roles, clock);
  const usage = new UsageService(prisma, config, jurisdictions, clock);
  const unitSubtree = new UnitSubtreeRegistry();
  const access = new AccessService(prisma, roles, config, clock, unitSubtree);
  const scopedDb = new ScopedDb(prisma, access);
  const rules = new RuleRegistry();
  const ruleParams = new ParamVersionsService(prisma, clock);
  const ruleRuntime = new RuleRuntime(rules, ruleParams, clock);
  const approvalTypes = new ApprovalTypeRegistry(settings);
  const notifier = new UserNotifier(prisma, channels);
  const approvals = new ApprovalService(
    prisma,
    txRunner,
    audit,
    events,
    config,
    clock,
    access,
    approvalTypes,
    roles,
    rules,
    notifier,
    eventRegistry,
  );
  eventRegistry.register(RuleParamsChanged);
  approvalTypes.register(ruleParamsChangeType({ rules, params: ruleParams, audit, events }));
  const files = new LocalDiskFileStore(mkdtempSync(join(tmpdir(), 'eve-files-')));
  const imports = new ImportService(
    prisma,
    txRunner,
    audit,
    events,
    config,
    clock,
    access,
    jurisdictions,
    files,
    approvals,
    approvalTypes,
    settings,
    eventRegistry,
  );
  const identities = new ChannelIdentities();
  const inboundHandlers = new InboundHandlers();
  const linking = new ChannelLinking(
    prisma,
    txRunner,
    audit,
    users,
    config,
    jurisdictions,
    identities,
    clock,
  );
  const pdf = new ChromiumPdfRenderer();
  const documentTemplates = new DocumentTemplateRegistry();
  const documents = new DocumentService(
    prisma,
    txRunner,
    audit,
    events,
    config,
    clock,
    access,
    jurisdictions,
    files,
    pdf,
    settings,
    eventRegistry,
  );
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
    stubChannel,
    jurisdictions,
    channels,
    roles,
    auth,
    users,
    access,
    usage,
    rules,
    ruleParams,
    ruleRuntime,
    approvalTypes,
    approvals,
    notifier,
    files,
    imports,
    identities,
    inboundHandlers,
    linking,
    pdf,
    documentTemplates,
    documents,
    scopedDb,
    unitSubtree,
    async close() {
      await jobs.onApplicationShutdown();
      relay.onApplicationShutdown();
      await pdf.onApplicationShutdown();
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

/** Sets the customer's home jurisdiction (calendar for usage months). */
export async function ensureHomeJurisdiction(platform: Platform, code = 'ir'): Promise<void> {
  await asUser(() =>
    platform.config.set({
      setting: HomeJurisdictionSetting,
      companyId: null,
      value: code,
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

let uniqueSeq = 0;
function uniqueSuffix(): string {
  uniqueSeq += 1;
  return `${Date.now().toString(36)}${uniqueSeq}`;
}

/** A fresh username that satisfies the username rule. */
export function uniqueUsername(prefix = 'user'): string {
  return `${prefix}.${uniqueSuffix()}`;
}

let companySeq = 0;
export function uniqueCompanyCode(prefix = 'C'): string {
  companySeq += 1;
  return `${prefix}${Date.now().toString(36).toUpperCase()}${companySeq}`;
}
