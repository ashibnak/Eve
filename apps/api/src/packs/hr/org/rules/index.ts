import type { orgV1 } from '@eve/contracts';
import type { RuleTemplate } from '../../../../platform/rules/rule-template';
import { IncumbentInactiveV1, PersonTimeShareV1, SingleSupervisorV1 } from './assignment.templates';
import {
  BackdatedChangeV1,
  LongVacancyV1,
  ManagerialTitleV1,
  SpanOfControlV1,
  UnitOrProposalIdleV1,
} from './position.templates';
import {
  ManagerInUnitLineV1,
  MaxLayersV1,
  PositionSingleDirectLineV1,
  UnitSingleParentV1,
  UnitSupervisorChainV1,
} from './structure.templates';

/**
 * One company on one date, as the rules see it (built from the database by `snapshot.ts`, or by a
 * write path for the structure it is about to create). Closed units and positions are left out.
 */
export interface OrgSnapshot {
  companyId: string;
  asOf: string;
  units: { id: string; parentId: string | null; supervisorPositionId: string | null }[];
  positions: {
    id: string;
    unitId: string;
    titleFa: string;
    titleEn: string | null;
    supervisory: boolean;
    status: 'active' | 'frozen';
    /** Since when the position has been proposed (source `proposed`); null when official. */
    proposedSince: string | null;
    /** Since when it has had no primary assignment; null when it has one. */
    vacantSince: string | null;
    /** Has an employed primary incumbent. */
    filled: boolean;
  }[];
  directLines: { from: string; to: string }[];
  assignments: {
    personId: string;
    positionId: string;
    kind: orgV1.AssignmentKind;
    timeShare: number;
  }[];
  /** People of the company employed on `asOf`. */
  employed: string[];
}

/** An org rule: its template, its severity (spec §5) and the slice of a snapshot it reads. */
export interface OrgRule {
  code: string;
  template: RuleTemplate;
  severity: orgV1.Severity;
  /** Runs nightly on the whole structure (R4 checks changes only). */
  nightly: boolean;
  input(snapshot: OrgSnapshot): unknown;
}

const units = (s: OrgSnapshot) => s.units.map((u) => ({ id: u.id, parentId: u.parentId }));
const positionIds = (s: OrgSnapshot) => s.positions.map((p) => p.id);

export const ORG_RULES: readonly OrgRule[] = [
  {
    code: 'R1',
    template: UnitSingleParentV1,
    severity: 'blocking',
    nightly: true,
    input: (s) => ({ units: units(s) }),
  },
  {
    code: 'R2',
    template: PositionSingleDirectLineV1,
    severity: 'blocking',
    nightly: true,
    input: (s) => ({ positions: positionIds(s), directLines: s.directLines }),
  },
  {
    code: 'R3',
    template: PersonTimeShareV1,
    severity: 'blocking',
    nightly: true,
    input: (s) => ({ assignments: s.assignments }),
  },
  {
    code: 'R15',
    template: SingleSupervisorV1,
    severity: 'blocking',
    nightly: true,
    input: (s) => ({
      positions: s.positions.map((p) => ({ id: p.id, supervisory: p.supervisory })),
      assignments: s.assignments.map(({ personId, positionId, kind }) => ({
        personId,
        positionId,
        kind,
      })),
    }),
  },
  {
    code: 'R4',
    template: BackdatedChangeV1,
    severity: 'blocking',
    nightly: false,
    input: () => {
      throw new Error('R4 checks a change, not a snapshot');
    },
  },
  {
    code: 'R5',
    template: ManagerInUnitLineV1,
    severity: 'warning',
    nightly: true,
    input: (s) => ({
      units: units(s),
      positions: s.positions.map((p) => ({ id: p.id, unitId: p.unitId })),
      directLines: s.directLines,
    }),
  },
  {
    code: 'R6',
    template: UnitSupervisorChainV1,
    severity: 'warning',
    nightly: true,
    input: (s) => ({ units: s.units, directLines: s.directLines }),
  },
  {
    code: 'R7',
    template: IncumbentInactiveV1,
    severity: 'warning',
    nightly: true,
    input: (s) => ({
      assignments: s.assignments.map(({ personId, positionId, kind }) => ({
        personId,
        positionId,
        kind,
      })),
      employed: s.employed,
    }),
  },
  {
    code: 'R10',
    template: UnitOrProposalIdleV1,
    severity: 'warning',
    nightly: true,
    input: (s) => ({
      asOf: s.asOf,
      units: s.units.map((u) => u.id),
      positions: s.positions.map((p) => ({
        id: p.id,
        unitId: p.unitId,
        status: p.status,
        proposedSince: p.proposedSince,
      })),
    }),
  },
  {
    code: 'R11',
    template: ManagerialTitleV1,
    severity: 'warning',
    nightly: true,
    input: (s) => ({
      positions: s.positions.map((p) => ({
        id: p.id,
        titleFa: p.titleFa,
        titleEn: p.titleEn,
        supervisory: p.supervisory,
      })),
      directLines: s.directLines,
    }),
  },
  {
    code: 'R12',
    template: LongVacancyV1,
    severity: 'info',
    nightly: true,
    input: (s) => ({
      asOf: s.asOf,
      positions: s.positions.map((p) => ({ id: p.id, vacantSince: p.vacantSince })),
    }),
  },
  {
    code: 'R13',
    template: SpanOfControlV1,
    severity: 'info',
    nightly: true,
    input: (s) => ({
      positions: s.positions.map((p) => ({
        id: p.id,
        supervisory: p.supervisory,
        filled: p.filled,
      })),
      directLines: s.directLines,
    }),
  },
  {
    code: 'R14',
    template: MaxLayersV1,
    severity: 'info',
    nightly: true,
    input: (s) => ({
      companyId: s.companyId,
      positions: positionIds(s),
      directLines: s.directLines,
    }),
  },
];

/** The rules that refuse a write (spec §5 "blocking"), checked on the structure a write would create. */
export const BLOCKING_STRUCTURE_RULES = ORG_RULES.filter(
  (r) => r.severity === 'blocking' && r.nightly,
);

/** Every org template version ever published (for the rule catalog and golden files). */
export const ORG_RULE_TEMPLATES: readonly RuleTemplate[] = ORG_RULES.map((r) => r.template);
