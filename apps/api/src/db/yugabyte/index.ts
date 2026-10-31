/**
 * YugabyteDB connection pool (via the standard `pg` driver, since YSQL speaks the Postgres protocol).
 * Locally this points at the Postgres container; hosted it points at YugabyteDB or Render Postgres. Same code.
 * `query()` is the single helper the rest of the app uses for plain-SQL access.
 */
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { config } from '../../config';

/**
 * With DATABASE_SSL=true the connection is encrypted. Any ?sslmode=... in the URL is removed first,
 * because the pg driver lets the URL override our ssl setting (and strict sslmode rejects some hosts' certs).
 * rejectUnauthorized:false = encrypted but the server certificate isn't pinned; fine for a hackathon demo.
 */
function connectionString(): string {
  if (!config.DATABASE_SSL) return config.DATABASE_URL;
  try {
    const url = new URL(config.DATABASE_URL);
    ['sslmode', 'ssl', 'sslrootcert', 'sslcert', 'sslkey'].forEach((k) => url.searchParams.delete(k));
    return url.toString();
  } catch {
    return config.DATABASE_URL;
  }
}

export const pool = new Pool({
  connectionString: connectionString(),
  ssl: config.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000, // hosted DBs may take a moment; fail with a clear error instead of hanging
});

pool.on('error', (err) => console.error('Unexpected YugabyteDB pool error:', err));

export async function query<T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []) {
  return pool.query<T>(text, params);
}

/**
 * Runs several queries as one all-or-nothing unit (e.g. create provider + its first staff account).
 * Use the `client` passed to fn for every query inside, NOT the global query().
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Used by /health to confirm the database is reachable. */
export async function pingYugabyte(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch (err) {
    // Log the real cause (wrong port, DB not running, bad password...) to make debugging easy.
    console.error('YugabyteDB ping failed:', (err as Error).message);
    return false;
  }
}
