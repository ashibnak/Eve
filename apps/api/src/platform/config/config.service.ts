import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { toCanonicalValue } from '../audit/canonical-json';
import { Clock } from '../context/clock';
import { type Tx, TxRunner } from '../context/tx-runner';
import { businessDateIn } from '../dates/dates';
import { PrismaService } from '../db/prisma.service';
import { defineEvent, EventRegistry } from '../events/event-registry';
import { EventPublisher } from '../events/event-publisher';
import { type SettingDefinition, SettingsRegistry, TimeZoneSetting } from './settings';

/** Emitted whenever a setting changes; consumers re-read the value they care about. */
export const ConfigChanged = defineEvent({
  type: 'platform.config.changed',
  schemaVersion: 1,
  payload: z.object({ key: z.string(), company_id: z.uuid().nullable() }),
});

export class SettingNotConfiguredError extends Error {
  constructor(readonly key: string) {
    super(`Setting ${key} has no value and no default; set it before use`);
  }
}

export interface SetSettingRequest<TSchema extends z.ZodType> {
  setting: SettingDefinition<TSchema>;
  /** null = customer-wide value. */
  companyId: string | null;
  value: z.input<TSchema>;
  reason: string;
}

/** Customer settings stored in the database (ADR-012), read with company → customer → default. */
@Injectable()
export class ConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly txRunner: TxRunner,
    private readonly registry: SettingsRegistry,
    private readonly audit: AuditService,
    private readonly events: EventPublisher,
    private readonly clock: Clock,
    eventRegistry: EventRegistry,
  ) {
    eventRegistry.register(ConfigChanged);
  }

  async get<TSchema extends z.ZodType>(
    setting: SettingDefinition<TSchema>,
    companyId: string | null = null,
  ): Promise<z.output<TSchema>> {
    const definition = this.registry.get(setting.key);
    const rows = await this.prisma.configSetting.findMany({
      where: {
        key: definition.key,
        OR: [{ companyId: null }, ...(companyId ? [{ companyId }] : [])],
      },
      select: { companyId: true, value: true },
    });
    const row =
      rows.find((r) => r.companyId === companyId) ?? rows.find((r) => r.companyId === null);
    if (row) return setting.schema.parse(row.value);
    if (definition.default !== undefined) return definition.default as z.output<TSchema>;
    throw new SettingNotConfiguredError(definition.key);
  }

  /**
   * Changes a setting as one atomic, audited command: the new value, its audit row and the
   * `platform.config.changed` event commit together or not at all.
   */
  async set<TSchema extends z.ZodType>(request: SetSettingRequest<TSchema>): Promise<void> {
    const definition = this.registry.get(request.setting.key);
    if (definition !== request.setting) throw new Error(`Setting ${definition.key} mismatch`);
    if (request.companyId !== null && definition.scope !== 'customer_or_company') {
      throw new Error(`Setting ${definition.key} is customer-wide and cannot be set per company`);
    }
    const value = toCanonicalValue(definition.schema.parse(request.value));
    const timeZone =
      definition === TimeZoneSetting ? (value as string) : await this.get(TimeZoneSetting);

    await this.txRunner.run(async (tx) => {
      const before = await this.lockCurrent(tx, definition.key, request.companyId);
      const rows = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO config_setting (key, company_id, value, updated_at)
        VALUES (${definition.key}, ${request.companyId}::uuid, ${JSON.stringify(value)}::jsonb, ${this.clock.now()})
        ON CONFLICT ON CONSTRAINT config_setting_key_company_uq
        DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
        RETURNING id`;
      const id = rows[0]?.id;
      if (!id) throw new Error('Upsert of config_setting returned no row');

      await this.audit.record(tx, {
        action: 'platform.config.set',
        entityType: 'config_setting',
        entityId: id,
        companyId: request.companyId,
        before: before === undefined ? null : { key: definition.key, value: before },
        after: { key: definition.key, value },
        reason: request.reason,
      });
      await this.events.publish(tx, {
        event: ConfigChanged,
        payload: { key: definition.key, company_id: request.companyId },
        effectiveAt: businessDateIn(this.clock.now(), timeZone),
        companyId: request.companyId,
      });
    });
  }

  /** Serializes writers of one key (even before its first row exists) and returns its value. */
  private async lockCurrent(tx: Tx, key: string, companyId: string | null): Promise<unknown> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`config:${key}`}))`;
    const rows = await tx.$queryRaw<{ value: unknown }[]>`
      SELECT value FROM config_setting
      WHERE key = ${key} AND company_id IS NOT DISTINCT FROM ${companyId}::uuid
      FOR UPDATE`;
    return rows[0]?.value;
  }
}
