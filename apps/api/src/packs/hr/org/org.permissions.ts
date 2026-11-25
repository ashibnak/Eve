import type { RoleDefinition } from '../../../platform/auth/roles';

export const OrgPermissions = {
  read: 'org.structure.read',
} as const;

/**
 * The structure expert of spec §2 (کارشناس ساختار): reads the structure of their company (or the
 * whole customer) and the people in it. Changing the structure comes with S7/S8.
 */
export const OrgDataOwnerRole: RoleDefinition = {
  name: 'org_data_owner',
  permissions: [OrgPermissions.read, 'people.person.read'],
  allowedScopes: ['customer', 'company'],
};
