import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { isValidTimeZone } from '../dates/dates';

export type SettingScope = 'customer' | 'customer_or_company';

export interface SettingDefinition<TSchema extends z.ZodType = z.ZodType> {
  /** `<component-or-slug>.<name>`, e.g. `platform.time_zone`. */
  key: string;
  schema: TSchema;
  /** `customer`: one customer-wide value. `customer_or_company`: a company may override it. */
  scope: SettingScope;
  /**
   * Value used when nothing is stored. Omit it when there is no safe universal value: reading an
   * unset setting then fails loudly instead of silently assuming one (ADR-010, ADR-012).
   */
  default?: z.output<TSchema>;
}

export function defineSetting<TSchema extends z.ZodType>(
  definition: SettingDefinition<TSchema>,
): SettingDefinition<TSchema> {
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(definition.key)) {
    throw new Error(`Invalid setting key "${definition.key}"`);
  }
  return definition;
}

/** The customer's IANA time zone; decides which calendar day "today" is for effective dates. */
export const TimeZoneSetting = defineSetting({
  key: 'platform.time_zone',
  schema: z.string().refine(isValidTimeZone, 'Unknown IANA time zone'),
  scope: 'customer',
});

/** All settings by key; a key must be registered before it can be read or written. */
@Injectable()
export class SettingsRegistry {
  private readonly definitions = new Map<string, SettingDefinition>();

  constructor() {
    this.register(TimeZoneSetting);
  }

  register(...definitions: SettingDefinition[]): void {
    for (const definition of definitions) {
      const existing = this.definitions.get(definition.key);
      if (existing && existing !== definition) {
        throw new Error(`Setting ${definition.key} is already registered`);
      }
      this.definitions.set(definition.key, definition);
    }
  }

  get(key: string): SettingDefinition {
    const definition = this.definitions.get(key);
    if (!definition) throw new Error(`Setting ${key} is not registered`);
    return definition;
  }
}
