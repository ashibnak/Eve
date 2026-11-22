import type { TestProject } from 'vitest/node';
import {
  createTestDatabase,
  dropTestDatabase,
  type TestDatabase,
  uniqueTestDatabaseName,
} from './database';

declare module 'vitest' {
  export interface ProvidedContext {
    db: TestDatabase;
  }
}

/** One fresh, fully migrated database for the whole integration run; dropped afterwards. */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const db = await createTestDatabase(uniqueTestDatabaseName());
  project.provide('db', db);
  return () => dropTestDatabase(db.name);
}
