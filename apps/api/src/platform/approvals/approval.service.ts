import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { platformV1 } from '@eve/contracts';
import { AuditService } from '../audit/audit.service';
import { toCanonicalValue } from '../audit/canonical-json';
import { RoleRegistry } from '../auth/roles';
import { ConfigService } from '../config/config.service';
import { TimeZoneSetting } from '../config/settings';
import { Clock } from '../context/clock';
import { currentActor, currentContext } from '../context/request-context';
import { LONG_TX, type Tx, TxRunner } from '../context/tx-runner';
import { businessDateIn } from '../dates/dates';
import { PrismaService } from '../db/prisma.service';
import { EventRegistry } from '../events/event-registry';
import { EventPublisher } from '../events/event-publisher';
import { RuleRegistry } from '../rules/rule-registry';
import { AccessService, grantsCover } from '../scope/access.service';
import { ApprovalDecided, ApprovalRequested, ApprovalReturned } from './approval.events';
import { ApprovalTypeRegistry } from './request-types';

export interface SubmitRequest {
  type: string;
  companyId: string | null;
  payload: unknown;
  /** Why the change is requested; recorded in the audit log. */
  reason: string;
}

export interface ApprovalRequestView {
  id: string;
  type: string;
  companyId: string | null;
  payload: unknown;
  revision: number;
  status: platformV1.ApprovalStatus;
  currentStep: number;
  chain: string[];
  pinnedRules: Record<string, number>;
  requestedBy: string;
  createdAt: Date;
  updatedAt: Date;
  decidedAt: Date | null;
}

interface RequestRow {
  id: string;
  type: string;
  company_id: string | null;
  payload: unknown;
  revision: number;
  status: platformV1.ApprovalStatus;
  current_step: number;
  chain: string[];
  pinned_rules: Record<string, number>;
  requested_by: string;
  correlation_id: string;
}

type Decision = 'approve' | 'reject' | 'return';

/**
 * Approval requests as a state machine on PostgreSQL. All state is in the database, so a request
 * waiting for days survives restarts. Every action locks the request row and re-checks its state,
 * so two approvers can never both decide the same step.
 *
 * Rules (product-owner decisions, S2): ordered steps, each a role; the requester never approves
 * (four-eyes) and one person approves at most one step per revision; a returned request is
 * resubmitted from step 1 with a new revision; chain and pinned rule versions are fixed at
 * submission.
 */
@Injectable()
export class ApprovalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly txRunner: TxRunner,
    private readonly audit: AuditService,
    private readonly events: EventPublisher,
    private readonly config: ConfigService,
    private readonly clock: Clock,
    private readonly access: AccessService,
    private readonly types: ApprovalTypeRegistry,
    private readonly roles: RoleRegistry,
    private readonly rules: RuleRegistry,
    eventRegistry: EventRegistry,
  ) {
    eventRegistry.register(ApprovalRequested, ApprovalDecided, ApprovalReturned);
  }

  async submit(request: SubmitRequest): Promise<ApprovalRequestView> {
    const requester = this.requireUser();
    const definition = this.types.get(request.type);
    const payload = this.parsePayload(request.type, request.payload);
    const today = await this.today();
    await definition.check?.(payload, { companyId: request.companyId, today });

    const chain = await this.config.get(this.types.chainSetting(request.type), request.companyId);
    for (const role of chain) {
      if (!this.roles.has(role))
        throw new ConflictException(`Approval chain names unknown role ${role}`);
    }
    const pinnedRules = Object.fromEntries(
      (definition.pinRules ?? []).map((id) => [id, this.rules.latest(id).version]),
    );
    const now = this.clock.now();
    const { correlationId } = currentContext();

    return this.txRunner.run(async (tx) => {
      const created = await tx.approvalsRequest.create({
        data: {
          type: request.type,
          companyId: request.companyId,
          payload: toCanonicalValue(payload),
          status: 'pending',
          chain,
          pinnedRules,
          requestedBy: requester,
          correlationId,
          createdAt: now,
          updatedAt: now,
        },
      });
      await this.recordAction(tx, created.id, 1, 0, 'submit', requester, null, payload);
      await this.audit.record(tx, {
        action: 'platform.approval.submit',
        entityType: 'approvals_request',
        entityId: created.id,
        companyId: request.companyId,
        before: null,
        after: { type: request.type, revision: 1, status: 'pending', chain, pinnedRules, payload },
        reason: request.reason,
      });
      await this.publishRequested(
        tx,
        created.id,
        request.type,
        request.companyId,
        1,
        0,
        chain,
        today,
      );
      return this.view(created);
    });
  }

  approve(id: string, note: string | null): Promise<ApprovalRequestView> {
    return this.decide(id, 'approve', note);
  }

  reject(id: string, note: string): Promise<ApprovalRequestView> {
    return this.decide(id, 'reject', note);
  }

  returnToRequester(id: string, note: string): Promise<ApprovalRequestView> {
    return this.decide(id, 'return', note);
  }

  /** The requester sends a returned request again, possibly changed; approval restarts at step 1. */
  async resubmit(id: string, payloadInput: unknown, note: string): Promise<ApprovalRequestView> {
    const actor = this.requireUser();
    const today = await this.today();
    return this.txRunner.run(async (tx) => {
      const row = await this.lock(tx, id);
      if (row.requested_by !== actor)
        throw new ForbiddenException('Only the requester can resubmit');
      if (row.status !== 'returned')
        throw new ConflictException(`Request is ${row.status}, not returned`);
      const definition = this.types.get(row.type);
      const payload = this.parsePayload(row.type, payloadInput);
      await definition.check?.(payload, { companyId: row.company_id, today });
      const revision = row.revision + 1;

      const updated = await tx.approvalsRequest.update({
        where: { id },
        data: {
          payload: toCanonicalValue(payload),
          revision,
          status: 'pending',
          currentStep: 0,
          updatedAt: this.clock.now(),
        },
      });
      await this.recordAction(tx, id, revision, 0, 'resubmit', actor, note, payload);
      await this.audit.record(tx, {
        action: 'platform.approval.resubmit',
        entityType: 'approvals_request',
        entityId: id,
        companyId: row.company_id,
        before: { revision: row.revision, status: row.status, payload: row.payload },
        after: { revision, status: 'pending', payload },
        reason: note,
      });
      await this.publishRequested(tx, id, row.type, row.company_id, revision, 0, row.chain, today);
      return this.view(updated);
    });
  }

  /** The requester withdraws a pending or returned request. */
  async cancel(id: string, note: string): Promise<ApprovalRequestView> {
    const actor = this.requireUser();
    const today = await this.today();
    return this.txRunner.run(async (tx) => {
      const row = await this.lock(tx, id);
      if (row.requested_by !== actor) throw new ForbiddenException('Only the requester can cancel');
      if (row.status !== 'pending' && row.status !== 'returned') {
        throw new ConflictException(`Request is already ${row.status}`);
      }
      const now = this.clock.now();
      const updated = await tx.approvalsRequest.update({
        where: { id },
        data: { status: 'cancelled', updatedAt: now, decidedAt: now },
      });
      await this.recordAction(tx, id, row.revision, row.current_step, 'cancel', actor, note, null);
      await this.audit.record(tx, {
        action: 'platform.approval.cancel',
        entityType: 'approvals_request',
        entityId: id,
        companyId: row.company_id,
        before: { status: row.status },
        after: { status: 'cancelled' },
        reason: note,
      });
      await this.events.publish(tx, {
        event: ApprovalDecided,
        payload: { request_id: id, request_type: row.type, outcome: 'cancelled' },
        effectiveAt: today,
        companyId: row.company_id,
      });
      return this.view(updated);
    });
  }

  /** Pending requests whose current step the caller may act on now. */
  async inbox(): Promise<ApprovalRequestView[]> {
    const actor = this.requireUser();
    const grants = await this.access.grantsOf({ kind: 'user', id: actor });
    const pending = await this.prisma.approvalsRequest.findMany({
      where: { status: 'pending', requestedBy: { not: actor } },
      orderBy: { createdAt: 'asc' },
      include: {
        actions: { where: { action: 'approve', actorId: actor }, select: { revision: true } },
      },
    });
    return pending
      .filter((r) => {
        const role = (r.chain as string[])[r.currentStep];
        const approvedThisRevision = r.actions.some((a) => a.revision === r.revision);
        return (
          role !== undefined && !approvedThisRevision && grantsCover(grants, role, r.companyId)
        );
      })
      .map((r) => this.view(r));
  }

  /** Requests the caller submitted. */
  async mine(): Promise<ApprovalRequestView[]> {
    const actor = this.requireUser();
    const rows = await this.prisma.approvalsRequest.findMany({
      where: { requestedBy: actor },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return rows.map((r) => this.view(r));
  }

  /** A request and its full history, for its requester and anyone on its chain. */
  async get(id: string) {
    const actor = this.requireUser();
    const row = await this.prisma.approvalsRequest.findUnique({
      where: { id },
      include: { actions: { orderBy: { at: 'asc' } } },
    });
    if (!row) throw new NotFoundException('Approval request not found');
    const grants = await this.access.grantsOf({ kind: 'user', id: actor });
    const onChain = (row.chain as string[]).some((role) =>
      grantsCover(grants, role, row.companyId),
    );
    if (row.requestedBy !== actor && !onChain) throw new ForbiddenException();
    return {
      ...this.view(row),
      history: row.actions.map((a) => ({
        action: a.action,
        revision: a.revision,
        step: a.step,
        actorId: a.actorId,
        note: a.note,
        at: a.at,
      })),
    };
  }

  private async decide(
    id: string,
    decision: Decision,
    note: string | null,
  ): Promise<ApprovalRequestView> {
    const actor = this.requireUser();
    if (decision !== 'approve' && !note?.trim())
      throw new BadRequestException('A note is required');
    const today = await this.today();
    const grants = await this.access.grantsOf({ kind: 'user', id: actor });

    return this.txRunner.run(async (tx) => {
      const row = await this.lock(tx, id);
      if (row.status !== 'pending') throw new ConflictException(`Request is ${row.status}`);
      if (row.requested_by === actor)
        throw new ForbiddenException('The requester cannot decide their own request');
      const role = row.chain[row.current_step];
      if (!role || !grantsCover(grants, role, row.company_id)) {
        throw new ForbiddenException(`This step needs the ${role ?? 'unknown'} role`);
      }
      if (decision === 'approve' && (await this.approvedThisRevision(tx, row, actor))) {
        throw new ForbiddenException('One person approves at most one step of a request');
      }

      const now = this.clock.now();
      const step = row.current_step;
      const definition = this.types.get(row.type);
      const reason = note?.trim() || `${decision} step ${step + 1}`;
      await this.recordAction(tx, id, row.revision, step, decision, actor, note, null);

      let next: { status: platformV1.ApprovalStatus; currentStep: number; decidedAt: Date | null };
      if (decision === 'approve' && step + 1 < row.chain.length) {
        next = { status: 'pending', currentStep: step + 1, decidedAt: null };
        await this.publishRequested(
          tx,
          id,
          row.type,
          row.company_id,
          row.revision,
          step + 1,
          row.chain,
          today,
        );
      } else if (decision === 'approve') {
        const payload = definition.payload.parse(row.payload);
        await definition.check?.(payload, { companyId: row.company_id, today });
        await definition.apply(tx, {
          requestId: id,
          companyId: row.company_id,
          payload,
          pinnedRules: row.pinned_rules,
          requestedBy: row.requested_by,
        });
        next = { status: 'approved', currentStep: step, decidedAt: now };
        await this.events.publish(tx, {
          event: ApprovalDecided,
          payload: { request_id: id, request_type: row.type, outcome: 'approved' },
          effectiveAt: today,
          companyId: row.company_id,
        });
      } else if (decision === 'reject') {
        next = { status: 'rejected', currentStep: step, decidedAt: now };
        await this.events.publish(tx, {
          event: ApprovalDecided,
          payload: { request_id: id, request_type: row.type, outcome: 'rejected' },
          effectiveAt: today,
          companyId: row.company_id,
        });
      } else {
        next = { status: 'returned', currentStep: step, decidedAt: null };
        await this.events.publish(tx, {
          event: ApprovalReturned,
          payload: { request_id: id, request_type: row.type, revision: row.revision },
          effectiveAt: today,
          companyId: row.company_id,
        });
      }

      const updated = await tx.approvalsRequest.update({
        where: { id },
        data: { ...next, updatedAt: now },
      });
      await this.audit.record(tx, {
        action: `platform.approval.${decision}`,
        entityType: 'approvals_request',
        entityId: id,
        companyId: row.company_id,
        before: { status: row.status, step, revision: row.revision },
        after: { status: next.status, step: next.currentStep, revision: row.revision, role },
        reason,
      });
      return this.view(updated);
    }, LONG_TX); // a final approval may apply a bulk change (e.g. an import)
  }

  private async lock(tx: Tx, id: string): Promise<RequestRow> {
    const [row] = await tx.$queryRaw<RequestRow[]>`
      SELECT id, type, company_id, payload, revision, status, current_step, chain, pinned_rules,
             requested_by, correlation_id
      FROM approvals_request WHERE id = ${id}::uuid FOR UPDATE`;
    if (!row) throw new NotFoundException('Approval request not found');
    return row;
  }

  private async approvedThisRevision(tx: Tx, row: RequestRow, actor: string): Promise<boolean> {
    const count = await tx.approvalsAction.count({
      where: { requestId: row.id, revision: row.revision, action: 'approve', actorId: actor },
    });
    return count > 0;
  }

  private async recordAction(
    tx: Tx,
    requestId: string,
    revision: number,
    step: number,
    action: platformV1.ApprovalActionKind,
    actorId: string,
    note: string | null,
    payload: unknown,
  ): Promise<void> {
    await tx.approvalsAction.create({
      data: {
        requestId,
        revision,
        step,
        action,
        actorId,
        note,
        payload: payload === null ? undefined : (toCanonicalValue(payload) as object),
        at: this.clock.now(),
      },
    });
  }

  private publishRequested(
    tx: Tx,
    id: string,
    type: string,
    companyId: string | null,
    revision: number,
    step: number,
    chain: readonly string[],
    today: platformV1.BusinessDate,
  ) {
    return this.events.publish(tx, {
      event: ApprovalRequested,
      payload: { request_id: id, request_type: type, revision, step, role: chain[step] ?? '' },
      effectiveAt: today,
      companyId,
    });
  }

  private parsePayload(type: string, payload: unknown): unknown {
    const result = this.types.get(type).payload.safeParse(payload);
    if (!result.success) {
      throw new BadRequestException({
        error: 'invalid_request',
        issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    return result.data;
  }

  /** Approvals are human: only a signed-in user submits or decides. */
  private requireUser(): string {
    const actor = currentActor();
    if (!actor) throw new UnauthorizedException();
    if (actor.kind !== 'user') throw new ForbiddenException('Only people take part in approvals');
    return actor.id;
  }

  private async today(): Promise<platformV1.BusinessDate> {
    return businessDateIn(this.clock.now(), await this.config.get(TimeZoneSetting));
  }

  private view(row: {
    id: string;
    type: string;
    companyId: string | null;
    payload: unknown;
    revision: number;
    status: string;
    currentStep: number;
    chain: unknown;
    pinnedRules: unknown;
    requestedBy: string;
    createdAt: Date;
    updatedAt: Date;
    decidedAt: Date | null;
  }): ApprovalRequestView {
    return {
      id: row.id,
      type: row.type,
      companyId: row.companyId,
      payload: row.payload,
      revision: row.revision,
      status: row.status as platformV1.ApprovalStatus,
      currentStep: row.currentStep,
      chain: row.chain as string[],
      pinnedRules: row.pinnedRules as Record<string, number>,
      requestedBy: row.requestedBy,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      decidedAt: row.decidedAt,
    };
  }
}
