import { ORG_RULE_TEMPLATES } from './packs/hr/org/rules/index';
import type { RuleTemplate } from './platform/rules/rule-template';
import {
  SampleThresholdV1,
  SampleThresholdV2,
} from './platform/rules/sample/sample-threshold.template';

/**
 * Every rule template version ever published, old versions included (ADR-005). Each must have a
 * committed golden file in `rules-golden/`; CI re-runs them so a published version can never
 * change behaviour. Packs add their templates here as they ship them.
 */
export const PUBLISHED_RULE_TEMPLATES: readonly RuleTemplate[] = [
  // Test-only sample that proves the mechanism; not registered in the running application.
  SampleThresholdV1,
  SampleThresholdV2,
  // org R1-R15 (S6).
  ...ORG_RULE_TEMPLATES,
];
