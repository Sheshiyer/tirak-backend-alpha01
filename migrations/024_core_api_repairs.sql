-- Migration 024: Core API repair corrections.
-- Accepted scope: add only the onboarding interests field.
-- Archive semantics remain archived_at-based and evidence/cohort constraints
-- belong to migration 021.

ALTER TABLE supplier_profiles ADD COLUMN interests TEXT;
