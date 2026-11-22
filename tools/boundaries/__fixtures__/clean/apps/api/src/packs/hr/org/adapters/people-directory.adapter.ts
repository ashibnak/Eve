import { getPerson } from '../../people/service/index';
import type { PeopleDirectoryPort } from '../ports/people-directory.port';

export const peopleDirectory: PeopleDirectoryPort = { get: getPerson };
