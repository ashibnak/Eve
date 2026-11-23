import { describe, expect, it } from 'vitest';
import { jurisdiction } from './index.js';

describe('ir jurisdiction pack', () => {
  it('identifies itself by ISO country code', () => {
    expect(jurisdiction.code).toBe('ir');
    expect(jurisdiction.calendar.id).toBe('persian');
    expect(jurisdiction.defaultTimeZone).toBe('Asia/Tehran');
    expect(jurisdiction.defaultCurrency).toBe('IRR');
  });
});
