import { z } from 'zod';
import { defineRuleTemplate } from '../rule-template';

/**
 * Test-only sample template for the engine itself (S2 done-when): v1 and v2 differ only at the
 * boundary (`>` vs `>=`), so replaying with v1 visibly gives the old result. Not shipped to users.
 * Tests that change its parameters register their own copy under their own id, so test files
 * sharing a database never see each other's parameters.
 */
const params = z.object({ threshold: z.number().int().min(0) });
const input = z.object({ value: z.number().int() });
const output = z.object({ exceeds: z.boolean() });

export function sampleThresholdTemplates(id = 'platform.sample_threshold') {
  const v1 = defineRuleTemplate({
    id,
    version: 1,
    description: {
      fa: 'نمونهٔ آزمایشی: مقدار از آستانه بیشتر است.',
      en: 'Test sample: the value is above the threshold.',
    },
    params,
    input,
    output,
    defaultParams: { threshold: 10 },
    evaluate: ({ value }, { threshold }) => ({ exceeds: value > threshold }),
    cases: [
      { name: 'above', input: { value: 11 }, expect: { exceeds: true } },
      { name: 'at the threshold', input: { value: 10 }, expect: { exceeds: false } },
      {
        name: 'custom threshold',
        input: { value: 4 },
        params: { threshold: 3 },
        expect: { exceeds: true },
      },
    ],
  });

  const v2 = defineRuleTemplate({
    id,
    version: 2,
    description: {
      fa: 'نمونهٔ آزمایشی: مقدار به آستانه رسیده یا از آن بیشتر است.',
      en: 'Test sample: the value has reached or passed the threshold.',
    },
    params,
    input,
    output,
    defaultParams: { threshold: 10 },
    evaluate: ({ value }, { threshold }) => ({ exceeds: value >= threshold }),
    cases: [
      { name: 'at the threshold', input: { value: 10 }, expect: { exceeds: true } },
      { name: 'below', input: { value: 9 }, expect: { exceeds: false } },
    ],
  });

  return [v1, v2] as const;
}

export const [SampleThresholdV1, SampleThresholdV2] = sampleThresholdTemplates();
