import { describe, expect, it } from 'vitest';
import en from './en.json';
import fa from './fa.json';
import { isMessageKey, renderMessage } from './messages';

describe('server messages', () => {
  it('have the same keys in every locale', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(fa).sort());
  });

  it('render the one-time code message', () => {
    const text = renderMessage('auth.otp', { code: '123456', minutes: '2' }, 'fa');
    expect(text).toContain('123456');
    expect(text).not.toContain('{');
  });

  it('know which template keys exist', () => {
    expect(isMessageKey('auth.otp')).toBe(true);
    expect(isMessageKey('nope')).toBe(false);
  });
});
