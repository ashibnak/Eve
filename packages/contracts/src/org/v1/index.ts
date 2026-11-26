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
      /** Findings on one unit, position or person (S9 position card). */
      subjectId: z.uuid().optional(),
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

// ── Writes (S7/S8) ───────────────────────────────────────────────────────────

/** A company's org profile, registered by the system administrator before the first import. */
export const OrgProfileInputSchema = z.object({
  nameFa: z.string().trim().min(1).max(200),
  nameEn: z.string().trim().min(1).max(200).nullable().optional(),
  /** Prefix of the system codes, e.g. FNP → FNP-U0001; fixed once codes exist. */
  codePrefix: z.string().regex(/^[A-Z0-9]{2,10}$/),
  /** Validated with the company's jurisdiction pack (ADR-010), e.g. national ID for `ir`. */
  legalFields: z.record(z.string(), z.unknown()),
});
export type OrgProfileInput = z.infer<typeof OrgProfileInputSchema>;

export const UnitLevelSchema = z.object({
  id: z.uuid(),
  nameFa: z.string(),
  nameEn: z.string().nullable(),
  rank: z.number().int().min(1),
});

/** The company's ordered unit levels: existing ones by id (renamed or moved), new ones without. */
export const UnitLevelsInputSchema = z
  .array(
    z.object({
      id: z.uuid().optional(),
      nameFa: z.string().trim().min(1).max(100),
      nameEn: z.string().trim().min(1).max(100).nullable().optional(),
    }),
  )
  .min(1)
  .max(20);

/** Event `org.position.created@1`: module 2 opens a grading request (D1). */
export const PositionCreatedPayload = z.object({
  position_id: z.uuid(),
  code: z.string(),
  unit_id: z.uuid(),
  job_id: z.string().nullable(),
  supervisory: z.boolean(),
});

/** Event `org.position.changed@1`: only a change of unit or job (spec §7). */
export const PositionChangedPayload = z.object({
  position_id: z.uuid(),
  changed: z.array(z.enum(['unit', 'job'])).min(1),
  unit_from: z.uuid(),
  unit_to: z.uuid(),
  job_from: z.string().nullable(),
  job_to: z.string().nullable(),
});

/**
 * Event `org.assignment.started@1`. No module opens a pay decision or an order from it: that is
 * the personnel-action workflow's job (ADR-006, ADR-007).
 */
export const AssignmentStartedPayload = z.object({
  assignment_id: z.uuid(),
  person_id: z.uuid(),
  position_id: z.uuid(),
  kind: AssignmentKindSchema,
  time_share: z.number(),
  /** Personnel action, change request or import that made it. */
  action_ref: z.string().nullable(),
});

/** Event `org.assignment.ended@1`: the position may now be vacant. */
export const AssignmentEndedPayload = z.object({
  assignment_id: z.uuid(),
  person_id: z.uuid(),
  position_id: z.uuid(),
  kind: AssignmentKindSchema,
  action_ref: z.string().nullable(),
});

/** Event `org.manager.changed@1`: module 50 hands pending approvals to the new manager. */
export const ManagerChangedPayload = z.object({
  person_id: z.uuid(),
  from_manager_person_id: z.uuid().nullable(),
  to_manager_person_id: z.uuid().nullable(),
});

/** A unit or position in a change request: an existing one by id, or one the bundle creates. */
export const UnitRefSchema = z.union([
  z.object({ id: z.uuid() }),
  z.object({ ref: z.string().min(1).max(50) }),
]);
export const PositionRefSchema = UnitRefSchema;
export type EntityRef = z.infer<typeof UnitRefSchema>;

const Text = z.string().trim().min(1).max(200);

/** One operation of a structure change request (spec §8: units, positions, reporting lines). */
export const ChangeOperationSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('unit.create'),
    ref: z.string().min(1).max(50),
    nameFa: Text,
    nameEn: Text.nullable().optional(),
    levelId: z.uuid(),
    parent: UnitRefSchema,
    supervisor: PositionRefSchema.nullable().optional(),
    legacyCode: Text.nullable().optional(),
    costCenter: Text.nullable().optional(),
    location: Text.nullable().optional(),
  }),
  z.object({
    op: z.literal('unit.update'),
    unitId: z.uuid(),
    changes: z
      .object({
        nameFa: Text,
        nameEn: Text.nullable(),
        levelId: z.uuid(),
        /** A move: the unit and everything below it go under another unit. */
        parent: UnitRefSchema,
        supervisor: PositionRefSchema.nullable(),
        costCenter: Text.nullable(),
        location: Text.nullable(),
      })
      .partial()
      .strict()
      .refine((c) => Object.keys(c).length > 0, 'Nothing to change'),
  }),
  z.object({ op: z.literal('unit.close'), unitId: z.uuid() }),
  z.object({
    op: z.literal('position.create'),
    ref: z.string().min(1).max(50),
    titleFa: Text,
    titleEn: Text.nullable().optional(),
    unit: UnitRefSchema,
    type: PositionTypeSchema,
    fte: z.number().positive().max(1),
    supervisory: z.boolean(),
    reportsTo: PositionRefSchema.nullable(),
    legacyCode: Text.nullable().optional(),
  }),
  z.object({
    op: z.literal('position.update'),
    positionId: z.uuid(),
    changes: z
      .object({
        titleFa: Text,
        titleEn: Text.nullable(),
        /** A move: the position (and its people) go to another unit. */
        unit: UnitRefSchema,
        type: PositionTypeSchema,
        fte: z.number().positive().max(1),
        supervisory: z.boolean(),
        status: z.enum(['active', 'frozen']),
        reportsTo: PositionRefSchema.nullable(),
      })
      .partial()
      .strict()
      .refine((c) => Object.keys(c).length > 0, 'Nothing to change'),
  }),
  z.object({ op: z.literal('position.close'), positionId: z.uuid() }),
]);
export type ChangeOperation = z.infer<typeof ChangeOperationSchema>;

export const ChangeRequestInputSchema = z.object({
  companyId: z.uuid(),
  effectiveDate: BusinessDateSchema,
  reason: z.string().trim().min(1).max(2000),
  operations: z.array(ChangeOperationSchema).min(1).max(500),
});
export type ChangeRequestInput = z.infer<typeof ChangeRequestInputSchema>;

/** What the approver sees before deciding (spec §8). */
export const ImpactSchema = z.object({
  /** People whose position moves to another unit: each needs an order (حکم). */
  movedPeople: z.array(
    z.object({
      personId: z.uuid(),
      positionId: z.uuid(),
      fromUnitId: z.uuid(),
      toUnit: z.string(),
    }),
  ),
  managerChanges: z.array(
    z.object({ personId: z.uuid(), from: z.uuid().nullable(), to: z.uuid().nullable() }),
  ),
  ordersNeeded: z.number().int(),
  /** Positions left without their incumbents (none: a filled position cannot be closed). */
  vacatedPositions: z.array(z.uuid()),
  warnings: z.object({
    opened: z.array(z.object({ code: z.string(), subject: z.string(), key: z.string() })),
    resolved: z.array(z.object({ code: z.string(), subject: z.string(), key: z.string() })),
  }),
  /** Grades come from jobs (Module 2); unknown until grading exists. */
  gradeChanges: z.literal('unknown_until_grading'),
});
export type Impact = z.infer<typeof ImpactSchema>;

export const ChangeRequestViewSchema = z.object({
  id: z.uuid(),
  companyId: z.uuid(),
  effectiveDate: BusinessDateSchema,
  reason: z.string(),
  operations: z.array(ChangeOperationSchema),
  impact: ImpactSchema,
  status: z.enum(['submitted', 'applied']),
  approvalRequestId: z.uuid(),
  requestedBy: z.string(),
  createdAt: z.iso.datetime(),
  appliedAt: z.iso.datetime().nullable(),
});
export type ChangeRequestView = z.infer<typeof ChangeRequestViewSchema>;

/** Event `org.change_request.approved@1`, published on the effective date (spec §7). */
export const ChangeRequestApprovedPayload = z.object({
  change_request_id: z.uuid(),
  effective_date: BusinessDateSchema,
  operations: z.number().int(),
});

/**
 * Command `apply_assignment` (spec §7, ADR-007): only the personnel-action workflow calls it, with
 * its action id and the id of its approved request. Replaying the same action id changes nothing.
 */
export const ApplyAssignmentCommandSchema = z.object({
  actionId: z.string().min(1).max(100),
  approvalId: z.uuid(),
  companyId: z.uuid(),
  operation: z.enum(['start', 'end']),
  personId: z.uuid(),
  positionId: z.uuid(),
  kind: AssignmentKindSchema,
  timeShare: z.number().positive().max(1).default(1),
  effectiveDate: BusinessDateSchema,
  orderNumber: z.string().min(1).max(50).nullable().optional(),
});
export type ApplyAssignmentCommand = z.input<typeof ApplyAssignmentCommandSchema>;

export const ApplyAssignmentResultSchema = z.object({
  assignmentId: z.uuid(),
  /** True when the action id was applied before: nothing was written again. */
  replayed: z.boolean(),
});
export type ApplyAssignmentResult = z.infer<typeof ApplyAssignmentResultSchema>;

/**
 * A data correction (spec §8): a wrong entry fixed in place for its version's whole period
 * (product-owner decision 2026-11-25). Descriptive fields only; structure goes through a change
 * request. `versionFrom` names the version: the date it starts.
 */
export const UnitCorrectionSchema = z.object({
  versionFrom: BusinessDateSchema,
  changes: z
    .object({
      legacyCode: Text.nullable(),
      nameFa: Text,
      nameEn: Text.nullable(),
      levelId: z.uuid(),
      costCenter: Text.nullable(),
      location: Text.nullable(),
      supervisorPositionId: z.uuid().nullable(),
    })
    .partial()
    .strict()
    .refine((c) => Object.keys(c).length > 0, 'Nothing to correct'),
  reason: z.string().trim().min(1).max(1000),
});

export const PositionCorrectionSchema = z.object({
  versionFrom: BusinessDateSchema,
  changes: z
    .object({
      legacyCode: Text.nullable(),
      titleFa: Text,
      titleEn: Text.nullable(),
      type: PositionTypeSchema,
      fte: z.number().positive().max(1),
      supervisory: z.boolean(),
    })
    .partial()
    .strict()
    .refine((c) => Object.keys(c).length > 0, 'Nothing to correct'),
  reason: z.string().trim().min(1).max(1000),
});

// ── Workspace reads for the web UI (S9) ───────────────────────────────────────

/** A company the caller may work in, and what they may do there (the UI shows only that). */
export const CompanyWorkspaceSchema = z.object({
  companyId: z.uuid(),
  nameFa: z.string(),
  nameEn: z.string().nullable(),
  codePrefix: z.string(),
  /** The caller's own person in the company (login link), for "my position" and team views. */
  myPersonId: z.uuid().nullable(),
  can: z.object({
    readStructure: z.boolean(),
    manageFindings: z.boolean(),
    importStructure: z.boolean(),
    requestChange: z.boolean(),
    correct: z.boolean(),
    approveChange: z.boolean(),
    manageCompany: z.boolean(),
  }),
});
export type CompanyWorkspace = z.infer<typeof CompanyWorkspaceSchema>;

/** A position's whole dated history (spec §9 position card). */
export const PositionHistorySchema = z.object({
  positionId: z.uuid(),
  code: z.string(),
  versions: z.array(
    z.object({
      validFrom: BusinessDateSchema,
      validTo: BusinessDateSchema.nullable(),
      legacyCode: z.string().nullable(),
      title: Localized,
      unitId: z.uuid(),
      unitName: z.string().nullable(),
      type: PositionTypeSchema,
      fte: z.number(),
      supervisory: z.boolean(),
      status: PositionStatusSchema,
      source: PositionSourceSchema,
    }),
  ),
  lines: z.array(
    z.object({
      kind: LineKindSchema,
      toPositionId: z.uuid(),
      toCode: z.string(),
      validFrom: BusinessDateSchema,
      validTo: BusinessDateSchema.nullable(),
    }),
  ),
  assignments: z.array(
    z.object({
      personId: z.uuid(),
      /** Only when the caller may read the person. */
      personnelCode: z.string().nullable(),
      name: z.object({ first: z.string(), last: z.string() }).nullable(),
      kind: AssignmentKindSchema,
      timeShare: z.number(),
      source: z.string(),
      orderNumber: z.string().nullable(),
      validFrom: BusinessDateSchema,
      validTo: BusinessDateSchema.nullable(),
    }),
  ),
});
export type PositionHistory = z.infer<typeof PositionHistorySchema>;
