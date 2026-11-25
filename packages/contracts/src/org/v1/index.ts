import { z } from 'zod';
import { BusinessDateSchema } from '../../platform/v1/dates.js';

/**
 * `org` module contract, v1 (ADR-003): Module 1 spec §3/§7. Read services double as the agent
 * tools (`org_*`, ADR-015); the MCP server that serves them comes with the agent (R2). Within v1
 * only additive changes are allowed.
 */

export const AssignmentKindSchema = z.enum([
  'primary',
  'acting',
  'temporary_supervision',
  'project',
]);
export type AssignmentKind = z.infer<typeof AssignmentKindSchema>;

/** Reporting lines run between positions (spec §3). Dotted/project lines inform, never approve. */
export const LineKindSchema = z.enum(['direct', 'dotted', 'project']);
export type LineKind = z.infer<typeof LineKindSchema>;

/** Spec §3: approved (مصوب), project (پروژه‌ای), temporary (موقت). */
export const PositionTypeSchema = z.enum(['approved', 'project', 'temporary']);
/** Lifecycle; whether it is filled is derived from its incumbents. */
export const PositionStatusSchema = z.enum(['active', 'frozen', 'closed']);
export const PositionSourceSchema = z.enum(['official', 'proposed']);
export const UnitStatusSchema = z.enum(['active', 'closed']);

const Localized = z.object({ fa: z.string(), en: z.string().nullable() });

export const IncumbentSchema = z.object({
  personId: z.uuid(),
  kind: AssignmentKindSchema,
  timeShare: z.number(),
  /** Employed on the date asked (people status active/on_leave). */
  active: z.boolean(),
  /** Code and name only when the caller may read people (sensitivity: name is sensitive). */
  personnelCode: z.string().nullable(),
  name: z.object({ first: z.string(), last: z.string() }).nullable(),
});
export type Incumbent = z.infer<typeof IncumbentSchema>;

export const PositionViewSchema = z.object({
  id: z.uuid(),
  companyId: z.uuid(),
  code: z.string(),
  legacyCode: z.string().nullable(),
  title: Localized,
  unitId: z.uuid(),
  jobId: z.string().nullable(),
  type: PositionTypeSchema,
  fte: z.number(),
  supervisory: z.boolean(),
  status: PositionStatusSchema,
  source: PositionSourceSchema,
  occupancy: z.enum(['filled', 'vacant']),
  /** Position above in the direct line; null at the top. */
  reportsToPositionId: z.uuid().nullable(),
  incumbents: z.array(IncumbentSchema),
  asOf: BusinessDateSchema,
});
export type PositionView = z.infer<typeof PositionViewSchema>;

export const UnitViewSchema = z.object({
  id: z.uuid(),
  companyId: z.uuid(),
  code: z.string(),
  legacyCode: z.string().nullable(),
  name: Localized,
  levelId: z.uuid().nullable(),
  parentUnitId: z.uuid().nullable(),
  supervisorPositionId: z.uuid().nullable(),
  status: UnitStatusSchema,
});
export type UnitView = z.infer<typeof UnitViewSchema>;

/** How the effective manager was found (spec §3): primary incumbent or acting/temporary one. */
export const ManagerSchema = z.object({
  personId: z.uuid(),
  positionId: z.uuid(),
  via: z.enum(['primary', 'acting', 'temporary_supervision']),
  /** 1 = the position directly above; more when vacant positions were skipped. */
  levelsUp: z.number().int().min(1),
});
export type Manager = z.infer<typeof ManagerSchema>;

export const PersonPositionSchema = z.object({
  positionId: z.uuid(),
  kind: AssignmentKindSchema,
  timeShare: z.number(),
  validFrom: BusinessDateSchema,
});

export const TeamMemberSchema = z.object({
  positionId: z.uuid(),
  /** 1 = reports directly to the lead's position. */
  depth: z.number().int().min(1),
  incumbents: z.array(IncumbentSchema),
});

export const StructureSchema = z.object({
  companyId: z.uuid(),
  asOf: BusinessDateSchema,
  units: z.array(UnitViewSchema),
  positions: z.array(
    PositionViewSchema.omit({ incumbents: true }).extend({ incumbentCount: z.number().int() }),
  ),
});

export const StructureDiffSchema = z.object({
  from: BusinessDateSchema,
  to: BusinessDateSchema,
  units: z.object({
    added: z.array(z.uuid()),
    removed: z.array(z.uuid()),
    changed: z.array(z.uuid()),
  }),
  positions: z.object({
    added: z.array(z.uuid()),
    removed: z.array(z.uuid()),
    changed: z.array(z.uuid()),
  }),
  /** People whose primary position differs between the two dates. */
  moved: z.array(
    z.object({
      personId: z.uuid(),
      fromPositionId: z.uuid().nullable(),
      toPositionId: z.uuid().nullable(),
    }),
  ),
});

/** Spec §5: blocking refuses a write; warning stays open until fixed or accepted; info is reported. */
export const SeveritySchema = z.enum(['blocking', 'warning', 'info']);
export type Severity = z.infer<typeof SeveritySchema>;

export const FindingStatusSchema = z.enum(['open', 'resolved', 'accepted']);
export type FindingStatus = z.infer<typeof FindingStatusSchema>;

export const FindingSubjectSchema = z.object({
  type: z.enum(['company', 'unit', 'position', 'person']),
  id: z.uuid(),
});

/** One finding of a rule on one subject (added in S6). */
export const FindingViewSchema = z.object({
  id: z.uuid(),
  companyId: z.uuid(),
  /** Spec code, e.g. R5. */
  code: z.string(),
  rule: z.object({ id: z.string(), version: z.number().int() }),
  paramVersionId: z.uuid().nullable(),
  severity: SeveritySchema,
  subject: FindingSubjectSchema,
  key: z.string(),
  detail: z.record(z.string(), z.unknown()),
  status: FindingStatusSchema,
  firstSeenAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
  resolvedAt: z.iso.datetime().nullable(),
  accepted: z.object({ by: z.string(), at: z.iso.datetime(), reason: z.string() }).nullable(),
});
export type FindingView = z.infer<typeof FindingViewSchema>;

/** One run of the rules over a company on a date (nightly or on request). */
export const RuleRunViewSchema = z.object({
  id: z.uuid(),
  companyId: z.uuid(),
  asOf: BusinessDateSchema,
  trigger: z.enum(['nightly', 'manual']),
  rules: z.array(
    z.object({
      code: z.string(),
      rule: z.object({ id: z.string(), version: z.number().int() }),
      paramVersionId: z.uuid().nullable(),
      paramsHash: z.string(),
      violations: z.number().int(),
    }),
  ),
  opened: z.number().int(),
  resolved: z.number().int(),
  stillOpen: z.number().int(),
  accepted: z.number().int(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
});
export type RuleRunView = z.infer<typeof RuleRunViewSchema>;

const AsOf = { asOf: BusinessDateSchema.optional() };

/** One read service = one agent tool: name, description, input and output (spec §7). */
export interface ToolDefinition<TInput extends z.ZodType, TOutput extends z.ZodType> {
  name: string;
  description: { fa: string; en: string };
  input: TInput;
  output: TOutput;
}

function tool<TInput extends z.ZodType, TOutput extends z.ZodType>(
  t: ToolDefinition<TInput, TOutput>,
) {
  return t;
}

export const OrgTools = {
  getPosition: tool({
    name: 'org_get_position',
    description: {
      fa: 'واحد، شغل، متصدی‌ها و پست بالادستِ یک پست',
      en: 'Unit, job, incumbents and the position above of one position',
    },
    input: z.object({ positionId: z.uuid(), ...AsOf }),
    output: PositionViewSchema,
  }),
  getPersonPosition: tool({
    name: 'org_get_person_position',
    description: {
      fa: 'پست(های) فعلی یک فرد و نوع انتساب',
      en: "A person's current position(s) and assignment kind",
    },
    input: z.object({ personId: z.uuid(), ...AsOf }),
    output: z.array(PersonPositionSchema),
  }),
  getManager: tool({
    name: 'org_get_manager',
    description: {
      fa: 'مدیر مستقیم مؤثر یک فرد (اصلی، کفالت، یا بالاتر)',
      en: "A person's effective direct manager (primary, acting, or further up)",
    },
    input: z.object({ personId: z.uuid(), ...AsOf }),
    output: ManagerSchema.nullable(),
  }),
  getApprovalChain: tool({
    name: 'org_get_approval_chain',
    description: {
      fa: 'n سطح مدیر بالادست در خط مستقیم',
      en: 'n levels of managers up the direct line',
    },
    input: z.object({ personId: z.uuid(), levels: z.number().int().min(1).max(20), ...AsOf }),
    output: z.array(ManagerSchema),
  }),
  getInformed: tool({
    name: 'org_get_informed',
    description: {
      fa: 'مدیران خط نقطه‌چین که فقط باخبر می‌شوند',
      en: 'Dotted-line managers who are only informed',
    },
    input: z.object({ personId: z.uuid(), ...AsOf }),
    output: z.array(ManagerSchema.omit({ levelsUp: true })),
  }),
  getTeam: tool({
    name: 'org_get_team',
    description: {
      fa: 'زیردست‌های مستقیم یا کل زیردرخت یک پست',
      en: 'Direct reports or the whole subtree of a position',
    },
    input: z.object({ positionId: z.uuid(), depth: z.enum(['direct', 'subtree']), ...AsOf }),
    output: z.array(TeamMemberSchema),
  }),
  getStructure: tool({
    name: 'org_get_structure',
    description: {
      fa: 'درخت واحدها و پست‌های یک شرکت در یک تاریخ',
      en: "A company's tree of units and positions on a date",
    },
    input: z.object({ companyId: z.uuid(), ...AsOf }),
    output: StructureSchema,
  }),
  diffStructure: tool({
    name: 'org_diff_structure',
    description: {
      fa: 'تفاوت ساختار میان دو تاریخ',
      en: 'Differences in the structure between two dates',
    },
    input: z.object({ companyId: z.uuid(), from: BusinessDateSchema, to: BusinessDateSchema }),
    output: StructureDiffSchema,
  }),
  listFindings: tool({
    name: 'org_list_findings',
    description: {
      fa: 'هشدارهای کنترل تناقض یک شرکت',
      en: "A company's consistency findings",
    },
    input: z.object({
      companyId: z.uuid(),
      status: FindingStatusSchema.optional(),
      severity: SeveritySchema.optional(),
      code: z.string().optional(),
      limit: z.number().int().min(1).max(5000).optional(),
    }),
    output: z.array(FindingViewSchema),
  }),
} as const;

/** Input of a tool, e.g. `OrgToolInput<'getManager'>`. */
export type OrgToolInput<K extends keyof typeof OrgTools> = z.infer<(typeof OrgTools)[K]['input']>;
export type PersonPosition = z.infer<typeof PersonPositionSchema>;
export type TeamMember = z.infer<typeof TeamMemberSchema>;
export type Structure = z.infer<typeof StructureSchema>;
export type StructureDiff = z.infer<typeof StructureDiffSchema>;

/** The org service other modules call through their own port (ADR-004). */
export interface OrgReadService {
  getPosition(input: z.infer<typeof OrgTools.getPosition.input>): Promise<PositionView | null>;
  getPersonPosition(
    input: z.infer<typeof OrgTools.getPersonPosition.input>,
  ): Promise<z.infer<typeof PersonPositionSchema>[]>;
  getManager(input: z.infer<typeof OrgTools.getManager.input>): Promise<Manager | null>;
  getApprovalChain(input: z.infer<typeof OrgTools.getApprovalChain.input>): Promise<Manager[]>;
  getInformed(
    input: z.infer<typeof OrgTools.getInformed.input>,
  ): Promise<Omit<Manager, 'levelsUp'>[]>;
  getTeam(
    input: z.infer<typeof OrgTools.getTeam.input>,
  ): Promise<z.infer<typeof TeamMemberSchema>[]>;
  getStructure(
    input: z.infer<typeof OrgTools.getStructure.input>,
  ): Promise<z.infer<typeof StructureSchema>>;
  diffStructure(
    input: z.infer<typeof OrgTools.diffStructure.input>,
  ): Promise<z.infer<typeof StructureDiffSchema>>;
}

/** For people's team-lead reads (decision 2026-11-25): ids of the people a person leads. */
export interface OrgTeamService {
  teamMembersLedBy(
    companyId: string,
    leadPersonId: string,
    asOf: z.infer<typeof BusinessDateSchema>,
  ): Promise<ReadonlySet<string>>;
}

/** Field sensitivity for the model gateway (rule 13): incumbent names are sensitive. */
export const ORG_FIELD_SENSITIVITY = {
  positionTitle: 'internal',
  unitName: 'internal',
  incumbentName: 'sensitive',
  incumbentPersonnelCode: 'internal',
} as const;
