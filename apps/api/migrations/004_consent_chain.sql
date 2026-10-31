-- 004_consent_chain.sql
-- Chain bookkeeping for consent grants, following Member 3's chain record contract:
--   store solana_tx + chain_status (confirmed | chain_pending) + chain_queue_id when pending,
--   and keep the EXACT record that was hashed (timestamps byte-identical) so it can be re-verified later.
-- 'not_recorded' is our own extra status: the Solana service was unreachable, the API retries it later.
-- Separate ALTERs keep this friendly to YugabyteDB.

ALTER TABLE consent_grants ADD COLUMN IF NOT EXISTS chain_status TEXT NOT NULL DEFAULT 'not_recorded';
ALTER TABLE consent_grants ADD COLUMN IF NOT EXISTS chain_queue_id TEXT;
ALTER TABLE consent_grants ADD COLUMN IF NOT EXISTS chain_record JSONB;          -- exact body sent to POST /consent

ALTER TABLE consent_grants ADD COLUMN IF NOT EXISTS revoke_hash TEXT;
ALTER TABLE consent_grants ADD COLUMN IF NOT EXISTS revoke_solana_tx TEXT;
ALTER TABLE consent_grants ADD COLUMN IF NOT EXISTS revoke_chain_status TEXT;    -- NULL until revoked
ALTER TABLE consent_grants ADD COLUMN IF NOT EXISTS revoke_chain_queue_id TEXT;
ALTER TABLE consent_grants ADD COLUMN IF NOT EXISTS revoke_record JSONB;         -- exact body sent to POST /revoke

ALTER TABLE consent_grants DROP CONSTRAINT IF EXISTS consent_chain_status_check;
ALTER TABLE consent_grants ADD CONSTRAINT consent_chain_status_check
  CHECK (chain_status IN ('confirmed', 'chain_pending', 'not_recorded')
     AND (revoke_chain_status IS NULL OR revoke_chain_status IN ('confirmed', 'chain_pending', 'not_recorded')));

-- The background sync job looks for rows that still need a chain write / confirmation.
CREATE INDEX IF NOT EXISTS idx_consent_chain_pending ON consent_grants (chain_status) WHERE chain_status <> 'confirmed';
