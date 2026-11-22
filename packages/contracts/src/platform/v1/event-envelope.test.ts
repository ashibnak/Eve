import { describe, expect, it } from 'vitest';
import { EventEnvelopeSchema } from './event-envelope.js';

const valid = {
  event_id: '0b9d3c55-2a3f-4c55-9a4e-6f3c1f3b2a10',
  type: 'platform.config.changed',
  schema_version: 1,
  occurred_at: '2026-11-22T10:00:00.000Z',
  effective_at: '2026-11-22',
  correlation_id: '6f1d0a8e-2c1b-4d3e-8f7a-9b0c1d2e3f40',
  causation_id: null,
  actor: { kind: 'user', id: 'u1' },
  source: 'manual',
  company_id: null,
};

describe('EventEnvelopeSchema', () => {
  it('accepts a complete envelope', () => {
    expect(EventEnvelopeSchema.parse(valid)).toMatchObject({ type: 'platform.config.changed' });
  });

  it.each([
    ['type without entity', { type: 'config.changed' }],
    ['non-UTC occurred_at', { occurred_at: '2026-11-22T10:00:00+03:30' }],
    ['effective_at with time', { effective_at: '2026-11-22T00:00:00Z' }],
    ['agent without principal', { actor: { kind: 'agent', id: 'a1' } }],
    ['unknown source', { source: 'email' }],
  ])('rejects %s', (_label, patch) => {
    expect(EventEnvelopeSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
  });
});
