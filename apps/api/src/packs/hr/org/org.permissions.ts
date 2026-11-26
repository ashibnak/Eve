import type { RoleDefinition } from '../../../platform/auth/roles';

export const OrgPermissions = {
  read: 'org.structure.read',
  /** Accept or reopen findings, start a rule run (S6). */
  manageFindings: 'org.finding.manage',
  /** Import the structure from a file (S7). */
  importStructure: 'org.structure.import',
  /** Register a company's org profile and unit levels (spec §2: the system administrator). */
  manageCompany: 'org.company.manage',
  /** Request a structure change (S8). */
  requestChange: 'org.structure.change',
  /** Correct a wrong entry in place (S8). */
  correct: 'org.structure.correct',
} as const;

/**
 * The structure expert of spec §2 (کارشناس ساختار): reads the structure of their company (or the
 * whole customer) and the people in it, and works the findings inbox. Changing the structure
 * comes with S7/S8.
 */
export const OrgDataOwnerRole: RoleDefinition = {
  name: 'org_data_owner',
  permissions: [
    OrgPermissions.read,
    OrgPermissions.manageFindings,
    OrgPermissions.importStructure,
    OrgPermissions.requestChange,
    OrgPermissions.correct,
    'people.person.read',
  ],
  allowedScopes: ['customer', 'company'],
};

/**
 * Approves structure changes and re-imports (spec §2 تأییدکنندهٔ تغییر ساختار; product-owner decision
 * 2026-11-25). Holding the role is what lets a person act on an approval step that names it; it
 * reads the structure it decides on. Fanap default: Group HR.
 */
export const OrgChangeApproverRole: RoleDefinition = {
  name: 'org_change_approver',
  permissions: [OrgPermissions.read],
  allowedScopes: ['customer', 'company'],
};
