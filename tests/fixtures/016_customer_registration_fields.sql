-- Candidate only. No remote application is authorized by this file.
-- The frozen baseline omits these customer fields used by current signup.
-- Preflight with PRAGMA table_info(customer_profiles) on the selected target:
-- execute each statement ONLY if that column is absent; record applied changes.
-- Never replay the quarantined historical mobile migration to obtain them.
ALTER TABLE customer_profiles ADD COLUMN date_of_birth TEXT;
ALTER TABLE customer_profiles ADD COLUMN gender TEXT CHECK (gender IN ('male', 'female', 'other'));
