import { describe, expect, it } from 'vitest';
import { runCases } from '../../../../platform/rules/rule-registry';
import type { RuleTemplate } from '../../../../platform/rules/rule-template';
import { PersonTimeShareV1 } from './assignment.templates';
import { nodesOnCycles, type Violations } from './common';
import { ORG_RULES } from './index';
import { ManagerialTitleV1, SpanOfControlV1 } from './position.templates';
import { MaxLayersV1, PositionSingleDirectLineV1, UnitSingleParentV1 } from './structure.templates';

function evaluate(template: RuleTemplate, input: unknown, params?: unknown): Violations {
  return template.output.parse(
    template.evaluate(
      template.input.parse(input),
      template.params.parse(params ?? template.defaultParams),
    ),
  ) as Violations;
}
const keys = (v: Violations) => v.violations.map((x) => `${x.subject.id}:${x.key}`);

describe('org rule templates (spec §5)', () => {
  it('ships R1-R7, R10-R15 with a positive and a negative case each, all passing', () => {
    expect(ORG_RULES.map((r) => r.code)).toEqual([
      'R1',
      'R2',
      'R3',
      'R15',
      'R4',
      'R5',
      'R6',
      'R7',
      'R10',
      'R11',
      'R12',
      'R13',
      'R14',
    ]);
    for (const rule of ORG_RULES) {
      const results = runCases(rule.template);
      expect(
        results.some((c) => (c.output as Violations).violations.length === 0),
        rule.code,
      ).toBe(true);
      expect(
        results.some((c) => (c.output as Violations).violations.length > 0),
        rule.code,
      ).toBe(true);
      expect(rule.template.id.startsWith('org.')).toBe(true);
    }
  });

  it('finds nodes on cycles, not the ones leading into them', () => {
    const parent = new Map<string, string | null>([
      ['a', null],
      ['b', 'c'],
      ['c', 'd'],
      ['d', 'b'],
      ['e', 'b'],
      ['f', 'f'],
    ]);
    expect([...nodesOnCycles(parent)].sort()).toEqual(['b', 'c', 'd', 'f']);
  });

  it('R1 flags every unit of a cycle even when there is no root at all', () => {
    expect(
      keys(
        evaluate(UnitSingleParentV1, {
          units: [
            { id: 'x', parentId: 'y' },
            { id: 'y', parentId: 'x' },
          ],
        }),
      ),
    ).toEqual(['x:cycle', 'y:cycle']);
  });

  it('R2 flags a line to a position outside the structure (e.g. closed)', () => {
    expect(
      keys(
        evaluate(PositionSingleDirectLineV1, {
          positions: ['p1', 'p2'],
          directLines: [{ from: 'p2', to: 'p9' }],
        }),
      ),
    ).toEqual(['p2:unknown_target']);
  });

  it('R3 counts primary and project shares only, in thousandths', () => {
    const a = (kind: string, timeShare: number) => ({
      personId: 'a',
      positionId: kind,
      kind,
      timeShare,
    });
    expect(
      evaluate(PersonTimeShareV1, {
        assignments: [a('primary', 1), a('acting', 1), a('temporary_supervision', 1)],
      }).violations,
    ).toEqual([]);
    expect(
      evaluate(PersonTimeShareV1, { assignments: [a('primary', 0.7), a('project', 0.3)] })
        .violations,
    ).toEqual([]);
    expect(
      keys(evaluate(PersonTimeShareV1, { assignments: [a('primary', 0.7), a('project', 0.301)] })),
    ).toEqual(['a:over_share']);
    // The customer parameter changes the limit.
    expect(
      evaluate(
        PersonTimeShareV1,
        { assignments: [a('primary', 1), a('project', 0.2)] },
        { maxShare: 1.2 },
      ).violations,
    ).toEqual([]);
  });

  it('R11 matches whole words in Persian and English titles, with the customer word list', () => {
    const position = (titleFa: string, titleEn: string | null = null) => ({
      id: 'p',
      titleFa,
      titleEn,
      supervisory: false,
    });
    const check = (p: ReturnType<typeof position>, words?: string[]) =>
      keys(
        evaluate(
          ManagerialTitleV1,
          { positions: [p], directLines: [] },
          words ? { words } : undefined,
        ),
      );
    expect(check(position('مدیرعامل'))).toEqual(['p:title_not_supervisory']);
    expect(check(position('معاون‌مالی'))).toEqual(['p:title_not_supervisory']);
    expect(check(position('رییس اداره'))).toEqual(['p:title_not_supervisory']);
    expect(check(position('کارشناس مدیریت پروژه'))).toEqual([]);
    expect(check(position('کارشناس', 'Senior Engineer, Head-of-Platform'))).toEqual([
      'p:title_not_supervisory',
    ]);
    expect(check(position('مسئول دفتر'))).toEqual([]);
    expect(check(position('مسئول دفتر'), ['مسئول'])).toEqual(['p:title_not_supervisory']);
  });

  it('R13 counts filled direct reports only and ignores supervisors with none', () => {
    const lines = Array.from({ length: 13 }, (_, i) => ({ from: `s${i}`, to: 'm' }));
    const staff = (filled: boolean) =>
      Array.from({ length: 13 }, (_, i) => ({ id: `s${i}`, supervisory: false, filled }));
    const input = (filled: boolean) => ({
      positions: [{ id: 'm', supervisory: true, filled: true }, ...staff(filled)],
      directLines: lines,
    });
    expect(keys(evaluate(SpanOfControlV1, input(true)))).toEqual(['m:too_many_reports']);
    expect(evaluate(SpanOfControlV1, input(false)).violations).toEqual([]);
    expect(
      evaluate(SpanOfControlV1, input(true), { minReports: 2, maxReports: 13 }).violations,
    ).toEqual([]);
    expect(() => SpanOfControlV1.params.parse({ minReports: 5, maxReports: 2 })).toThrow();
  });

  it('R14 measures layers from the top along direct lines, default 7', () => {
    const chain = Array.from({ length: 8 }, (_, i) => `p${i}`);
    const lines = chain.slice(1).map((p, i) => ({ from: p, to: chain[i]! }));
    expect(
      keys(evaluate(MaxLayersV1, { companyId: 'c', positions: chain, directLines: lines })),
    ).toEqual(['c:too_many_layers']);
    expect(
      evaluate(MaxLayersV1, {
        companyId: 'c',
        positions: chain.slice(0, 7),
        directLines: lines.slice(0, 6),
      }).violations,
    ).toEqual([]);
  });
});
