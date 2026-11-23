import en from './en.json';
import fa from './fa.json';

/**
 * Server-side texts (messages sent through channels, generated documents). Like the web app,
 * fa.json is the source catalog and en.json must hold the same keys (checked in CI).
 */
export type MessageKey = keyof typeof fa;
export type Locale = 'fa' | 'en';

const catalogs: Record<Locale, Record<MessageKey, string>> = { fa, en };

export function isMessageKey(key: string): key is MessageKey {
  return key in fa;
}

/** The message for `key` in `locale`, with `{name}` placeholders filled from `params`. */
export function renderMessage(
  key: MessageKey,
  params: Record<string, string>,
  locale: Locale,
): string {
  return catalogs[locale][key].replace(
    /\{(\w+)\}/g,
    (match, name: string) => params[name] ?? match,
  );
}
