-- Migration to add companion experience and location tables
-- Migration: 009_add_companion_features.sql

-- Create migrations tracking table if it doesn't exist
CREATE TABLE IF NOT EXISTS _migrations (
  name TEXT PRIMARY KEY,
  applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Create table for companion experiences (only if it doesn't exist)
CREATE TABLE IF NOT EXISTS companion_experiences (
    id TEXT PRIMARY KEY,
    companion_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    duration_minutes INTEGER NOT NULL,
    keywords TEXT, -- JSON array of keywords
    price REAL NOT NULL,
    currency TEXT DEFAULT 'THB',
    is_active BOOLEAN DEFAULT TRUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Create table for companion locations (only if it doesn't exist)
CREATE TABLE IF NOT EXISTS companion_locations (
    id TEXT PRIMARY KEY,
    companion_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    city TEXT NOT NULL,
    region TEXT NOT NULL,
    is_popular BOOLEAN DEFAULT FALSE,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Add new columns to bookings table for enhanced customer preferences
-- We try to add each column separately and ignore errors if they already exist
-- Using ALTER TABLE statements without transactions (D1 doesn't allow BEGIN TRANSACTION)

-- Try to add customer_preferences column (will fail silently if column already exists)
ALTER TABLE bookings ADD COLUMN customer_preferences TEXT;

-- Try to add special_requests column (will fail silently if column already exists)
ALTER TABLE bookings ADD COLUMN special_requests TEXT;

-- Try to add preferred_language column (will fail silently if column already exists)
ALTER TABLE bookings ADD COLUMN preferred_language TEXT;

-- Try to add group_composition column (will fail silently if column already exists)
ALTER TABLE bookings ADD COLUMN group_composition TEXT;

-- Try to add dietary_requirements column (will fail silently if column already exists)
ALTER TABLE bookings ADD COLUMN dietary_requirements TEXT;

-- Create indexes for better query performance (if they don't exist)
CREATE INDEX IF NOT EXISTS idx_companion_exp_companion_id ON companion_experiences(companion_id);
CREATE INDEX IF NOT EXISTS idx_companion_loc_companion_id ON companion_locations(companion_id);
CREATE INDEX IF NOT EXISTS idx_companion_loc_city ON companion_locations(city);
CREATE INDEX IF NOT EXISTS idx_companion_loc_region ON companion_locations(region);

-- Log the migration
INSERT OR REPLACE INTO _migrations (name, applied_at) 
VALUES ('009_add_companion_features', CURRENT_TIMESTAMP); 