import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { RuleRegistry } from './rule-registry';
import { defineRuleTemplate } from './rule-template';
import { SampleThresholdV1, SampleThresholdV2 } from './sample/sample-threshold.template';

describe('rule registry', () => {
  it('keeps versions side by side and knows the latest', () => {
    const registry = new RuleRegistry();
    registry.register(SampleThresholdV2, SampleThresholdV1);
    expect(registry.get('platform.sample_threshold', 1)).toBe(SampleThresholdV1);
    expect(registry.latest('platform.sample_threshold')).toBe(SampleThresholdV2);
    expect(registry.list().map((t) => t.version)).toEqual([1, 2]);
  });

  it('refuses a template whose own cases fail', () => {
    const broken = defineRuleTemplate({
      ...SampleThresholdV1,
      version: 3,
      evaluate: () => ({ exceeds: true }),
    });
    expect(() => new RuleRegistry().register(broken)).toThrow('case "at the threshold"');
  });

  it('refuses two different templates under one id and version', () => {
    const registry = new RuleRegistry();
    registry.register(SampleThresholdV1);
    const impostor = defineRuleTemplate({
      ...SampleThresholdV1,
      evaluate: SampleThresholdV1.evaluate,
    });
    expect(() => registry.register(impostor)).toThrow('already registered');
  });

  it('requires a positive and a negative case, valid defaults and a valid id', () => {
    const base = {
      id: 'test.rule',
      version: 1,
      description: { fa: 'آزمایش', en: 'test' },
      params: z.object({ n: z.number() }),
      input: z.object({}),
      output: z.boolean(),
      defaultParams: { n: 1 },
      evaluate: () => true,
      cases: [{ name: 'only one', input: {}, expect: true }],
    };
    expect(() => defineRuleTemplate(base)).toThrow('positive and a negative');
    const twoCases = [...base.cases, { name: 'two', input: {}, expect: true }];
    expect(() =>
      defineRuleTemplate({ ...base, cases: twoCases, defaultParams: { n: 'x' } as never }),
    ).toThrow();
    expect(() => defineRuleTemplate({ ...base, cases: twoCases, id: 'NoDots' })).toThrow();
  });
});
