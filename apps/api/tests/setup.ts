/**
 * Runs before each test file (after env.ts):
 *  - replaces OTP delivery with an in-memory capture, so tests can read the code that was "sent"
 *  - resets the in-memory per-IP rate limits before every test
 *  - closes the DB pool when the file is done
 */
import { afterAll, beforeEach, vi } from 'vitest';

vi.mock('../src/otp/sender', async () => {
  const { sentOtps } = await import('./otp-capture');
  return {
    deliverOtp: async (mobile: string, code: string) => {
      sentOtps.set(mobile, code);
    },
  };
});

beforeEach(async () => {
  const { resetRateLimits } = await import('../src/middleware/rateLimit');
  resetRateLimits();
});

afterAll(async () => {
  const { pool } = await import('../src/db/yugabyte');
  await pool.end();
});
