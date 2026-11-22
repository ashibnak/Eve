import { Injectable } from '@nestjs/common';
import { platformV1 } from '@eve/contracts';
import type { z } from 'zod';

export interface EventDefinition<TSchema extends z.ZodType = z.ZodType> {
  type: string;
  schemaVersion: number;
  payload: TSchema;
}

/** Declares an event type; owners keep the definition next to their contract. */
export function defineEvent<TSchema extends z.ZodType>(
  definition: EventDefinition<TSchema>,
): EventDefinition<TSchema> {
  platformV1.EventTypeSchema.parse(definition.type);
  return definition;
}

/**
 * Every event type must be registered with its payload schema before it can be published or
 * consumed (CLAUDE.md rule 10). Keyed by `type@schema_version`.
 */
@Injectable()
export class EventRegistry {
  private readonly definitions = new Map<string, EventDefinition>();

  register(...definitions: EventDefinition[]): void {
    for (const definition of definitions) {
      const key = registryKey(definition.type, definition.schemaVersion);
      const existing = this.definitions.get(key);
      if (existing && existing !== definition)
        throw new Error(`Event ${key} is already registered`);
      this.definitions.set(key, definition);
    }
  }

  get(type: string, schemaVersion: number): EventDefinition {
    const definition = this.definitions.get(registryKey(type, schemaVersion));
    if (!definition) throw new Error(`Event ${registryKey(type, schemaVersion)} is not registered`);
    return definition;
  }
}

function registryKey(type: string, schemaVersion: number): string {
  return `${type}@${schemaVersion}`;
}
