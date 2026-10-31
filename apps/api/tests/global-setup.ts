/**
 * Runs once before all tests: recreate `medchain_test` from scratch and apply every migration.
 * A clean database each run means tests never depend on leftovers.
 */
import path from 'node:path';
import { Pool } from 'pg';
import { applyMigrations } from '../src/db/yugabyte/migrations';
import { TEST_ADMIN_DATABASE_URL, TEST_DATABASE_URL } from './test-db';

export default async function globalSetup() {
  const dbName = new URL(TEST_DATABASE_URL).pathname.slice(1);
  if (!/^[a-z0-9_]+$/.test(dbName) || !dbName.includes('test')) {
    throw new Error(`Refusing to reset "${dbName}": the test database name must contain "test".`);
  }

  const admin = new Pool({ connectionString: TEST_ADMIN_DATABASE_URL, max: 1 });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${dbName}`);
  } catch (err) {
    throw new Error(
      `Could not reset the test database. Is the db container running? (docker compose up -d db)\n${(err as Error).message}`,
    );
  } finally {
    await admin.end();
  }

  const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 2 });
  try {
    // npm test runs from apps/api, so migrations/ is relative to the current folder.
    await applyMigrations(pool, path.resolve(process.cwd(), 'migrations'), () => undefined);
  } finally {
    await pool.end();
  }
}
