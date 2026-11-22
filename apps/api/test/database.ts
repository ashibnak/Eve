/**
 * Integration-test databases: a fresh database per run, set up exactly like production
 * (deploy/postgres/sql/*.sql), migrated as eve_owner, and used by tests as eve_app so the
 * grants are exercised for real.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

const apiRoot = join(__dirname, '..');
const sqlDir = join(apiRoot, '../../deploy/postgres/sql');

/** Superuser connection to the dev/test cluster (deploy/docker-compose.dev.yml). */
export const ADMIN_URL =
  process.env.TEST_DATABASE_ADMIN_URL ?? 'postgresql://postgres:postgres@127.0.0.1:15432/postgres';

const OWNER_PASSWORD = 'eve_owner_test';
const APP_PASSWORD = 'eve_app_test';

export interface TestDatabase {
  name: string;
  /** eve_app: what the application uses. */
  appUrl: string;
  /** eve_owner: migrations and deliberate tampering in tests. */
  ownerUrl: string;
}

function withDatabase(url: string, database: string, user?: string, password?: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  if (user) parsed.username = user;
  if (password) parsed.password = password;
  return parsed.toString();
}

async function withClient<T>(url: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url });
  try {
    await client.connect();
  } catch (error) {
    throw new Error(
      `Cannot reach the test database at ${new URL(url).host}. Start it with "pnpm db:dev:up". (${String(error)})`,
    );
  }
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function createTestDatabase(name: string): Promise<TestDatabase> {
  if (!/^eve_test_[a-z0-9_]+$/.test(name)) throw new Error(`Refusing test database name ${name}`);
  await withClient(ADMIN_URL, async (admin) => {
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.query(readFileSync(join(sqlDir, 'roles.sql'), 'utf8'));
    await admin.query(`ALTER ROLE eve_owner PASSWORD '${OWNER_PASSWORD}'`);
    await admin.query(`ALTER ROLE eve_app PASSWORD '${APP_PASSWORD}'`);
  });
  await withClient(withDatabase(ADMIN_URL, name), (db) =>
    db.query(readFileSync(join(sqlDir, 'database.sql'), 'utf8')),
  );

  const ownerUrl = withDatabase(ADMIN_URL, name, 'eve_owner', OWNER_PASSWORD);
  const appUrl = withDatabase(ADMIN_URL, name, 'eve_app', APP_PASSWORD);
  const migrate = spawnSync(
    process.execPath,
    [join(apiRoot, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'],
    { cwd: apiRoot, env: { ...process.env, MIGRATION_DATABASE_URL: ownerUrl }, encoding: 'utf8' },
  );
  if (migrate.status !== 0) {
    throw new Error(`prisma migrate deploy failed:\n${migrate.stdout}\n${migrate.stderr}`);
  }
  return { name, appUrl, ownerUrl };
}

export async function dropTestDatabase(name: string): Promise<void> {
  await withClient(ADMIN_URL, (admin) =>
    admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`),
  );
}

export function uniqueTestDatabaseName(): string {
  return `eve_test_${Date.now().toString(36)}_${process.pid}`;
}
