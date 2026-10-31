/**
 * Test environment. Must load BEFORE anything from src/ (config validates env on import),
 * which is why this file imports nothing from src/. Values here win over apps/api/.env.
 */
import { TEST_DATABASE_URL } from './test-db';

Object.assign(process.env, {
  NODE_ENV: 'test', // NOT development: the fixed demo OTP 123456 is rejected, exactly like production
  DATABASE_URL: TEST_DATABASE_URL,
  JWT_SECRET: 'test-only-jwt-secret-0123456789',
  IDENTIFIER_SALT: 'test-only-salt-0123456789abcd',
  SERVICE_API_KEY: 'test-service-key',
  // External services off: chain writes become not_recorded, no Mongo, no n8n.
  MONGO_URI: '',
  SOLANA_SERVICE_URL: '',
  N8N_UPLOAD_WEBHOOK_URL: '',
  N8N_OTP_WEBHOOK_URL: '',
  OTP_DELIVERY: 'console',
  ACCESS_LOG_TO_CHAIN: 'false',
  // OTP limits: no resend cooldown by default (tests switch it on where needed), 3 sends per window.
  OTP_RESEND_COOLDOWN_SECONDS: '0',
  OTP_MAX_SENDS_PER_WINDOW: '3',
  OTP_SEND_WINDOW_MINUTES: '15',
  OTP_MAX_ATTEMPTS: '5',
  OTP_TTL_SECONDS: '300',
  CONSENT_DEFAULT_HOURS: '24',
  CONSENT_MAX_HOURS: '72',
});
