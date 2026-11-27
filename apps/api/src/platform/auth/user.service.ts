import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { ChannelRegistry } from '../channels/channel';
import { ConfigService } from '../config/config.service';
import { Clock } from '../context/clock';
import { type Tx, TxRunner } from '../context/tx-runner';
import { PrismaService } from '../db/prisma.service';
import { AuthSettings } from './auth.settings';
import { randomBytes } from 'node:crypto';
import { hashPassword } from './crypto';
import { RoleRegistry, type ScopeKind, SystemAdminRole } from './roles';

export interface CreateUserRequest {
  username: string;
  password: string;
  contactChannel: string;
  contactAddress: string;
  reason: string;
}

export interface UserSummary {
  id: string;
  username: string;
  status: string;
  contactChannel: string;
}

export interface GrantRoleRequest {
  userId: string;
  role: string;
  scopeKind: ScopeKind;
  companyId: string | null;
  unitId: string | null;
  reason: string;
}

/** User accounts and role grants. Every change is audited; password hashes never are. */
@Injectable()
export class UserService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly txRunner: TxRunner,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    private readonly channels: ChannelRegistry,
    private readonly roles: RoleRegistry,
    private readonly clock: Clock,
  ) {}

  async create(request: CreateUserRequest): Promise<UserSummary> {
    const username = request.username.trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,64}$/.test(username)) {
      throw new BadRequestException('Username must be 3-64 characters: a-z, 0-9, ".", "_", "-"');
    }
    await this.assertPasswordPolicy(request.password);
    if (!this.channels.has(request.contactChannel)) {
      throw new BadRequestException(`Unknown contact channel ${request.contactChannel}`);
    }
    if (request.contactAddress.trim() === '')
      throw new BadRequestException('Contact address is required');
    const passwordHash = await hashPassword(request.password);
    const now = this.clock.now();

    return this.txRunner.run(async (tx) => {
      if (await tx.authUser.findUnique({ where: { username }, select: { id: true } })) {
        throw new ConflictException(`User ${username} already exists`);
      }
      const user = await tx.authUser.create({
        data: {
          username,
          passwordHash,
          status: 'active',
          contactChannel: request.contactChannel,
          contactAddress: request.contactAddress.trim(),
          createdAt: now,
          updatedAt: now,
        },
        select: { id: true, username: true, status: true, contactChannel: true },
      });
      await this.audit.record(tx, {
        action: 'platform.auth.user.create',
        entityType: 'auth_user',
        entityId: user.id,
        companyId: null,
        before: null,
        after: user,
        reason: request.reason,
      });
      return user;
    });
  }

  /**
   * An account created by a channel's self-service linking (S12), inside the caller's transaction.
   * It has no usable password (a random one nobody knows); it signs in through its channel.
   */
  async createChannelUser(
    tx: Tx,
    request: { username: string; contactChannel: string; contactAddress: string; reason: string },
  ): Promise<{ id: string }> {
    if (!this.channels.has(request.contactChannel))
      throw new BadRequestException(`Unknown contact channel ${request.contactChannel}`);
    const now = this.clock.now();
    const user = await tx.authUser.create({
      data: {
        username: request.username,
        passwordHash: await hashPassword(randomBytes(32).toString('base64url')),
        status: 'active',
        contactChannel: request.contactChannel,
        contactAddress: request.contactAddress,
        createdAt: now,
        updatedAt: now,
      },
      select: { id: true, username: true, status: true, contactChannel: true },
    });
    await this.audit.record(tx, {
      action: 'platform.auth.user.create',
      entityType: 'auth_user',
      entityId: user.id,
      companyId: null,
      before: null,
      after: user,
      reason: request.reason,
    });
    return { id: user.id };
  }

  /** Points a user's one-time codes and messages to another channel address (S12 linking). */
  async setContact(
    tx: Tx,
    userId: string,
    contact: { channel: string; address: string },
    reason: string,
  ): Promise<void> {
    if (!this.channels.has(contact.channel))
      throw new BadRequestException(`Unknown contact channel ${contact.channel}`);
    const before = await tx.authUser.findUnique({
      where: { id: userId },
      select: { contactChannel: true },
    });
    if (!before) throw new NotFoundException('User not found');
    await tx.authUser.update({
      where: { id: userId },
      data: {
        contactChannel: contact.channel,
        contactAddress: contact.address,
        updatedAt: this.clock.now(),
      },
    });
    // Addresses are contact data: the audit names the channel, not the address.
    await this.audit.record(tx, {
      action: 'platform.auth.user.contact',
      entityType: 'auth_user',
      entityId: userId,
      companyId: null,
      before: { contactChannel: before.contactChannel },
      after: { contactChannel: contact.channel },
      reason,
    });
  }

  async grantRole(request: GrantRoleRequest): Promise<{ id: string }> {
    if (!this.roles.has(request.role))
      throw new BadRequestException(`Unknown role ${request.role}`);
    const role = this.roles.get(request.role);
    if (!role.allowedScopes.includes(request.scopeKind)) {
      throw new BadRequestException(
        `Role ${role.name} cannot be granted with ${request.scopeKind} scope`,
      );
    }
    const companyId = request.scopeKind === 'customer' ? null : request.companyId;
    const unitId = request.scopeKind === 'unit' ? request.unitId : null;
    if (request.scopeKind !== 'customer' && !companyId)
      throw new BadRequestException('companyId is required');
    if (request.scopeKind === 'unit' && !unitId)
      throw new BadRequestException('unitId is required');

    return this.txRunner.run(async (tx) => {
      await this.requireUser(tx, request.userId);
      const existing = await tx.authRoleAssignment.findFirst({
        where: {
          userId: request.userId,
          role: role.name,
          scopeKind: request.scopeKind,
          companyId,
          unitId,
          revokedAt: null,
        },
        select: { id: true },
      });
      if (existing) return existing;
      const grant = await tx.authRoleAssignment.create({
        data: {
          userId: request.userId,
          role: role.name,
          scopeKind: request.scopeKind,
          companyId,
          unitId,
          createdAt: this.clock.now(),
        },
        select: {
          id: true,
          userId: true,
          role: true,
          scopeKind: true,
          companyId: true,
          unitId: true,
        },
      });
      await this.audit.record(tx, {
        action: 'platform.auth.role.grant',
        entityType: 'auth_role_assignment',
        entityId: grant.id,
        companyId,
        before: null,
        after: grant,
        reason: request.reason,
      });
      return { id: grant.id };
    });
  }

  async revokeRole(assignmentId: string, reason: string): Promise<void> {
    await this.txRunner.run(async (tx) => {
      const grant = await tx.authRoleAssignment.findUnique({ where: { id: assignmentId } });
      if (!grant || grant.revokedAt)
        throw new NotFoundException('Active role assignment not found');
      if (grant.role === SystemAdminRole.name && grant.scopeKind === 'customer') {
        // Lock against concurrent revocations, then keep at least one administrator.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('auth:system_admin'))`;
        const admins = await tx.authRoleAssignment.count({
          where: {
            role: SystemAdminRole.name,
            scopeKind: 'customer',
            revokedAt: null,
            user: { status: 'active' },
          },
        });
        if (admins <= 1) throw new ConflictException('Cannot revoke the last system administrator');
      }
      const revokedAt = this.clock.now();
      await tx.authRoleAssignment.update({ where: { id: assignmentId }, data: { revokedAt } });
      await this.audit.record(tx, {
        action: 'platform.auth.role.revoke',
        entityType: 'auth_role_assignment',
        entityId: assignmentId,
        companyId: grant.companyId,
        before: { revokedAt: null },
        after: { revokedAt },
        reason,
      });
    });
  }

  /** Whether an active login account exists (for modules that link accounts to their data). */
  async exists(userId: string): Promise<boolean> {
    const user = await this.prisma.authUser.findUnique({
      where: { id: userId },
      select: { status: true },
    });
    return user?.status === 'active';
  }

  list(): Promise<UserSummary[]> {
    return this.prisma.authUser.findMany({
      orderBy: { username: 'asc' },
      select: { id: true, username: true, status: true, contactChannel: true },
    });
  }

  private async assertPasswordPolicy(password: string): Promise<void> {
    const minLength = await this.config.get(AuthSettings.passwordMinLength);
    if (password.length < minLength) {
      throw new BadRequestException(`Password must be at least ${minLength} characters`);
    }
  }

  private async requireUser(tx: Tx, userId: string): Promise<void> {
    if (!(await tx.authUser.findUnique({ where: { id: userId }, select: { id: true } }))) {
      throw new NotFoundException('User not found');
    }
  }
}
