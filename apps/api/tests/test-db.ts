/**
 * Where the test database lives. Same Postgres container as development, different database,
 * so tests never touch your dev data. Override with TEST_DATABASE_URL / TEST_ADMIN_DATABASE_URL.
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://medchain:medchain_dev_pw@localhost:5433/medchain_test';

// Any existing database on the same server, used only to DROP/CREATE the test database.
export const TEST_ADMIN_DATABASE_URL =
  process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://medchain:medchain_dev_pw@localhost:5433/medchain';
