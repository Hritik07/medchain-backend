/**
 * Shared constants: user roles and record sources used across modules.
 * Kept in one place so auth, consent and records all agree on the same names.
 */
export const ROLES = ['patient', 'doctor', 'pharmacy', 'diagnostic', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export const RECORD_SOURCES = ['provider', 'patient_uploaded'] as const;
export type RecordSource = (typeof RECORD_SOURCES)[number];

export const RECORD_TYPES = ['prescription', 'pharmacy_bill', 'lab_report', 'visit_note', 'other'] as const;
export type RecordType = (typeof RECORD_TYPES)[number];

/** Label the UI shows on self-uploaded entries (from the project brief). */
export const PATIENT_UPLOAD_LABEL = 'Patient-uploaded, unverified';
