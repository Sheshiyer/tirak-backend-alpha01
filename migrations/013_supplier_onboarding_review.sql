-- Migration 013: Supplier Onboarding Review
-- Adds review workflow columns to supplier_onboarding_applications
-- Safe to run multiple times (IF NOT EXISTS not supported for ADD COLUMN in all D1, so use conditional pattern via application logic or just run once)

ALTER TABLE supplier_onboarding_applications ADD COLUMN reviewed_at TEXT;
ALTER TABLE supplier_onboarding_applications ADD COLUMN rejection_reason TEXT;
ALTER TABLE supplier_onboarding_applications ADD COLUMN approved_user_id TEXT;

-- Helpful index for filtering reviewed applications
CREATE INDEX IF NOT EXISTS idx_supplier_onboarding_applications_reviewed ON supplier_onboarding_applications(status, reviewed_at);
