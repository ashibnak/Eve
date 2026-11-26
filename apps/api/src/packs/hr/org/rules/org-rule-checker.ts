import { Injectable } from '@nestjs/common';
import type { platformV1 } from '@eve/contracts';
import { RuleRuntime } from '../../../../platform/rules/rule-runtime';
import type { Violation, Violations } from './common';
import { BackdatedChangeV1 } from './position.templates';
import { BLOCKING_STRUCTURE_RULES, type OrgSnapshot } from './index';

export interface BlockingResult {
  ok: boolean;
  violations: (Violation & { code: string })[];
  /** What each rule was evaluated with, for the decision record of the write (ADR-005). */
  records: platformV1.RuleEvaluationRecord[];
}

/**
 * The write-time check (spec §5 "blocking"): a write path (import S7, change request S8,
 * `apply_assignment`) builds the structure it would create and refuses it when R1, R2, R3 or R15
 * fails. R4 is checked on the change itself. Nothing is written here.
 */
@Injectable()
export class OrgRuleChecker {
  constructor(private readonly runtime: RuleRuntime) {}

  async checkBlocking(snapshot: OrgSnapshot, codes?: readonly string[]): Promise<BlockingResult> {
    const records: platformV1.RuleEvaluationRecord[] = [];
    const violations: BlockingResult['violations'] = [];
    for (const rule of BLOCKING_STRUCTURE_RULES.filter((r) => !codes || codes.includes(r.code))) {
      const record = await this.runtime.evaluate(
        { id: rule.template.id, version: rule.template.version },
        rule.input(snapshot),
        { asOf: snapshot.asOf as platformV1.BusinessDate, companyId: snapshot.companyId },
      );
      records.push(record);
      for (const v of (record.output as Violations).violations)
        violations.push({ ...v, code: rule.code });
    }
    return { ok: violations.length === 0, violations, records };
  }

  /**
   * The blocking violations a write would introduce: those in `after` that `before` did not have.
   * A problem already in the data (it has its own finding) does not stop an unrelated change.
   */
  async checkChange(
    before: OrgSnapshot,
    after: OrgSnapshot,
    codes?: readonly string[],
  ): Promise<BlockingResult> {
    const [was, will] = await Promise.all([
      this.checkBlocking(before, codes),
      this.checkBlocking(after, codes),
    ]);
    const key = (v: BlockingResult['violations'][number]) =>
      `${v.code}|${v.subject.type}|${v.subject.id}|${v.key}`;
    const existing = new Set(was.violations.map(key));
    const introduced = will.violations.filter((v) => !existing.has(key(v)));
    return { ok: introduced.length === 0, violations: introduced, records: will.records };
  }

  /** R4: a change effective more than the allowed days in the past needs a special approval. */
  async checkBackdated(change: {
    companyId: string;
    changeId: string;
    effectiveDate: platformV1.BusinessDate;
    today: platformV1.BusinessDate;
  }): Promise<BlockingResult> {
    const record = await this.runtime.evaluate(
      { id: BackdatedChangeV1.id, version: BackdatedChangeV1.version },
      { changeId: change.changeId, effectiveDate: change.effectiveDate, today: change.today },
      { asOf: change.today, companyId: change.companyId },
    );
    const violations = (record.output as Violations).violations.map((v) => ({ ...v, code: 'R4' }));
    return { ok: violations.length === 0, violations, records: [record] };
  }
}
