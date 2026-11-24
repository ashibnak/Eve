/**
 * Writes golden files for rule template versions that do not have one yet:
 *   pnpm rules:golden
 * Never overwrites. A published version's golden file is permanent; if its output must change,
 * publish a new template version instead (ADR-005).
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCases } from '../src/platform/rules/rule-registry';
import { ruleKey } from '../src/platform/rules/rule-template';
import { PUBLISHED_RULE_TEMPLATES } from '../src/rules.catalog';

const dir = join(__dirname, '..', 'rules-golden');
let written = 0;
for (const template of PUBLISHED_RULE_TEMPLATES) {
  const file = join(dir, `${ruleKey(template)}.json`);
  if (existsSync(file)) continue;
  const golden = {
    rule: { id: template.id, version: template.version },
    cases: runCases(template),
  };
  writeFileSync(file, `${JSON.stringify(golden, null, 2)}\n`);
  console.log(`wrote ${ruleKey(template)}`);
  written += 1;
}
console.log(written === 0 ? 'golden files are up to date' : `${written} golden file(s) written`);
