/**
 * CI check: in every catalog directory, each locale file must hold exactly the keys of fa.json
 * (the source locale) and no empty values.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const CATALOG_DIRS = ['apps/web/src/i18n', 'apps/api/src/platform/i18n'];

function load(dir: string, file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, dir, file), 'utf8')) as Record<string, unknown>;
}

export function compareCatalogs(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
): { missing: string[]; extra: string[]; empty: string[] } {
  const sourceKeys = new Set(Object.keys(source));
  const targetKeys = new Set(Object.keys(target));
  return {
    missing: [...sourceKeys].filter((k) => !targetKeys.has(k)),
    extra: [...targetKeys].filter((k) => !sourceKeys.has(k)),
    empty: Object.entries(target)
      .filter(([, v]) => typeof v !== 'string' || v.trim() === '')
      .map(([k]) => k),
  };
}

function main(): void {
  let failed = false;
  for (const dir of CATALOG_DIRS) {
    const source = load(dir, 'fa.json');
    for (const file of readdirSync(join(root, dir)).filter((f) => f.endsWith('.json'))) {
      const { missing, extra, empty } = compareCatalogs(source, load(dir, file));
      for (const [label, keys] of [
        ['missing', missing],
        ['not in fa.json', extra],
        ['empty', empty],
      ] as const) {
        if (keys.length > 0) {
          failed = true;
          console.error(`${dir}/${file}: ${label}: ${keys.join(', ')}`);
        }
      }
    }
  }
  if (failed) process.exit(1);
  console.log(`i18n catalogs in sync (${CATALOG_DIRS.join(', ')})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
