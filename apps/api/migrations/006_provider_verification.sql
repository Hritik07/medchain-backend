-- 006_provider_verification.sql
-- Admin verification details for providers (Step 9).
-- verified_status: pending -> verified, or pending/verified -> rejected (rejecting a verified provider = suspension).

ALTER TABLE providers ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL;  -- admin who decided
ALTER TABLE providers ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_providers_status ON providers (verified_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_provider ON users (provider_id);
