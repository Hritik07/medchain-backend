/**
 * Test runner config. `npm test` runs tests/*.test.ts against a throwaway database `medchain_test`
 * on the same local Postgres (docker compose up -d db). Mongo, Solana and n8n are switched off for tests.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/global-setup.ts'],        // creates + migrates medchain_test once per run
    setupFiles: ['tests/env.ts', 'tests/setup.ts'], // env first (config reads it on import), then mocks/hooks
    fileParallelism: false,                         // one file at a time: simple, deterministic DB use
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
