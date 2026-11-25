import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { orgV1 } from '@eve/contracts';
import { AuditService } from '../../../../platform/audit/audit.service';
import { Clock } from '../../../../platform/context/clock';
import { currentContext } from '../../../../platform/context/request-context';
import { TxRunner } from '../../../../platform/context/tx-runner';
import { AccessService } from '../../../../platform/scope/access.service';
import { ScopedDb } from '../../../../platform/scope/scoped-db';
import { OrgPermissions } from '../org.permissions';
import { findingView } from './finding-view';

/**
 * What the data owner does in the inbox (spec §5): accept a warning as an exception with a reason
 * (later runs never reopen it), or reopen an accepted one. Fixing the data itself is a correction
 * or a change request (S8). Blocking findings cannot be accepted, and info findings need nothing.
 */
@Injectable()
export class FindingsCommands {
  constructor(
    private readonly db: ScopedDb,
    private readonly access: AccessService,
    private readonly txRunner: TxRunner,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  async accept(id: string, reason: string): Promise<orgV1.FindingView> {
    const companyId = await this.authorize(id);
    const by = actorId();
    return this.txRunner.run(async (tx) => {
      const row = await tx.orgFinding.findUnique({ where: { id } });
      if (!row) throw new NotFoundException('Finding not found');
      if (row.severity !== 'warning') {
        throw new ConflictException(
          row.severity === 'blocking'
            ? 'A blocking finding cannot be accepted; the data must be fixed'
            : 'An info finding needs no action',
        );
      }
      const at = this.clock.now();
      const { count } = await tx.orgFinding.updateMany({
        where: { id, status: 'open' },
        data: { status: 'accepted', acceptedBy: by, acceptedAt: at, acceptedReason: reason },
      });
      if (count === 0) throw new ConflictException(`Finding is ${row.status}, not open`);
      await this.audit.record(tx, {
        action: 'org.finding.accept',
        entityType: 'org_finding',
        entityId: id,
        companyId,
        before: { status: 'open' },
        after: { status: 'accepted', acceptedBy: by, acceptedAt: at.toISOString() },
        reason,
      });
      return findingView((await tx.orgFinding.findUnique({ where: { id } }))!);
    });
  }

  /** Lifts an accepted exception: the finding is open again and the next run judges it. */
  async reopen(id: string, reason: string): Promise<orgV1.FindingView> {
    const companyId = await this.authorize(id);
    const by = actorId();
    return this.txRunner.run(async (tx) => {
      const at = this.clock.now();
      const { count } = await tx.orgFinding.updateMany({
        where: { id, status: 'accepted' },
        data: { status: 'open', reopenedBy: by, reopenedAt: at, reopenedReason: reason },
      });
      if (count === 0) throw new ConflictException('Only an accepted finding can be reopened');
      await this.audit.record(tx, {
        action: 'org.finding.reopen',
        entityType: 'org_finding',
        entityId: id,
        companyId,
        before: { status: 'accepted' },
        after: { status: 'open', reopenedBy: by, reopenedAt: at.toISOString() },
        reason,
      });
      return findingView((await tx.orgFinding.findUnique({ where: { id } }))!);
    });
  }

  /** The finding's company, if the caller may manage its findings (404 / 403 otherwise). */
  private async authorize(id: string): Promise<string> {
    const found = await this.db.afterOwnCheck().orgFinding.findUnique({
      where: { id },
      select: { companyId: true },
    });
    if (!found) throw new NotFoundException('Finding not found');
    await this.access.requireFor(OrgPermissions.manageFindings, found.companyId);
    return found.companyId;
  }
}

function actorId(): string {
  const { actor } = currentContext();
  return actor.kind === 'agent' ? `${actor.id} for ${actor.onBehalfOf}` : actor.id;
}
