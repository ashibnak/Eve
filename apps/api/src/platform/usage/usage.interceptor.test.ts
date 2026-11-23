import { describe, expect, it } from 'vitest';
import { moduleOf } from './usage.interceptor';

describe('moduleOf', () => {
  it.each([
    ['/api/v1/platform/users', 'platform'],
    ['/api/v1/org/positions/1', 'org'],
    ['/api/v1/auth/me', 'auth'],
    ['/elsewhere', 'unknown'],
  ])('%s → %s', (path, module) => {
    expect(moduleOf(path)).toBe(module);
  });
});
