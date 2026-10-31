/**
 * Central config: loads env vars once, validates them with zod, and exports a typed object.
 * If a required variable is missing, the app fails fast at startup with a clear message.
 * Every name used here must also be listed in .env.example (never commit real secrets).
 */
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

// Load .env from the folder you run the API from, and warn about the two classic mistakes:
// no .env file there at all, or the same variable written twice (the LAST one silently wins).
const envPath = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  const seen = new Map<string, number>();
  fs.readFileSync(envPath, 'utf8')
    .split(/\r?\n/)
    .forEach((line, i) => {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
      if (!m) return;
      if (seen.has(m[1])) {
        console.warn(`⚠️  .env: ${m[1]} is defined twice (lines ${seen.get(m[1])} and ${i + 1}); line ${i + 1} wins.`);
      }
      seen.set(m[1], i + 1);
    });
  dotenv.config({ path: envPath });
} else if (process.env.NODE_ENV !== 'production') {
  console.warn(`⚠️  No .env file found at ${envPath} (copy .env.example to .env in this folder).`);
}

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),

  // YugabyteDB / Postgres (YSQL is Postgres-compatible, so the same driver works for both)
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  // true for hosted databases that require SSL (Render external URL, YugabyteDB Aeon). Local Docker: false.
  DATABASE_SSL: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  // Hosts without a shell (Render free tier): apply migrations / insert demo data automatically at startup.
  RUN_MIGRATIONS_ON_START: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  SEED_DEMO_DATA: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  // HOSTED HACKATHON DEMO ONLY: accept DEMO_OTP (123456) and allow demo seeding even when NODE_ENV=production.
  // Anyone who knows a patient ID could then log in as them, so never enable this with real data.
  DEMO_MODE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  // MongoDB Atlas (used from Step 6; optional until then)
  MONGO_URI: z.string().optional(),
  MONGO_DB_NAME: z.string().default('medchain'),

  // Security (used from Step 3 onwards). Placeholder defaults are dev-only; production must set real values.
  JWT_SECRET: z.string().min(16).default('dev-only-change-me-please-0000'),
  JWT_EXPIRES_IN: z.string().default('8h'),
  IDENTIFIER_SALT: z.string().min(16).default('dev-only-salt-change-me-0000'),

  // OTP (Step 4). Fixed demo OTP is honoured ONLY when NODE_ENV=development.
  DEMO_OTP: z.string().default('123456'),
  OTP_TTL_SECONDS: z.coerce.number().default(300),
  OTP_MAX_ATTEMPTS: z.coerce.number().default(5),                // wrong guesses before an OTP is locked
  OTP_RESEND_COOLDOWN_SECONDS: z.coerce.number().default(30),    // min gap between two OTPs to one mobile
  OTP_MAX_SENDS_PER_WINDOW: z.coerce.number().default(3),        // max OTPs to one mobile per window
  OTP_SEND_WINDOW_MINUTES: z.coerce.number().default(15),
  // 'console' = print the code in the server log (simulated, demo). 'n8n' = POST it to N8N_OTP_WEBHOOK_URL (WhatsApp/SMS).
  OTP_DELIVERY: z.enum(['console', 'n8n']).default('console'),
  N8N_OTP_WEBHOOK_URL: z.string().optional(),

  // Consent (Step 5)
  CONSENT_DEFAULT_HOURS: z.coerce.number().default(24),
  CONSENT_MAX_HOURS: z.coerce.number().default(72),

  // Member 3's Solana service (chain record contract). Sent as the X-API-Key header.
  SOLANA_SERVICE_API_KEY: z.string().optional(),
  SOLANA_TIMEOUT_MS: z.coerce.number().default(8000),
  CHAIN_SYNC_INTERVAL_SECONDS: z.coerce.number().default(60), // how often pending chain writes are re-checked
  // Anchor each staff view of a patient's records on Solana (Step 7). Set to false to keep logs off-chain.
  ACCESS_LOG_TO_CHAIN: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  // Integrations (Steps 5-8)
  N8N_UPLOAD_WEBHOOK_URL: z.string().optional(),
  SOLANA_SERVICE_URL: z.string().optional(),
  SERVICE_API_KEY: z.string().optional(), // shared key for n8n -> API calls

  // Records & file storage (Step 6)
  MAX_UPLOAD_MB: z.coerce.number().default(10),
  // 'local' = files on disk in STORAGE_DIR (dev). 's3' = Vultr Object Storage (S3-compatible, production).
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_DIR: z.string().default('./storage'),
  S3_ENDPOINT: z.string().optional(), // e.g. https://blr1.vultrobjects.com
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  // Public base URL of this API, used in links handed to n8n (file download + parsed-results callback).
  API_PUBLIC_URL: z.string().default('http://localhost:4000'),

  CORS_ORIGIN: z.string().default('*'),
  // Set to true ONLY when running behind a reverse proxy (Nginx). Then rate limits use the real client IP
  // from X-Forwarded-For instead of the proxy's IP. Leave false locally (otherwise clients could fake their IP).
  TRUST_PROXY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

// Treat blank values ("DEMO_MODE=" in .env, or an empty field in a hosting dashboard) as "not set",
// so the default applies instead of failing validation. Required values still fail with a clear message.
const nonEmptyEnv = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined && v.trim() !== ''));

const parsed = EnvSchema.safeParse(nonEmptyEnv);
if (!parsed.success) {
  console.error('❌ Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`   - ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const config = parsed.data;
export const isDev = config.NODE_ENV === 'development';
export const isProd = config.NODE_ENV === 'production';

/** Fixed demo OTP accepted: always in development, and on a hosted demo only if DEMO_MODE=true. */
export const demoOtpAllowed = isDev || config.DEMO_MODE;

if (config.DEMO_MODE && !isDev) {
  console.warn('⚠️  DEMO_MODE is ON: the fixed demo OTP is accepted. Use only with fake demo data.');
}

// Refuse to start in production with the dev placeholder secrets.
if (isProd && (config.JWT_SECRET.startsWith('dev-only') || config.IDENTIFIER_SALT.startsWith('dev-only'))) {
  console.error('❌ JWT_SECRET and IDENTIFIER_SALT must be set to real values in production.');
  process.exit(1);
}
