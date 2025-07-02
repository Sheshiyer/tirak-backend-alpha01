-- Migration to add companion_profiles table
-- Migration: 010_add_companion_profiles_table.sql

-- Create migrations tracking table if it doesn't exist
CREATE TABLE IF NOT EXISTS _migrations (
  name TEXT PRIMARY KEY,
  applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Create table for companion profiles
CREATE TABLE IF NOT EXISTS companion_profiles (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    first_name TEXT,
    last_name TEXT,
    display_name TEXT,
    bio TEXT,
    social_links TEXT, -- JSON object
    date_of_birth TEXT, -- YYYY-MM-DD format
    gender TEXT CHECK (gender IN ('male', 'female', 'other')),
    cover_photo TEXT, -- URL to cover photo
    profile_photo TEXT, -- URL to profile photo
    location TEXT,
    languages TEXT, -- JSON array of languages
    specialization TEXT, -- JSON array of specializations
    certifications TEXT, -- JSON array of certifications
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_companion_profiles_user_id ON companion_profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_companion_profiles_display_name ON companion_profiles(display_name);
CREATE INDEX IF NOT EXISTS idx_companion_profiles_location ON companion_profiles(location);

-- Log the migration
INSERT OR REPLACE INTO _migrations (name, applied_at) 
VALUES ('010_add_companion_profiles_table', CURRENT_TIMESTAMP); 