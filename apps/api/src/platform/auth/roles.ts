import { Injectable } from '@nestjs/common';

export type ScopeKind = 'customer' | 'company' | 'unit';

/** A named bundle of permissions and the scope kinds it may be granted with. */
export interface RoleDefinition {
  name: string;
  permissions: readonly string[];
  allowedScopes: readonly ScopeKind[];
}

/** Platform permissions. Packs register their own (e.g. `org.position.read`) with their roles. */
export const Permissions = {
  configRead: 'platform.config.read',
  configWrite: 'platform.config.write',
  usersManage: 'platform.users.manage',
  companyRead: 'platform.company.read',
  companyManage: 'platform.company.manage',
  auditRead: 'platform.audit.read',
  usageRead: 'platform.usage.read',
} as const;

/**
 * Customer system administrator: settings, users, role grants, the company registry and the
 * aggregate usage report. No business data and no audit log (product-owner decision, S1).
 */
export const SystemAdminRole: RoleDefinition = {
  name: 'system_admin',
  permissions: [
    Permissions.configRead,
    Permissions.configWrite,
    Permissions.usersManage,
    Permissions.companyRead,
    Permissions.companyManage,
    Permissions.usageRead,
  ],
  allowedScopes: ['customer'],
};

/** Auditor: read-only, including the audit log, customer-wide or for chosen companies. */
export const AuditorRole: RoleDefinition = {
  name: 'auditor',
  permissions: [Permissions.auditRead, Permissions.configRead, Permissions.companyRead],
  allowedScopes: ['customer', 'company'],
};

/** Roles by name. The platform registers only system_admin and auditor; packs add theirs. */
@Injectable()
export class RoleRegistry {
  private readonly roles = new Map<string, RoleDefinition>();

  constructor() {
    this.register(SystemAdminRole, AuditorRole);
  }

  register(...roles: RoleDefinition[]): void {
    for (const role of roles) {
      if (!/^[a-z][a-z0-9_]*$/.test(role.name)) throw new Error(`Invalid role name "${role.name}"`);
      const existing = this.roles.get(role.name);
      if (existing && existing !== role) throw new Error(`Role ${role.name} is already registered`);
      this.roles.set(role.name, role);
    }
  }

  get(name: string): RoleDefinition {
    const role = this.roles.get(name);
    if (!role) throw new Error(`Role ${name} is not registered`);
    return role;
  }

  has(name: string): boolean {
    return this.roles.has(name);
  }

  /** Role names that carry a permission. */
  rolesWith(permission: string): string[] {
    return [...this.roles.values()]
      .filter((r) => r.permissions.includes(permission))
      .map((r) => r.name);
  }
}
