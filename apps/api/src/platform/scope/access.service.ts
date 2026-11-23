import { ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { platformV1 } from '@eve/contracts';
import { RoleRegistry } from '../auth/roles';
import { ConfigService } from '../config/config.service';
import { TimeZoneSetting } from '../config/settings';
import { Clock } from '../context/clock';
import { currentActor } from '../context/request-context';
import { businessDateIn } from '../dates/dates';
import { PrismaService } from '../db/prisma.service';
import { UNIT_SUBTREE_PORT, type UnitSubtreePort } from './ports/unit-subtree.port';

/** What a caller may see for one permission: everything, some companies, some unit subtrees. */
export interface ResolvedScope {
  readonly customerWide: boolean;
  readonly companyIds: ReadonlySet<string>;
  readonly unitIds: ReadonlySet<string>;
}

export const NO_SCOPE: ResolvedScope = {
  customerWide: false,
  companyIds: new Set(),
  unitIds: new Set(),
};

const FULL_SCOPE: ResolvedScope = { customerWide: true, companyIds: new Set(), unitIds: new Set() };

/**
 * Turns the caller's active role grants into a scope per permission (CLAUDE.md rule 11).
 * An agent gets exactly the scope of the user it acts for, never more.
 */
@Injectable()
export class AccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly roles: RoleRegistry,
    private readonly config: ConfigService,
    private readonly clock: Clock,
    @Inject(UNIT_SUBTREE_PORT) private readonly unitSubtree: UnitSubtreePort,
  ) {}

  async scopeFor(actor: platformV1.Actor, permission: string): Promise<ResolvedScope> {
    if (actor.kind === 'system') return FULL_SCOPE;
    const userId = actor.kind === 'agent' ? actor.onBehalfOf : actor.id;
    const roleNames = this.roles.rolesWith(permission);
    if (roleNames.length === 0) return NO_SCOPE;

    const grants = await this.prisma.authRoleAssignment.findMany({
      where: { userId, revokedAt: null, role: { in: roleNames }, user: { status: 'active' } },
      select: { scopeKind: true, companyId: true, unitId: true },
    });
    if (grants.some((g) => g.scopeKind === 'customer')) return FULL_SCOPE;

    const companyIds = new Set<string>();
    const unitIds = new Set<string>();
    const unitGrants = grants.filter((g) => g.scopeKind === 'unit');
    const today = unitGrants.length > 0 ? await this.today() : null;
    for (const grant of grants) {
      if (grant.scopeKind === 'company' && grant.companyId) companyIds.add(grant.companyId);
    }
    for (const grant of unitGrants) {
      if (!grant.companyId || !grant.unitId || !today) continue;
      for (const id of await this.unitSubtree.unitIdsUnder(grant.companyId, grant.unitId, today)) {
        unitIds.add(id);
      }
    }
    return { customerWide: false, companyIds, unitIds };
  }

  /** Scope of the current caller; throws 401 when unauthenticated, 403 when the scope is empty. */
  async require(permission: string): Promise<ResolvedScope> {
    const actor = currentActor();
    if (!actor) throw new UnauthorizedException();
    const scope = await this.scopeFor(actor, permission);
    if (!scope.customerWide && scope.companyIds.size === 0 && scope.unitIds.size === 0) {
      throw new ForbiddenException();
    }
    return scope;
  }

  /** Requires the permission for one company, or customer-wide when `companyId` is null. */
  async requireFor(permission: string, companyId: string | null): Promise<ResolvedScope> {
    const scope = await this.require(permission);
    if (scope.customerWide || (companyId !== null && scope.companyIds.has(companyId))) return scope;
    throw new ForbiddenException();
  }

  private async today(): Promise<platformV1.BusinessDate> {
    return businessDateIn(this.clock.now(), await this.config.get(TimeZoneSetting));
  }
}
