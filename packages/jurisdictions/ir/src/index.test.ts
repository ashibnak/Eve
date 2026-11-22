import { describe, expect, it } from 'vitest';
import { jurisdiction } from './index.js';

describe('ir jurisdiction pack', () => {
  it('identifies itself by ISO country code', () => {
    expect(jurisdiction.code).toBe('ir');
  });
});
