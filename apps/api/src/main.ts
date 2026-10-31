/**
 * App entry: loads config, optionally prepares the database (hosts without a shell, e.g. Render),
 * starts the HTTP server, and shuts down cleanly (closes DB pools) on Ctrl+C / docker stop.
 */
import path from 'node:path';
import type { Server } from 'node:http';
import { config } from './config';
import { createApp } from './app';
import { pool } from './db/yugabyte';
import { applyMigrations } from './db/yugabyte/migrations';
import { seedDemoData } from './db/yugabyte/seed-data';
import { startChainSync } from './integrations/chain-sync';
import { closeMongo } from './db/mongo';

let server: Server | undefined;

async function prepareDatabase() {
  if (config.RUN_MIGRATIONS_ON_START) {
    const count = await applyMigrations(pool, path.resolve(process.cwd(), 'migrations'));
    console.log(count ? `🗄️  ${count} migration(s) applied at startup` : '🗄️  Database schema up to date');
  }
  if (config.SEED_DEMO_DATA) {
    await seedDemoData(); // idempotent: existing demo rows are left as they are
  }
}

async function start() {
  try {
    await prepareDatabase();
  } catch (err) {
    console.error('❌ Database preparation failed, not starting:', (err as Error).message);
    await pool.end().catch(() => undefined);
    process.exit(1);
  }

  const app = createApp();
  server = app.listen(config.PORT, () => {
    console.log(`🩺 MedChain API listening on http://localhost:${config.PORT} (${config.NODE_ENV})`);
    startChainSync(); // finishes pending Solana writes in the background
  });

  // Friendly message instead of a crash dump when the port is taken (e.g. the Docker API container is already running).
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`❌ Port ${config.PORT} is already in use. Stop the other process (docker compose stop api) or set PORT=4001 in .env.`);
      process.exit(1);
    }
    throw err;
  });
}

async function shutdown(signal: string) {
  console.log(`${signal} received, shutting down...`);
  server?.close();
  await pool.end().catch(() => undefined);
  await closeMongo();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

void start();
