import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { orgV1, type platformV1 } from '@eve/contracts';
import type { z } from 'zod';
import { ApprovalService } from '../../../../platform/approvals/approval.service';
import { toCanonicalValue } from '../../../../platform/audit/canonical-json';
import { AuditService } from '../../../../platform/audit/audit.service';
import { Clock } from '../../../../platform/context/clock';
import { withFlow } from '../../../../platform/context/request-context';
import { TxRunner } from '../../../../platform/context/tx-runner';
import { type EventDefinition } from '../../../../platform/events/event-registry';
import { ScopedDb } from '../../../../platform/scope/scoped-db';
import { AssignmentEnded, AssignmentStarted, ManagerChanged } from '../events/org.events';
import { OrgEventSink } from '../events/org-event-sink';
import { loadCurrent } from '../import/structure-model';
import { dateOf } from '../model/period';
import { PEOPLE_DIRECTORY_PORT, type PeopleDirectoryPort } from '../ports/people-directory.port';
import { daysBetween } from '../rules/common';
import { managerChanges } from '../rules/managers';
import { OrgRuleChecker } from '../rules/org-rule-checker';
import { buildSnapshot } from '../rules/snapshot';

/** Request types of the personnel-action workflow (Module 43) start with this. */
export const PERSONNEL_ACTION_PREFIX = 'personnel_action.';
const BACKDATE_DAYS = 30;

/**
 * `apply_assignment` (spec §7, F16, ADR-007): the only way a hire, promotion or transfer writes an
 * assignment. The decision was taken and approved in the personnel-action workflow; org checks R3,
 * R4 and R15 and applies it. Accepted only with the id of an approved `personnel_action.*` request
 * of the same company. Idempotent on the action id: a replay returns the first result and writes
 * nothing. Events carry the caller's correlation id (the personnel action's flow).
 */
@Injectable()
export class ApplyAssignment {
  constructor(
    private readonly db: ScopedDb,
    private readonly txRunner: TxRunner,
    private readonly audit: AuditService,
    private readonly approvals: ApprovalService,
    private readonly checker: OrgRuleChecker,
    private readonly events: OrgEventSink,
    private readonly clock: Clock,
    @Inject(PEOPLE_DIRECTORY_PORT) private readonly people: PeopleDirectoryPort,
  ) {}

  async apply(input: orgV1.ApplyAssignmentCommand): Promise<orgV1.ApplyAssignmentResult> {
    const command = orgV1.ApplyAssignmentCommandSchema.parse(input);
    const canonical = toCanonicalValue(command);

    const done = await this.db.afterOwnCheck().orgAppliedAction.findUnique({
      where: { actionId: command.actionId },
    });
    if (done) {
      if (!isDeepStrictEqual(toCanonicalValue(done.command), canonical)) {
        throw new ConflictException(
          `Action ${command.actionId} was applied with a different command`,
        );
      }
      return { ...(done.result as { assignmentId: string }), replayed: true };
    }

    const approval = await this.approvals.statusOf(command.approvalId);
    if (!approval || !approval.type.startsWith(PERSONNEL_ACTION_PREFIX)) {
      throw new ForbiddenException('apply_assignment needs an approved personnel action');
    }
    if (approval.companyId !== command.companyId) {
      throw new ForbiddenException('The personnel action belongs to another company');
    }
    if (approval.status !== 'approved') {
      throw new ConflictException(`The personnel action is ${approval.status}, not approved`);
    }
    const effectiveDate = command.effectiveDate as platformV1.BusinessDate;
    const today = await this.events.today();
    if (daysBetween(effectiveDate, today) > BACKDATE_DAYS) {
      throw new ConflictException(
        `R4: an assignment more than ${BACKDATE_DAYS} days back is refused`,
      );
    }

    const db = this.db.afterOwnCheck();
    const [current, before] = await Promise.all([
      loadCurrent(db, command.companyId, effectiveDate),
      buildSnapshot(db, this.people, command.companyId, effectiveDate),
    ]);
    if (!current.positions.some((p) => p.id === command.positionId)) {
      throw new NotFoundException(`No such position on ${effectiveDate}`);
    }
    const ending =
      command.operation === 'end'
        ? current.assignments.find(
            (a) =>
              a.personId === command.personId &&
              a.positionId === command.positionId &&
              a.kind === command.kind,
          )
        : undefined;
    if (command.operation === 'end' && !ending) {
      throw new ConflictException(
        `No ${command.kind} assignment of that person on that position on ${effectiveDate}`,
      );
    }
    const after = {
      ...before,
      assignments:
        command.operation === 'start'
          ? [
              ...before.assignments,
              {
                personId: command.personId,
                positionId: command.positionId,
                kind: command.kind,
                timeShare: command.timeShare,
              },
            ]
          : before.assignments.filter(
              (a) =>
                !(
                  a.personId === command.personId &&
                  a.positionId === command.positionId &&
                  a.kind === command.kind
                ),
            ),
    };
    const check = await this.checker.checkChange(before, after, ['R3', 'R15']);
    if (!check.ok) {
      throw new ConflictException(
        `Refused: ${check.violations.map((v) => `${v.code} ${v.subject.type} ${v.subject.id} (${v.key})`).join('; ')}`,
      );
    }

    const assignmentId = ending?.id ?? randomUUID();
    const from = dateOf(effectiveDate);
    const now = this.clock.now();
    await withFlow({ actionId: command.actionId, source: 'workflow' }, () =>
      this.txRunner.run(async (tx) => {
        // Claims the action id first: a concurrent replay fails here and finds the result later.
        await tx.orgAppliedAction.create({
          data: {
            actionId: command.actionId,
            companyId: command.companyId,
            approvalId: command.approvalId,
            command: canonical as object,
            result: { assignmentId },
            appliedAt: now,
          },
        });
        const reason = `personnel action ${command.actionId}`;
        const emit = <S extends z.ZodType>(event: EventDefinition<S>, payload: z.input<S>) =>
          this.events.emit(
            tx,
            { event, payload, effectiveAt: effectiveDate, companyId: command.companyId },
            today,
          );
        if (command.operation === 'start') {
          await tx.orgAssignment.create({
            data: {
              id: assignmentId,
              companyId: command.companyId,
              personId: command.personId,
              positionId: command.positionId,
              kind: command.kind,
              timeShare: String(command.timeShare),
              source: 'personnel_action',
              actionRef: command.actionId,
              orderNumber: command.orderNumber ?? null,
              validFrom: from,
              recordedAt: now,
            },
          });
          await this.audit.record(tx, {
            action: 'org.assignment.start',
            entityType: 'org_assignment',
            entityId: assignmentId,
            companyId: command.companyId,
            before: null,
            after: { ...command, validFrom: effectiveDate },
            reason,
          });
          await emit(AssignmentStarted, {
            assignment_id: assignmentId,
            person_id: command.personId,
            position_id: command.positionId,
            kind: command.kind,
            time_share: command.timeShare,
            action_ref: command.actionId,
          });
        } else {
          const row = await tx.orgAssignment.findUniqueOrThrow({ where: { id: assignmentId } });
          if (row.validFrom.getTime() >= from.getTime()) {
            throw new ConflictException(
              'The assignment starts on or after that date; it cannot end then',
            );
          }
          await tx.orgAssignment.update({ where: { id: assignmentId }, data: { validTo: from } });
          await this.audit.record(tx, {
            action: 'org.assignment.end',
            entityType: 'org_assignment',
            entityId: assignmentId,
            companyId: command.companyId,
            before: { validTo: row.validTo },
            after: { validTo: effectiveDate, actionId: command.actionId },
            reason,
          });
          await emit(AssignmentEnded, {
            assignment_id: assignmentId,
            person_id: command.personId,
            position_id: command.positionId,
            kind: command.kind,
            action_ref: command.actionId,
          });
        }
        for (const change of managerChanges(before, after)) {
          await emit(ManagerChanged, {
            person_id: change.personId,
            from_manager_person_id: change.from,
            to_manager_person_id: change.to,
          });
        }
      }),
    );
    return { assignmentId, replayed: false };
  }
}
