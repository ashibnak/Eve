import type { orgV1 } from '@eve/contracts';
import { dayOf } from '../model/period';

/** An org_finding row as Prisma returns it. */
export interface FindingRow {
  id: string;
  companyId: string;
  code: string;
  ruleId: string;
  ruleVersion: number;
  paramVersionId: string | null;
  severity: string;
  subjectType: string;
  subjectId: string;
  key: string;
  detail: unknown;
  status: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  resolvedAt: Date | null;
  acceptedBy: string | null;
  acceptedAt: Date | null;
  acceptedReason: string | null;
}

export function findingView(row: FindingRow): orgV1.FindingView {
  return {
    id: row.id,
    companyId: row.companyId,
    code: row.code,
    rule: { id: row.ruleId, version: row.ruleVersion },
    paramVersionId: row.paramVersionId,
    severity: row.severity as orgV1.Severity,
    subject: { type: row.subjectType as orgV1.FindingView['subject']['type'], id: row.subjectId },
    key: row.key,
    detail: row.detail as Record<string, unknown>,
    status: row.status as orgV1.FindingStatus,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    accepted:
      row.status === 'accepted' && row.acceptedBy && row.acceptedAt && row.acceptedReason
        ? { by: row.acceptedBy, at: row.acceptedAt.toISOString(), reason: row.acceptedReason }
        : null,
  };
}

/** An org_rule_run row as Prisma returns it. */
export interface RuleRunRow {
  id: string;
  companyId: string;
  asOf: Date;
  trigger: string;
  rules: unknown;
  opened: number;
  resolved: number;
  stillOpen: number;
  accepted: number;
  startedAt: Date;
  finishedAt: Date;
}

export function ruleRunView(row: RuleRunRow): orgV1.RuleRunView {
  return {
    id: row.id,
    companyId: row.companyId,
    asOf: dayOf(row.asOf),
    trigger: row.trigger as orgV1.RuleRunView['trigger'],
    rules: row.rules as orgV1.RuleRunView['rules'],
    opened: row.opened,
    resolved: row.resolved,
    stillOpen: row.stillOpen,
    accepted: row.accepted,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt.toISOString(),
  };
}
