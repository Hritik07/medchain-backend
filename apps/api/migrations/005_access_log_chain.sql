-- 005_access_log_chain.sql
-- Access log, aligned with Member 3's POST /access-log contract:
--   {log_id, doctor_id, patient_id_token, document_id, accessed_at, action}
-- Only views by OTHER people (doctor/pharmacy/lab) are anchored on Solana; a patient viewing their own records
-- is logged locally with chain_status NULL ("not sent by design").

ALTER TABLE access_logs ADD COLUMN IF NOT EXISTS document_id TEXT;      -- entry id, or 'timeline' for a full timeline view
ALTER TABLE access_logs ADD COLUMN IF NOT EXISTS chain_status TEXT;     -- NULL = not anchored by design
ALTER TABLE access_logs ADD COLUMN IF NOT EXISTS chain_queue_id TEXT;
ALTER TABLE access_logs ADD COLUMN IF NOT EXISTS chain_record JSONB;    -- exact body sent to POST /access-log

-- More precise actions than Step 2 had.
ALTER TABLE access_logs DROP CONSTRAINT IF EXISTS access_logs_action_check;
ALTER TABLE access_logs ADD CONSTRAINT access_logs_action_check
  CHECK (action IN ('view_timeline', 'view_record', 'view_file', 'verify_record', 'upload'));

ALTER TABLE access_logs DROP CONSTRAINT IF EXISTS access_logs_chain_status_check;
ALTER TABLE access_logs ADD CONSTRAINT access_logs_chain_status_check
  CHECK (chain_status IS NULL OR chain_status IN ('confirmed', 'chain_pending', 'not_recorded'));

CREATE INDEX IF NOT EXISTS idx_access_logs_chain_pending ON access_logs (chain_status)
  WHERE chain_status IN ('chain_pending', 'not_recorded');
