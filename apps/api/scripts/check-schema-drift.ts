/**
 * CI check: applies every migration to a fresh database and fails if schema.prisma does not
 * describe the result. Migrations are hand-written SQL, so this keeps the two from drifting.
 * Constraints Prisma cannot express (CHECK, triggers, partial indexes) are invisible to it.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { createTestDatabase, dropTestDatabase } from '../test/database';

async function main(): Promise<void> {
  const apiRoot = join(__dirname, '..');
  // Only the migrations: no test-only tables.
  const db = await createTestDatabase(`eve_test_drift_${Date.now().toString(36)}`, {
    testTables: false,
  });
  try {
    const diff = spawnSync(
      process.execPath,
      [
        join(apiRoot, 'node_modules/prisma/build/index.js'),
        'migrate',
        'diff',
        '--from-config-datasource',
        '--to-schema',
        'prisma/schema.prisma',
        '--script',
        '--exit-code',
      ],
      {
        cwd: apiRoot,
        env: { ...process.env, MIGRATION_DATABASE_URL: db.ownerUrl },
        encoding: 'utf8',
      },
    );
    if (diff.status === 0) {
      console.log('schema.prisma matches the migrations');
      return;
    }
    console.error(
      diff.status === 2
        ? `schema.prisma differs from the migrations. SQL needed to match schema.prisma:\n${diff.stdout}`
        : `prisma migrate diff failed:\n${diff.stdout}\n${diff.stderr}`,
    );
    process.exitCode = 1;
  } finally {
    await dropTestDatabase(db.name);
  }
}

void main();
