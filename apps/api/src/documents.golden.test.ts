import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PUBLISHED_DOCUMENT_TEMPLATES } from './documents.catalog';
import { templateKey } from './platform/documents/template';

const dir = join(__dirname, '..', 'documents-golden');

interface Golden {
  template: { id: string; version: number };
  fingerprint: string;
}

const goldens = new Map<string, Golden>(
  readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => [
      f.replace(/\.json$/, ''),
      JSON.parse(readFileSync(join(dir, f), 'utf8')) as Golden,
    ]),
);

describe('published document templates never change', () => {
  it.each(PUBLISHED_DOCUMENT_TEMPLATES.map((t) => [templateKey(t), t] as const))(
    '%s matches its golden fingerprint',
    (key, template) => {
      const golden = goldens.get(key);
      if (!golden)
        throw new Error(`${key} has no golden file; run "pnpm documents:golden" and commit it`);
      expect(template.fingerprint, `${key} changed; publish version ${template.version + 1}`).toBe(
        golden.fingerprint,
      );
    },
  );

  it('every golden file belongs to a published template', () => {
    const published = new Set(PUBLISHED_DOCUMENT_TEMPLATES.map(templateKey));
    expect([...goldens.keys()].filter((k) => !published.has(k))).toEqual([]);
  });
});
