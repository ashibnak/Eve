import { peopleDirectory } from '../adapters/people-directory.adapter';

export const managerOf = (id: string): string => peopleDirectory.get(id).id;
