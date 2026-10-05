-- Migration 020: Core onboarding lifecycle correctness.
-- Adds idempotency key hash (unique), payload digest (conflict detection),
-- status-token hash, structured application data, and email-normalized column.
-- Additive only; safe to apply after 012 + 013.
-- All statements use IF NOT EXISTS where SQLite supports it.

-- Idempotency key hash: SHA-256(key alone); unique per application.
ALTER TABLE supplier_onboarding_applications ADD COLUMN idempotency_key_hash TEXT;

-- Payload digest: SHA-256 of recursively sorted canonical payload.
-- Stored separately for conflict detection: same key + different payload → 409.
ALTER TABLE supplier_onboarding_applications ADD COLUMN payload_digest TEXT;

-- Status token hash: SHA-256 of the high-entropy private token; token itself
-- is returned once and never stored.
ALTER TABLE supplier_onboarding_applications ADD COLUMN status_token_hash TEXT;

-- Structured application data JSON for firstName, lastName, bio, location,
-- languages, interests, service drafts, schedule. Bounded and validated.
ALTER TABLE supplier_onboarding_applications ADD COLUMN application_data TEXT;

-- Normalized email (lowercased + trimmed) for collision detection.
ALTER TABLE supplier_onboarding_applications ADD COLUMN email_normalized TEXT;

-- Unique index on idempotency key hash for replay/conflict detection.
CREATE UNIQUE INDEX IF NOT EXISTS idx_supplier_onboarding_idempotency
  ON supplier_onboarding_applications (idempotency_key_hash)
  WHERE idempotency_key_hash IS NOT NULL;

-- Index on normalized email for collision checks.
CREATE INDEX IF NOT EXISTS idx_supplier_onboarding_email_norm
  ON supplier_onboarding_applications (email_normalized);

-- Index on status token hash for bearer status lookup.
CREATE INDEX IF NOT EXISTS idx_supplier_onboarding_status_token
  ON supplier_onboarding_applications (status_token_hash)
  WHERE status_token_hash IS NOT NULL;
