-- Migration 021: Evidence, interest, and QA cohort tables.
-- Additive only; no payment changes. Safe to apply after 020.

-- Evidence files for supplier onboarding applications.
-- Private R2 prefix: private-core-onboarding/<application_id>/<opaque_id>
CREATE TABLE IF NOT EXISTS supplier_onboarding_evidence (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES supplier_onboarding_applications(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('id_front', 'id_back', 'selfie', 'portfolio')),
  r2_key TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  mime_type TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(application_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_evidence_application
  ON supplier_onboarding_evidence (application_id);

-- Interest / waitlist entries. Separate from applications; no account created.
CREATE TABLE IF NOT EXISTS interest_entries (
  id TEXT PRIMARY KEY,
  email_normalized TEXT NOT NULL,
  name TEXT,
  source TEXT,
  idempotency_key_hash TEXT,
  payload_digest TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_interest_idempotency
  ON interest_entries (idempotency_key_hash)
  WHERE idempotency_key_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_interest_email
  ON interest_entries (email_normalized);

-- Core QA cohort accounts. Server-only; never a client fixture bypass.
-- Holds intentionally seeded QA admin/traveler accounts.
CREATE TABLE IF NOT EXISTS core_qa_accounts (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'traveler', 'guide')),
  source_application_id TEXT REFERENCES supplier_onboarding_applications(id) ON DELETE CASCADE,
  enrolled_by TEXT REFERENCES users(id) ON DELETE RESTRICT,
  enrolled_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT,
  CHECK (
    (role = 'guide' AND source_application_id IS NOT NULL AND enrolled_by IS NOT NULL)
    OR (role IN ('admin', 'traveler') AND source_application_id IS NULL AND enrolled_by IS NULL)
  ),
  PRIMARY KEY (user_id, role)
);

CREATE INDEX IF NOT EXISTS idx_qa_accounts_active
  ON core_qa_accounts (user_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_qa_source_application
  ON core_qa_accounts (source_application_id)
  WHERE source_application_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_qa_enrolled_by
  ON core_qa_accounts (enrolled_by)
  WHERE enrolled_by IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_qa_unique_application_guide
  ON core_qa_accounts (source_application_id, role)
  WHERE source_application_id IS NOT NULL AND role = 'guide' AND revoked_at IS NULL;

-- Add invitation_delivery_status column to applications if not present
-- (SQLite doesn't support IF NOT EXISTS for ADD COLUMN, so this is a
-- best-effort that may fail harmlessly if the column already exists)
ALTER TABLE supplier_onboarding_applications ADD COLUMN invitation_delivery_status TEXT DEFAULT 'unknown';
