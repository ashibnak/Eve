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

/** The message for `key`, with `{name}` placeholders filled from `params`. */
export function t(
  key: MessageKey,
  params: Record<string, string> = {},
  locale: Locale = currentLocale,
): string {
  return catalogs[locale][key].replace(
    /\{(\w+)\}/g,
    (match, name: string) => params[name] ?? match,
  );
}

/** Whether a key built at run time (e.g. from an API value) has a message. */
export function hasMessage(key: string): key is MessageKey {
  return key in fa;
}
