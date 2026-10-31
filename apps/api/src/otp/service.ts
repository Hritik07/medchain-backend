/**
 * OTP core logic, reused by patient login/registration (Step 4), consent (Step 5) and phone linking (Step 8).
 *   createOtp() -> checks per-mobile limits, stores an HMAC of a random 6-digit code, delivers it
 *   verifyOtp() -> checks expiry / already-used / attempt limit, compares the code, marks it used (one-time)
 * DEMO_OTP (default 123456) is also accepted in development, or on a hosted demo with DEMO_MODE=true.
 */
import crypto from 'node:crypto';
import { config, demoOtpAllowed } from '../config';
import { query } from '../db/yugabyte';
import { AppError } from '../middleware/errors';
import { deliverOtp } from './sender';

export type OtpPurpose = 'patient_login' | 'patient_register' | 'consent' | 'phone_link';

export interface OtpRow {
  id: string;
  purpose: OtpPurpose;
  mobile: string;
  user_id: string | null;
  requested_by: string | null;
  code_hash: string;
  context: Record<string, unknown>;
  attempts: number;
  expires_at: Date;
  consumed_at: Date | null;
}

/** Accepts "9876543210", "+91 98765 43210", "09876543210" -> "+919876543210". Throws INVALID_MOBILE otherwise. */
export function normalizeMobile(raw: string): string {
  let digits = String(raw ?? '').replace(/[\s()-]/g, '');
  if (/^0\d{10}$/.test(digits)) digits = digits.slice(1);
  if (/^[6-9]\d{9}$/.test(digits)) return `+91${digits}`;
  if (/^\+91[6-9]\d{9}$/.test(digits)) return digits;
  if (/^91[6-9]\d{9}$/.test(digits)) return `+${digits}`;
  throw new AppError(400, 'INVALID_MOBILE', 'Enter a valid 10-digit Indian mobile number');
}

/** "+919999900001" -> "+91XXXXXX0001" for showing which number got the OTP. */
export function maskMobile(mobile: string): string {
  return `${mobile.slice(0, 3)}XXXXXX${mobile.slice(-4)}`;
}

// The HMAC binds the code to its OTP id, so a code from one request can't be replayed on another.
function hashCode(otpId: string, code: string): string {
  return crypto.createHmac('sha256', config.JWT_SECRET).update(`${otpId}:${code}`).digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

export async function createOtp(input: {
  purpose: OtpPurpose;
  mobile: string;
  userId?: string | null;
  requestedBy?: string | null;
  context?: Record<string, unknown>;
}) {
  // 1. Per-mobile limits: cooldown between sends + max sends per window.
  const { rows } = await query<{ recent: string; last_sent: Date | null }>(
    `SELECT count(*) AS recent, max(created_at) AS last_sent
       FROM otp_requests
      WHERE mobile = $1 AND created_at > now() - make_interval(mins => $2::int)`,
    [input.mobile, config.OTP_SEND_WINDOW_MINUTES],
  );
  const recent = Number(rows[0].recent);
  const lastSent = rows[0].last_sent ? new Date(rows[0].last_sent).getTime() : 0;
  const cooldownLeft = Math.ceil((lastSent + config.OTP_RESEND_COOLDOWN_SECONDS * 1000 - Date.now()) / 1000);

  if (cooldownLeft > 0) {
    throw new AppError(429, 'OTP_COOLDOWN', `Please wait ${cooldownLeft}s before requesting another OTP`, {
      retryAfterSeconds: cooldownLeft,
    });
  }
  if (recent >= config.OTP_MAX_SENDS_PER_WINDOW) {
    throw new AppError(429, 'OTP_SEND_LIMIT', `Too many OTPs sent to this number. Try again in ${config.OTP_SEND_WINDOW_MINUTES} minutes`);
  }

  // 2. Generate + store (only the hash).
  const otpId = crypto.randomUUID();
  const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
  const expiresAt = new Date(Date.now() + config.OTP_TTL_SECONDS * 1000);

  await query(
    `INSERT INTO otp_requests (id, purpose, mobile, user_id, requested_by, code_hash, context, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [otpId, input.purpose, input.mobile, input.userId ?? null, input.requestedBy ?? null,
     hashCode(otpId, code), JSON.stringify(input.context ?? {}), expiresAt],
  );

  // 3. Deliver. If delivery fails, expire the row so it doesn't count as a usable OTP.
  try {
    await deliverOtp(input.mobile, code, input.purpose);
  } catch (err) {
    await query('UPDATE otp_requests SET expires_at = now() WHERE id = $1', [otpId]).catch(() => undefined);
    throw err;
  }

  return { otpId, expiresAt: expiresAt.toISOString(), sentTo: maskMobile(input.mobile) };
}

/** Returns the consumed OTP row (with its context) on success; throws a clear OTP_* error otherwise. */
export async function verifyOtp(input: { otpId: string; code: string; purpose: OtpPurpose }): Promise<OtpRow> {
  if (!/^[0-9a-f-]{36}$/i.test(input.otpId)) {
    throw new AppError(404, 'OTP_NOT_FOUND', 'OTP request not found');
  }
  const { rows } = await query<OtpRow>('SELECT * FROM otp_requests WHERE id = $1 AND purpose = $2', [
    input.otpId,
    input.purpose,
  ]);
  const otp = rows[0];
  const max = config.OTP_MAX_ATTEMPTS;

  if (!otp) throw new AppError(404, 'OTP_NOT_FOUND', 'OTP request not found');
  if (otp.consumed_at) throw new AppError(409, 'OTP_ALREADY_USED', 'This OTP has already been used');
  if (new Date(otp.expires_at).getTime() <= Date.now()) {
    throw new AppError(410, 'OTP_EXPIRED', 'This OTP has expired, please request a new one');
  }
  if (otp.attempts >= max) {
    throw new AppError(429, 'OTP_LOCKED', 'Too many wrong attempts, please request a new OTP');
  }

  const code = String(input.code ?? '').trim();
  const matches = safeEqual(hashCode(otp.id, code), otp.code_hash) || (demoOtpAllowed && code === config.DEMO_OTP);

  if (!matches) {
    // Atomic increment so parallel guesses can't exceed the limit.
    const upd = await query<{ attempts: number }>(
      'UPDATE otp_requests SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts',
      [otp.id],
    );
    const attemptsLeft = Math.max(0, max - upd.rows[0].attempts);
    if (attemptsLeft === 0) {
      throw new AppError(429, 'OTP_LOCKED', 'Too many wrong attempts, please request a new OTP');
    }
    throw new AppError(400, 'OTP_INVALID', 'Incorrect OTP', { attemptsLeft });
  }

  // Mark used. The WHERE clause makes this one-time even if two correct verifies race.
  const consumed = await query<OtpRow>(
    `UPDATE otp_requests SET consumed_at = now()
      WHERE id = $1 AND consumed_at IS NULL AND expires_at > now() AND attempts < $2
      RETURNING *`,
    [otp.id, max],
  );
  if (!consumed.rows[0]) throw new AppError(409, 'OTP_ALREADY_USED', 'This OTP has already been used');
  return consumed.rows[0];
}
