/**
 * Turns an Aadhaar-based ID into a salted, one-way hash (HMAC-SHA256 with IDENTIFIER_SALT).
 * This is the ONLY form we ever store or compare. The raw number is never saved, logged or returned.
 * Same input + same salt => same hash, so a doctor typing the ID finds the right patient.
 */
import crypto from 'node:crypto';
import { config } from '../config';
import { AppError } from '../middleware/errors';

/** Strips spaces/dashes and checks it's 12 digits. Throws INVALID_IDENTIFIER otherwise. */
export function normalizeIdentifier(raw: string): string {
  const digits = String(raw ?? '').replace(/[\s-]/g, '');
  if (!/^\d{12}$/.test(digits)) {
    throw new AppError(400, 'INVALID_IDENTIFIER', 'Patient identifier must be 12 digits');
  }
  return digits;
}

export function hashIdentifier(raw: string): string {
  const normalized = normalizeIdentifier(raw);
  return crypto.createHmac('sha256', config.IDENTIFIER_SALT).update(normalized).digest('hex');
}

/** For display only, e.g. "XXXX-XXXX-9012". Never return more than the last 4 digits. */
export function maskIdentifier(raw: string): string {
  return `XXXX-XXXX-${normalizeIdentifier(raw).slice(-4)}`;
}
