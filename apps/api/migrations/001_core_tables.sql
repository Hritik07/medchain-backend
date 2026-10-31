-- 001_core_tables.sql
-- Core identity + consent tables for MedChain (YugabyteDB YSQL / Postgres-compatible).
-- Rules: no raw Aadhaar anywhere (only a salted hash), only hashes go to Solana, and
-- patient-owned rows cascade on delete so "right to erasure" (DPDP) is one DELETE.

-- gen_random_uuid() lives in pgcrypto on YugabyteDB; on Postgres 13+ it's built in (this is then a no-op).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- providers: doctors' clinics, pharmacies and diagnostic centres. Admin verifies them (Step 9).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS providers (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type                TEXT NOT NULL CHECK (type IN ('doctor', 'pharmacy', 'diagnostic')),
  name                TEXT NOT NULL,
  registration_number TEXT,                    -- e.g. medical council / drug licence no. (fake in demo)
  verified_status     TEXT NOT NULL DEFAULT 'pending'
                        CHECK (verified_status IN ('pending', 'verified', 'rejected')),
  verified_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- users: everyone who logs in. Patients are found by hashed_identifier (salted SHA-256 of Aadhaar-based ID).
-- Staff (doctor/pharmacy/diagnostic) link to a provider; admins don't.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role              TEXT NOT NULL CHECK (role IN ('patient', 'doctor', 'pharmacy', 'diagnostic', 'admin')),
  name              TEXT,
  hashed_identifier TEXT UNIQUE,               -- patients only; NEVER the raw Aadhaar
  mobile            TEXT,                      -- E.164 format (+91...), needed to send the OTP
  email             TEXT UNIQUE,               -- staff/admin login
  password_hash     TEXT,                      -- bcrypt; NULL for OTP-only patients
  provider_id       UUID REFERENCES providers(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A patient must have a hashed identifier; staff must belong to a provider.
  CONSTRAINT patient_has_identifier CHECK (role <> 'patient' OR hashed_identifier IS NOT NULL),
  CONSTRAINT staff_has_provider CHECK (role NOT IN ('doctor', 'pharmacy', 'diagnostic') OR provider_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_users_mobile ON users (mobile);

-- ---------------------------------------------------------------------------
-- consent_grants: patient (via OTP) lets one accessor see their timeline until expires_at.
-- A grant is valid only if: revoked_at IS NULL AND now() < expires_at. Checked on EVERY record read.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS consent_grants (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  accessor_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose      TEXT NOT NULL DEFAULT 'treatment',   -- DPDP purpose limitation
  granted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ,
  consent_hash TEXT,                                -- SHA-256 of the consent event (what goes on-chain)
  solana_tx    TEXT,                                -- devnet transaction signature; NULL if chain write pending/failed
  CONSTRAINT expiry_after_grant CHECK (expires_at > granted_at),
  CONSTRAINT not_self_grant CHECK (patient_id <> accessor_id)
);
CREATE INDEX IF NOT EXISTS idx_consent_lookup ON consent_grants (patient_id, accessor_id, expires_at);

-- ---------------------------------------------------------------------------
-- access_logs: one row per timeline read / upload. Patient sees these in "Who viewed my records".
-- grant_id is NULL when the patient views their own records.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS access_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  accessor_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  grant_id    UUID REFERENCES consent_grants(id) ON DELETE SET NULL,
  action      TEXT NOT NULL DEFAULT 'view_timeline' CHECK (action IN ('view_timeline', 'view_record', 'upload')),
  record_ids  TEXT[] NOT NULL DEFAULT '{}',         -- MongoDB timeline_entry ids (as strings)
  viewed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  entry_hash  TEXT,                                 -- optional SHA-256 of this log row for Solana
  solana_tx   TEXT
);
CREATE INDEX IF NOT EXISTS idx_access_logs_patient ON access_logs (patient_id, viewed_at DESC);
