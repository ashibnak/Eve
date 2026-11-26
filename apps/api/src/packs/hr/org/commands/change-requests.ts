import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { orgV1, type platformV1 } from '@eve/contracts';
import { z } from 'zod';
import { ApprovalService } from '../../../../platform/approvals/approval.service';
import {
  type ApprovalContext,
  type ApprovalRequestType,
  defineApprovalRequestType,
} from '../../../../platform/approvals/request-types';
import { toCanonicalValue } from '../../../../platform/audit/canonical-json';
import { AuditService } from '../../../../platform/audit/audit.service';
import { Clock } from '../../../../platform/context/clock';
import { currentContext, withFlow } from '../../../../platform/context/request-context';
import { type Tx, TxRunner } from '../../../../platform/context/tx-runner';
import { RuleRuntime } from '../../../../platform/rules/rule-runtime';
import { AccessService } from '../../../../platform/scope/access.service';
import { ScopedDb } from '../../../../platform/scope/scoped-db';
import { ChangeRequestApproved } from '../events/org.events';
import { OrgEventSink } from '../events/org-event-sink';
import { loadCurrent } from '../import/structure-model';
import { dateOf, dayOf } from '../model/period';
import { OrgChangeApproverRole, OrgPermissions } from '../org.permissions';
import { PEOPLE_DIRECTORY_PORT, type PeopleDirectoryPort } from '../ports/people-directory.port';
import { daysBetween } from '../rules/common';
import { BLOCKING_STRUCTURE_RULES } from '../rules/index';
import { OrgRuleChecker } from '../rules/org-rule-checker';
import { buildSnapshot } from '../rules/snapshot';
import { planChange } from './change-plan';
import { computeImpact } from './impact';
import { StructureWriter } from './structure-writer';

export const CHANGE_REQUEST_TYPE = 'org.structure.change';
/** Spec §5 R4: more than this many days back needs the special approval. */
const BACKDATE_DAYS = 30;
/** The special approval of R4 (product-owner decision 2026-11-25). */
const BACKDATE_APPROVER = 'system_admin';

const Payload = z.object({
  changeRequestId: z.uuid(),
  effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  operations: z.array(orgV1.ChangeOperationSchema).min(1),
});
type Payload = z.output<typeof Payload>;

/**
 * Structure change requests (spec §8, F8): a bundle of operations with an effective date, checked
 * against R1-R15 on the structure it would create, with an impact analysis, approved through the
 * platform approvals (chain `org_change_approver` by default, plus `system_admin` when more than 30
 * days back), and written when finally approved. Its events wait for the effective date.
 */
@Injectable()
export class ChangeRequests {
  constructor(
    private readonly db: ScopedDb,
    private readonly access: AccessService,
    private readonly txRunner: TxRunner,
    private readonly audit: AuditService,
    private readonly approvals: ApprovalService,
    private readonly runtime: RuleRuntime,
    private readonly checker: OrgRuleChecker,
    private readonly writer: StructureWriter,
    private readonly events: OrgEventSink,
    private readonly clock: Clock,
    @Inject(PEOPLE_DIRECTORY_PORT) private readonly people: PeopleDirectoryPort,
  ) {}

  /** The approval request type (registered by the org module). */
  requestType(): ApprovalRequestType {
    return defineApprovalRequestType({
      type: CHANGE_REQUEST_TYPE,
      payload: Payload,
      defaultChain: [OrgChangeApproverRole.name],
      pinRules: BLOCKING_STRUCTURE_RULES.map((r) => r.template.id),
      extraSteps: (payload, { today }) =>
        isBackdated(payload.effectiveDate, today) ? [BACKDATE_APPROVER] : [],
      apply: (tx, request) => this.apply(tx, request),
    });
  }

  async submit(input: orgV1.ChangeRequestInput): Promise<orgV1.ChangeRequestView> {
    await this.access.requireFor(OrgPermissions.requestChange, input.companyId);
    const effectiveDate = input.effectiveDate as platformV1.BusinessDate;
    const impact = await this.check(input.companyId, effectiveDate, input.operations);
    const id = randomUUID();
    const approval = await this.approvals.submit({
      type: CHANGE_REQUEST_TYPE,
      companyId: input.companyId,
      payload: { changeRequestId: id, effectiveDate, operations: input.operations },
      reason: input.reason,
    });
    const now = this.clock.now();
    await this.txRunner.run(async (tx) => {
      await tx.orgChangeRequest.create({
        data: {
          id,
          companyId: input.companyId,
          effectiveDate: dateOf(effectiveDate),
          reason: input.reason,
          operations: toCanonicalValue(input.operations) as object,
          impact: toCanonicalValue(impact) as object,
          status: 'submitted',
          approvalRequestId: approval.id,
          requestedBy: currentContext().actor.id,
          createdAt: now,
          updatedAt: now,
        },
      });
      await this.audit.record(tx, {
        action: 'org.change_request.submit',
        entityType: 'org_change_request',
        entityId: id,
        companyId: input.companyId,
        before: null,
        after: {
          effectiveDate,
          operations: input.operations,
          impact,
          approvalRequestId: approval.id,
        },
        reason: input.reason,
      });
    });
    return (await this.get(id))!;
  }

  /** The requester sends a returned request again, possibly changed: checked and analysed anew. */
  async resubmit(
    id: string,
    input: Omit<orgV1.ChangeRequestInput, 'companyId'>,
    note: string,
  ): Promise<orgV1.ChangeRequestView> {
    const row = await this.db.afterOwnCheck().orgChangeRequest.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Change request not found');
    await this.access.requireFor(OrgPermissions.requestChange, row.companyId);
    if (row.requestedBy !== currentContext().actor.id) {
      throw new ForbiddenException('Only the requester can resubmit');
    }
    const effectiveDate = input.effectiveDate as platformV1.BusinessDate;
    const impact = await this.check(row.companyId, effectiveDate, input.operations);
    await this.approvals.resubmit(
      row.approvalRequestId!,
      { changeRequestId: id, effectiveDate, operations: input.operations },
      note,
    );
    await this.txRunner.run(async (tx) => {
      await tx.orgChangeRequest.update({
        where: { id },
        data: {
          effectiveDate: dateOf(effectiveDate),
          reason: input.reason,
          operations: toCanonicalValue(input.operations) as object,
          impact: toCanonicalValue(impact) as object,
          revision: row.revision + 1,
          updatedAt: this.clock.now(),
        },
      });
      await this.audit.record(tx, {
        action: 'org.change_request.resubmit',
        entityType: 'org_change_request',
        entityId: id,
        companyId: row.companyId,
        before: { effectiveDate: dayOf(row.effectiveDate), operations: row.operations },
        after: { effectiveDate, operations: input.operations, impact },
        reason: note,
      });
    });
    return (await this.get(id))!;
  }

  async get(id: string): Promise<orgV1.ChangeRequestView | null> {
    const found = await this.db.afterOwnCheck().orgChangeRequest.findUnique({
      where: { id },
      select: { companyId: true },
    });
    if (!found) return null;
    const db = await this.db.forCompany(OrgPermissions.read, found.companyId);
    const row = await db.orgChangeRequest.findUnique({ where: { id } });
    return row ? view(row) : null;
  }

  async list(companyId: string): Promise<orgV1.ChangeRequestView[]> {
    const db = await this.db.forCompany(OrgPermissions.read, companyId);
    const rows = await db.orgChangeRequest.findMany({
      where: { companyId },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return rows.map(view);
  }

  /** Plans the bundle on the effective date, refuses invalid or blocking ones, returns the impact. */
  private async check(
    companyId: string,
    effectiveDate: platformV1.BusinessDate,
    operations: readonly orgV1.ChangeOperation[],
  ) {
    const { plan, before } = await this.plan(companyId, effectiveDate, operations);
    if (plan.errors.length > 0) throw new BadRequestException(plan.errors.join('; '));
    await this.refuseBlocking(before, plan.whatIf);
    return computeImpact(this.runtime, companyId, before, plan.whatIf);
  }

  private async plan(
    companyId: string,
    effectiveDate: platformV1.BusinessDate,
    operations: readonly orgV1.ChangeOperation[],
  ) {
    const db = this.db.afterOwnCheck();
    const [current, before] = await Promise.all([
      loadCurrent(db, companyId, effectiveDate),
      buildSnapshot(db, this.people, companyId, effectiveDate),
    ]);
    if (!current.profile) throw new ConflictException('The company has no org profile yet');
    return { current, before, plan: planChange({ effectiveDate, operations, current, before }) };
  }

  private async refuseBlocking(
    before: Parameters<OrgRuleChecker['checkChange']>[0],
    after: Parameters<OrgRuleChecker['checkChange']>[1],
  ) {
    const result = await this.checker.checkChange(before, after);
    if (!result.ok) {
      throw new ConflictException(
        `The change breaks blocking rules: ${result.violations
          .map((v) => `${v.code} ${v.subject.type} ${v.subject.id} ${v.key}`)
          .join('; ')}`,
      );
    }
  }

  /** Runs in the final approval's transaction: re-checks everything, then writes. */
  private async apply(tx: Tx, request: ApprovalContext<Payload>): Promise<void> {
    const { payload } = request;
    const companyId = request.companyId!;
    const effectiveDate = payload.effectiveDate as platformV1.BusinessDate;
    const today = await this.events.today();
    if (isBackdated(effectiveDate, today) && !request.chain.includes(BACKDATE_APPROVER)) {
      throw new ConflictException(
        `The change is now more than ${BACKDATE_DAYS} days back (R4) and needs the special approval; submit it again`,
      );
    }
    const { plan, current, before } = await this.plan(companyId, effectiveDate, payload.operations);
    if (plan.errors.length > 0) throw new ConflictException(plan.errors.join('; '));
    await this.refuseBlocking(before, plan.whatIf);
    const row = await tx.orgChangeRequest.findUniqueOrThrow({
      where: { id: payload.changeRequestId },
    });
    await withFlow({ actionId: payload.changeRequestId }, async () => {
      await this.writer.write(tx, {
        companyId,
        effectiveDate,
        today,
        operations: payload.operations,
        current,
        before,
        whatIf: plan.whatIf,
        reason: row.reason,
      });
      const appliedAt = this.clock.now();
      await tx.orgChangeRequest.update({
        where: { id: row.id },
        data: { status: 'applied', appliedAt, updatedAt: appliedAt },
      });
      await this.audit.record(tx, {
        action: 'org.change_request.apply',
        entityType: 'org_change_request',
        entityId: row.id,
        companyId,
        before: { status: row.status },
        after: { status: 'applied', approvalRequestId: request.requestId },
        reason: row.reason,
      });
      await this.events.emit(
        tx,
        {
          event: ChangeRequestApproved,
          payload: {
            change_request_id: row.id,
            effective_date: effectiveDate,
            operations: payload.operations.length,
          },
          effectiveAt: effectiveDate,
          companyId,
        },
        today,
      );
    });
  }
}

function isBackdated(effectiveDate: string, today: string): boolean {
  return daysBetween(effectiveDate, today) > BACKDATE_DAYS;
}

function view(row: {
  id: string;
  companyId: string;
  effectiveDate: Date;
  reason: string;
  operations: unknown;
  impact: unknown;
  status: string;
  approvalRequestId: string | null;
  requestedBy: string;
  createdAt: Date;
  appliedAt: Date | null;
}): orgV1.ChangeRequestView {
  return {
    id: row.id,
    companyId: row.companyId,
    effectiveDate: dayOf(row.effectiveDate),
    reason: row.reason,
    operations: row.operations as orgV1.ChangeOperation[],
    impact: row.impact as orgV1.Impact,
    status: row.status as orgV1.ChangeRequestView['status'],
    approvalRequestId: row.approvalRequestId!,
    requestedBy: row.requestedBy,
    createdAt: row.createdAt.toISOString(),
    appliedAt: row.appliedAt?.toISOString() ?? null,
  };
}
