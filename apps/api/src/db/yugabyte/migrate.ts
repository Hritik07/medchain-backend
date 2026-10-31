/**
 * CLI: `npm run migrate` (dev) or `npm run migrate:prod` (Docker image / server).
 * Applies pending migrations/NNN_*.sql files once each; safe to re-run.
 */
import path from 'node:path';
import { pool } from './index';
import { applyMigrations } from './migrations';

applyMigrations(pool, path.resolve(process.cwd(), 'migrations'))
  .then((count) => console.log(count ? `Done: ${count} migration(s) applied.` : 'Database already up to date.'))
  .then(() => pool.end())
  .catch(async () => {
    await pool.end();
    process.exit(1);
  });
