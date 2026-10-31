/**
 * Abnormal-value flagging in PLAIN CODE (the AI only extracts numbers; it never decides High/Low).
 * Compares the patient's value with the reference range printed on that same report.
 * Anything not cleanly numeric is 'unknown' rather than guessed.
 */
import type { LabStatus } from '../db/mongo';

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

export function flagLabValue(value: unknown, rangeLow: unknown, rangeHigh: unknown): LabStatus {
  const v = toNumber(value);
  const low = toNumber(rangeLow);
  const high = toNumber(rangeHigh);
  if (v === null || (low === null && high === null)) return 'unknown';
  if (high !== null && v > high) return 'high';
  if (low !== null && v < low) return 'low';
  return 'normal';
}

export { toNumber };
