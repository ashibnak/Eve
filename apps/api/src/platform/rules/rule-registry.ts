import { isDeepStrictEqual } from 'node:util';
import { Injectable } from '@nestjs/common';
import { canonicalJson } from '../audit/canonical-json';
import { type RuleTemplate, ruleKey } from './rule-template';

export interface CaseResult {
  name: string;
  input: unknown;
  params: unknown;
  output: unknown;
}

/** Runs a template's own cases; returns their results or throws on the first mismatch. */
export function runCases(template: RuleTemplate): CaseResult[] {
  return template.cases.map((c) => {
    const input = template.input.parse(c.input);
    const params = template.params.parse(c.params ?? template.defaultParams);
    const output = template.output.parse(template.evaluate(input, params));
    if (!isDeepStrictEqual(output, c.expect)) {
      throw new Error(
        `${ruleKey(template)} case "${c.name}": expected ${canonicalJson(c.expect)}, got ${canonicalJson(output)}`,
      );
    }
    return { name: c.name, input, params, output };
  });
}

/**
 * All rule template versions the application knows. Versions of one id live side by side; old
 * versions stay registered so decisions made with them can be replayed (ADR-005).
 */
@Injectable()
export class RuleRegistry {
  private readonly templates = new Map<string, Map<number, RuleTemplate>>();

  /** Registers templates; their own cases must pass, or the application refuses to start. */
  register(...templates: RuleTemplate[]): void {
    for (const template of templates) {
      const versions = this.templates.get(template.id) ?? new Map<number, RuleTemplate>();
      const existing = versions.get(template.version);
      if (existing && existing !== template)
        throw new Error(`${ruleKey(template)} is already registered`);
      runCases(template);
      versions.set(template.version, template);
      this.templates.set(template.id, versions);
    }
  }

  get(id: string, version: number): RuleTemplate {
    const template = this.templates.get(id)?.get(version);
    if (!template) throw new Error(`Rule ${id}@${version} is not registered`);
    return template;
  }

  latest(id: string): RuleTemplate {
    const versions = this.templates.get(id);
    if (!versions || versions.size === 0) throw new Error(`Rule ${id} is not registered`);
    const newest = Math.max(...versions.keys());
    return versions.get(newest) as RuleTemplate;
  }

  list(): RuleTemplate[] {
    return [...this.templates.values()].flatMap((versions) =>
      [...versions.values()].sort((a, b) => a.version - b.version),
    );
  }
}
