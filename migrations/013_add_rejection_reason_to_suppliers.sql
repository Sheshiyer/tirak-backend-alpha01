-- Migration 013: Add rejection_reason to supplier_profiles
-- This adds a text column to store the reason for a companion's verification rejection.

ALTER TABLE supplier_profiles ADD COLUMN rejection_reason TEXT; 