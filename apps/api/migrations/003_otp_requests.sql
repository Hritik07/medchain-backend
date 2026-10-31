-- 003_otp_requests.sql
-- One row per OTP sent. The code itself is never stored, only an HMAC of it (code_hash).
-- Reused by: patient login, patient self-registration (Step 4), consent (Step 5), WhatsApp phone linking (Step 8).

CREATE TABLE IF NOT EXISTS otp_requests (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose      TEXT NOT NULL CHECK (purpose IN ('patient_login', 'patient_register', 'consent', 'phone_link')),
  mobile       TEXT NOT NULL,                                       -- where the OTP was sent (E.164)
  user_id      UUID REFERENCES users(id) ON DELETE CASCADE,         -- patient it concerns (NULL during registration)
  requested_by UUID REFERENCES users(id) ON DELETE SET NULL,        -- e.g. the doctor asking for consent
  code_hash    TEXT NOT NULL,
  context      JSONB NOT NULL DEFAULT '{}'::jsonb,                  -- purpose-specific data (never the raw Aadhaar)
  attempts     INT NOT NULL DEFAULT 0,                              -- wrong guesses so far
  expires_at   TIMESTAMPTZ NOT NULL,
  consumed_at  TIMESTAMPTZ,                                         -- set once verified; an OTP works only once
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Used by the per-mobile send limit ("max N OTPs per window", "wait 30s before resending").
CREATE INDEX IF NOT EXISTS idx_otp_mobile_created ON otp_requests (mobile, created_at DESC);
