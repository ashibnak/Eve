/**
 * Writes golden files for document template versions that do not have one yet:
 *   pnpm documents:golden
 * Never overwrites. A published version's golden file is permanent; if its output must change,
 * publish a new template version instead.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PUBLISHED_DOCUMENT_TEMPLATES } from '../src/documents.catalog';
import { templateKey } from '../src/platform/documents/template';

const dir = join(__dirname, '..', 'documents-golden');
let written = 0;
for (const template of PUBLISHED_DOCUMENT_TEMPLATES) {
  const file = join(dir, `${templateKey(template)}.json`);
  if (existsSync(file)) continue;
  const golden = {
    template: { id: template.id, version: template.version },
    fingerprint: template.fingerprint,
  };
  writeFileSync(file, `${JSON.stringify(golden, null, 2)}\n`);
  console.log(`wrote ${templateKey(template)}`);
  written += 1;
}
console.log(written === 0 ? 'golden files are up to date' : `${written} golden file(s) written`);
