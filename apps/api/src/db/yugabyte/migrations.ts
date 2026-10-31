/**
 * Migration logic as a plain function (no config import), so both the CLI (`npm run migrate`)
 * and the test setup can use it. Applies each migrations/NNN_*.sql once, in filename order,
 * recording applied files in schema_migrations.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Pool } from 'pg';

export async function applyMigrations(pool: Pool, dir: string, log: (msg: string) => void = console.log): Promise<number> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

  const applied = new Set(
    (await pool.query<{ filename: string }>('SELECT filename FROM schema_migrations')).rows.map((r) => r.filename),
  );
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const client = await pool.connect();
    try {
      // YugabyteDB doesn't make DDL fully transactional; IF NOT EXISTS clauses make re-runs safe anyway.
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      log(`✅ applied ${file}`);
      count++;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      log(`❌ failed on ${file}: ${(err as Error).message}`);
      throw err;
    } finally {
      client.release();
    }
  }
  return count;
}
