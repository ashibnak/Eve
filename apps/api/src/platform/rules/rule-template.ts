import { platformV1 } from '@eve/contracts';
import type { z } from 'zod';

/** One worked example: shipped with the template, run at registration and kept as golden output. */
export interface RuleCase<
  TParams extends z.ZodType,
  TInput extends z.ZodType,
  TOutput extends z.ZodType,
> {
  name: string;
  input: z.input<TInput>;
  /** Omitted: the template defaults. */
  params?: z.input<TParams>;
  expect: z.output<TOutput>;
}

/**
 * A rule template (ADR-005): code with its own id and version. Customers change only its
 * parameters, never its logic. A published version is immutable; fixing logic means a new version
 * alongside the old one, so every past decision can be replayed exactly.
 */
export interface RuleTemplate<
  TParams extends z.ZodType = z.ZodType,
  TInput extends z.ZodType = z.ZodType,
  TOutput extends z.ZodType = z.ZodType,
> {
  id: string;
  version: number;
  description: { fa: string; en: string };
  params: TParams;
  input: TInput;
  output: TOutput;
  defaultParams: z.output<TParams>;
  /** Pure and deterministic: no clock, no I/O. Everything it needs comes in as input or params. */
  evaluate(input: z.output<TInput>, params: z.output<TParams>): z.output<TOutput>;
  /** At least one case where the rule holds and one where it does not. */
  cases: readonly RuleCase<TParams, TInput, TOutput>[];
}

export function defineRuleTemplate<
  TParams extends z.ZodType,
  TInput extends z.ZodType,
  TOutput extends z.ZodType,
>(template: RuleTemplate<TParams, TInput, TOutput>): RuleTemplate<TParams, TInput, TOutput> {
  platformV1.RuleRefSchema.parse({ id: template.id, version: template.version });
  if (template.cases.length < 2) {
    throw new Error(`${ruleKey(template)} needs at least a positive and a negative case`);
  }
  template.params.parse(template.defaultParams);
  return template;
}

export function ruleKey(ref: { id: string; version: number }): string {
  return `${ref.id}@${ref.version}`;
}
