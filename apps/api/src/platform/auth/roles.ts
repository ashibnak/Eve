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
  rulesRead: 'platform.rules.read',
  rulesPropose: 'platform.rules.propose',
  documentsRead: 'platform.documents.read',
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
    Permissions.rulesRead,
    Permissions.rulesPropose,
  ],
  allowedScopes: ['customer'],
};

/** Auditor: read-only, including the audit log, customer-wide or for chosen companies. */
export const AuditorRole: RoleDefinition = {
  name: 'auditor',
  permissions: [
    Permissions.auditRead,
    Permissions.configRead,
    Permissions.companyRead,
    Permissions.documentsRead,
  ],
  allowedScopes: ['customer', 'company'],
};

/**
 * Approves customer rule-parameter changes (product-owner decision, S2), e.g. Group HR. Holding
 * the role is what lets a person act on an approval step that names it.
 */
export const RuleApproverRole: RoleDefinition = {
  name: 'rule_approver',
  permissions: [Permissions.rulesRead],
  allowedScopes: ['customer', 'company'],
};

/** Roles by name. The platform registers system_admin, auditor and rule_approver; packs add theirs. */
@Injectable()
export class RoleRegistry {
  private readonly roles = new Map<string, RoleDefinition>();
  /** Permissions packs added to roles they do not own (e.g. people.person.read for auditor). */
  private readonly extensions = new Map<string, Set<string>>();

  constructor() {
    this.register(SystemAdminRole, AuditorRole, RuleApproverRole);
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

  /**
   * Adds a pack's permissions to an existing role, e.g. people lets the platform's auditor read
   * people. Idempotent. The role definition itself stays as its owner wrote it.
   */
  extend(roleName: string, permissions: readonly string[]): void {
    this.get(roleName);
    const extra = this.extensions.get(roleName) ?? new Set<string>();
    for (const permission of permissions) extra.add(permission);
    this.extensions.set(roleName, extra);
  }

  /** Every permission a role carries: its own and those packs added. */
  permissionsOf(roleName: string): string[] {
    return [...this.get(roleName).permissions, ...(this.extensions.get(roleName) ?? [])];
  }

  /** Role names that carry a permission. */
  rolesWith(permission: string): string[] {
    return [...this.roles.keys()].filter((name) => this.permissionsOf(name).includes(permission));
  }
}
