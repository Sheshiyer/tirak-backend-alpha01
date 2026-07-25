-- Supplier onboarding review: admin approve/reject decisions on applications.
--
-- Adds review outcome columns to supplier_onboarding_applications. Approved
-- applications link to the supplier user created from them; rejected ones
-- carry the admin's reason.
--
-- SQLite has no ADD COLUMN IF NOT EXISTS. Apply only through the Wrangler
-- migration ledger; never via raw directory replay.

ALTER TABLE supplier_onboarding_applications ADD COLUMN reviewed_at TEXT;
ALTER TABLE supplier_onboarding_applications ADD COLUMN rejection_reason TEXT;
ALTER TABLE supplier_onboarding_applications ADD COLUMN approved_user_id TEXT;
