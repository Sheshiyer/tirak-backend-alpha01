-- Migration 014: Add verification status to companion_profiles
-- This aligns the companion profile with the supplier profile for admin verification.

ALTER TABLE companion_profiles ADD COLUMN verification_status TEXT DEFAULT 'pending' CHECK (verification_status IN ('pending', 'verified', 'rejected'));
ALTER TABLE companion_profiles ADD COLUMN rejection_reason TEXT; 