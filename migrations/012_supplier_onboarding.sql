-- Supplier onboarding applications: self-serve vendor intake for admin review.
--
-- Contract source: tirak-admin-command-center PR #29
-- (src/lib/api.ts SupplierOnboardingPayload). Field names here are snake_case
-- mirrors of that frozen payload; do not rename without a frontend change.
--
-- Idempotent: every statement uses IF NOT EXISTS. Apply only through the
-- Wrangler migration ledger; never via raw directory replay.

CREATE TABLE IF NOT EXISTS supplier_onboarding_applications (
  id TEXT PRIMARY KEY,
  business_name TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  location TEXT NOT NULL,
  bio TEXT,
  brochure_urls TEXT NOT NULL DEFAULT '[]',
  categories TEXT NOT NULL DEFAULT '[]',
  mode TEXT NOT NULL DEFAULT 'tirak' CHECK (mode IN ('tirak', 'tirakplus')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_user_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_supplier_onboarding_status
  ON supplier_onboarding_applications (status, created_at);

CREATE INDEX IF NOT EXISTS idx_supplier_onboarding_mode
  ON supplier_onboarding_applications (mode, status);
