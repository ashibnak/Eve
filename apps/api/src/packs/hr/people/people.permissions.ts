import type { RoleDefinition } from '../../../platform/auth/roles';

export const PeoplePermissions = {
  read: 'people.person.read',
  write: 'people.person.write',
  import: 'people.person.import',
} as const;

/**
 * HR's personnel-records officer (product-owner decision, S4): reads, imports and corrects the
 * people of their company (or of the whole customer). System administrators hold no people data.
 */
export const PeopleDataOwnerRole: RoleDefinition = {
  name: 'people_data_owner',
  permissions: [PeoplePermissions.read, PeoplePermissions.write, PeoplePermissions.import],
  allowedScopes: ['customer', 'company'],
};
