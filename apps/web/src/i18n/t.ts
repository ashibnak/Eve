import en from './en.json';
import fa from './fa.json';

/** Every UI string is a key in fa.json (the source locale); en.json must hold the same keys. */
export type MessageKey = keyof typeof fa;
export type Locale = 'fa' | 'en';

const catalogs: Record<Locale, Record<MessageKey, string>> = { fa, en };

/** Locale metadata used on the document root (ADR-010: RTL and LTR both supported). */
export const localeInfo: Record<Locale, { dir: 'rtl' | 'ltr' }> = {
  fa: { dir: 'rtl' },
  en: { dir: 'ltr' },
};

// R1 ships Persian only; locale selection arrives with user settings.
export const currentLocale: Locale = 'fa';

export function t(key: MessageKey, locale: Locale = currentLocale): string {
  return catalogs[locale][key];
}
