import { describe, expect, it } from 'vitest';
import en from './en.json';
import fa from './fa.json';
import { t } from './t';

describe('i18n catalogs', () => {
  it('have identical key sets', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(fa).sort());
  });

  it('resolve a key per locale', () => {
    expect(t('app.shell.title', 'fa')).toBe('صندوق کار');
    expect(t('app.shell.title', 'en')).toBe('Inbox');
  });
});
