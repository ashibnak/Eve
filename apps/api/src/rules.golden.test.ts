import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { describe, expect, it } from 'vitest';
import { runCases } from './platform/rules/rule-registry';
import { ruleKey } from './platform/rules/rule-template';
import { PUBLISHED_RULE_TEMPLATES } from './rules.catalog';

const dir = join(__dirname, '..', 'rules-golden');

interface Golden {
  rule: { id: string; version: number };
  cases: { name: string; input: unknown; params: unknown; output: unknown }[];
}

const goldens = new Map<string, Golden>(
  readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => [
      f.replace(/\.json$/, ''),
      JSON.parse(readFileSync(join(dir, f), 'utf8')) as Golden,
    ]),
);

describe('published rule templates never change (ADR-005 replay)', () => {
  it.each(PUBLISHED_RULE_TEMPLATES.map((t) => [ruleKey(t), t] as const))(
    '%s reproduces its golden results',
    (key, template) => {
      const golden = goldens.get(key);
      if (!golden)
        throw new Error(`${key} has no golden file; run "pnpm rules:golden" and commit it`);
      for (const recorded of golden.cases) {
        const output = template.output.parse(
          template.evaluate(
            template.input.parse(recorded.input),
            template.params.parse(recorded.params),
          ),
        );
        expect(isDeepStrictEqual(output, recorded.output), `${key} case "${recorded.name}"`).toBe(
          true,
        );
      }
      // Its own shipped cases must still pass as well.
      expect(() => runCases(template)).not.toThrow();
    },
  );

  it('keeps every published version: no golden file without its template', () => {
    const published = new Set(PUBLISHED_RULE_TEMPLATES.map(ruleKey));
    expect([...goldens.keys()].filter((key) => !published.has(key))).toEqual([]);
  });
});
