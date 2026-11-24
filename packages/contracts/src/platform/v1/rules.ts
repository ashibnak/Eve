import { z } from 'zod';
import type { BusinessDate, Instant } from './dates.js';

/** `<component-or-slug>.<name>`, e.g. `org.single_supervisor`. */
export const RuleIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, 'rule id must look like slug.name');

/** An exact rule template version, e.g. `org.single_supervisor@1` (ADR-005). */
export const RuleRefSchema = z.object({
  id: RuleIdSchema,
  version: z.number().int().min(1),
});
export type RuleRef = z.infer<typeof RuleRefSchema>;

export function formatRuleRef(ref: RuleRef): string {
  return `${ref.id}@${ref.version}`;
}

/**
 * Everything needed to explain and replay one rule evaluation: the exact template version, the
 * exact customer parameters and their version, the input and the output. Decision records embed
 * this; replay with the same template version and parameters must give the same output.
 */
export interface RuleEvaluationRecord {
  rule: RuleRef;
  /** The parameter version row used, or null when the template defaults applied. */
  paramVersionId: string | null;
  params: unknown;
  /** SHA-256 of the canonical JSON of `params`. */
  paramsHash: string;
  input: unknown;
  output: unknown;
  /** Business date the rule was evaluated for. */
  asOf: BusinessDate;
  companyId: string | null;
  /** System time whose knowledge was used (bitemporal parameters, ADR-009). */
  knownAt: Instant;
  evaluatedAt: Instant;
}
