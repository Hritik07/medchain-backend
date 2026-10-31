/**
 * CLI: `npm run seed` inserts the fake demo accounts (see seed-data.ts). Safe to re-run.
 */
import { pool } from './index';
import { seedDemoData } from './seed-data';

seedDemoData()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error('❌ Seed failed:', (err as Error).message);
    await pool.end();
    process.exit(1);
  });
