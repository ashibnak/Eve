import { isDeepStrictEqual } from 'node:util';
import { Injectable } from '@nestjs/common';
import type { platformV1 } from '@eve/contracts';
import { canonicalJson, toCanonicalValue } from '../audit/canonical-json';
import { sha256Hex } from '../auth/crypto';
import { Clock } from '../context/clock';
import { ParamVersionsService } from './param-versions.service';
import { RuleRegistry } from './rule-registry';
import { ruleKey } from './rule-template';

export interface EvaluateOptions {
  /** Business date the rule is evaluated for. */
  asOf: platformV1.BusinessDate;
  companyId: string | null;
  /** Use the parameters as they were known at this moment (default: now). */
  knownAt?: Date;
}

export class RuleReplayMismatchError extends Error {
  constructor(
    readonly record: platformV1.RuleEvaluationRecord,
    readonly replayed: unknown,
  ) {
    super(
      `Replay of ${ruleKey(record.rule)} gave ${canonicalJson(replayed)} instead of ${canonicalJson(record.output)}`,
    );
  }
}

/**
 * Evaluates rules and records exactly what produced each result: template version, parameter
 * version and values, input and output (ADR-005). `replay` proves a record reproduces.
 */
@Injectable()
export class RuleRuntime {
  constructor(
    private readonly registry: RuleRegistry,
    private readonly params: ParamVersionsService,
    private readonly clock: Clock,
  ) {}

  /** Evaluates a rule; without `version` the latest registered version is used. */
  async evaluate(
    ref: { id: string; version?: number },
    input: unknown,
    options: EvaluateOptions,
  ): Promise<platformV1.RuleEvaluationRecord> {
    const template =
      ref.version === undefined
        ? this.registry.latest(ref.id)
        : this.registry.get(ref.id, ref.version);
    const knownAt = options.knownAt ?? this.clock.now();
    const resolved = await this.params.resolve(template, options.companyId, options.asOf, knownAt);
    const parsedInput = template.input.parse(input);
    const output = template.output.parse(template.evaluate(parsedInput, resolved.params));
    const params = toCanonicalValue(resolved.params);
    return {
      rule: { id: template.id, version: template.version },
      paramVersionId: resolved.paramVersionId,
      params,
      paramsHash: sha256Hex(canonicalJson(params)),
      input: toCanonicalValue(parsedInput),
      output: toCanonicalValue(output),
      asOf: options.asOf,
      companyId: options.companyId,
      knownAt: knownAt.toISOString() as platformV1.Instant,
      evaluatedAt: this.clock.now().toISOString() as platformV1.Instant,
    };
  }

  /**
   * Re-runs the recorded template version with the recorded parameters and input, with no database
   * lookup. Returns the output; throws if it differs from the record (or the record was altered).
   */
  replay(record: platformV1.RuleEvaluationRecord): unknown {
    if (sha256Hex(canonicalJson(record.params)) !== record.paramsHash) {
      throw new Error(`Parameters of the ${ruleKey(record.rule)} record do not match their hash`);
    }
    const template = this.registry.get(record.rule.id, record.rule.version);
    const output = toCanonicalValue(
      template.output.parse(
        template.evaluate(template.input.parse(record.input), template.params.parse(record.params)),
      ),
    );
    if (!isDeepStrictEqual(output, record.output))
      throw new RuleReplayMismatchError(record, output);
    return output;
  }
}
