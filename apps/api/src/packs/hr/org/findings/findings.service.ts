import { Injectable } from '@nestjs/common';
import type { orgV1 } from '@eve/contracts';
import { ScopedDb } from '../../../../platform/scope/scoped-db';
import { OrgPermissions } from '../org.permissions';
import { findingView, ruleRunView } from './finding-view';

/**
 * The findings inbox (spec §9). By default it lists open blocking and warning findings; info
 * findings (R12-R14) are for reports and appear only when asked for (decision 2026-11-25).
 */
@Injectable()
export class FindingsService {
  constructor(private readonly db: ScopedDb) {}

  async list(input: orgV1.OrgToolInput<'listFindings'>): Promise<orgV1.FindingView[]> {
    const db = await this.db.forCompany(OrgPermissions.read, input.companyId);
    const rows = await db.orgFinding.findMany({
      where: {
        companyId: input.companyId,
        status: input.status ?? 'open',
        severity: input.severity ?? { in: ['blocking', 'warning'] },
        ...(input.code ? { code: input.code } : {}),
      },
      // Blocking before warning before info, then the oldest first.
      orderBy: [{ severity: 'asc' }, { firstSeenAt: 'asc' }, { id: 'asc' }],
      take: input.limit ?? 1000,
    });
    return rows.map(findingView);
  }

  /** One finding, or null when it does not exist; 403 when the caller may not read its company. */
  async get(id: string): Promise<orgV1.FindingView | null> {
    const found = await this.db.afterOwnCheck().orgFinding.findUnique({
      where: { id },
      select: { companyId: true },
    });
    if (!found) return null;
    const db = await this.db.forCompany(OrgPermissions.read, found.companyId);
    const row = await db.orgFinding.findUnique({ where: { id } });
    return row ? findingView(row) : null;
  }

  async latestRun(companyId: string): Promise<orgV1.RuleRunView | null> {
    const db = await this.db.forCompany(OrgPermissions.read, companyId);
    const row = await db.orgRuleRun.findFirst({
      where: { companyId },
      orderBy: { finishedAt: 'desc' },
    });
    return row ? ruleRunView(row) : null;
  }
}
