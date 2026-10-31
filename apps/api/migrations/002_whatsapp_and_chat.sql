-- 002_whatsapp_and_chat.sql
-- WhatsApp phone links (Step 8) and the fallback chatbot history used when Meko is unavailable.

-- ---------------------------------------------------------------------------
-- whatsapp_links: a patient's VERIFIED WhatsApp number. n8n resolves an incoming number -> patient_id here.
-- One active number per patient, and one patient per number.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS whatsapp_links (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id  UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  phone_e164  TEXT NOT NULL UNIQUE CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  verified_at TIMESTAMPTZ NOT NULL,                 -- row only exists after OTP verification
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- chat_history_fallback: last chatbot messages per patient, ONLY when Meko is down.
-- Patient can wipe it (right to erasure): DELETE FROM chat_history_fallback WHERE patient_id = $1.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chat_history_fallback (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  message    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chat_fallback_patient ON chat_history_fallback (patient_id, created_at DESC);
