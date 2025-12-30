-- Migration to add rating fields to companion_profiles table
-- Migration: 022_add_ratings_to_companion_profiles.sql

-- Create migrations tracking table if it doesn't exist
CREATE TABLE IF NOT EXISTS _migrations (
  name TEXT PRIMARY KEY,
  applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Add rating columns to companion_profiles
ALTER TABLE companion_profiles ADD COLUMN rating_average REAL DEFAULT 0.0;
ALTER TABLE companion_profiles ADD COLUMN rating_count INTEGER DEFAULT 0;

-- Create index for rating_average for better query performance
CREATE INDEX IF NOT EXISTS idx_companion_profiles_rating_average ON companion_profiles(rating_average);

-- Log the migration
INSERT OR REPLACE INTO _migrations (name, applied_at) 
VALUES ('022_add_ratings_to_companion_profiles', CURRENT_TIMESTAMP);

