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

-- Add new columns to bookings table for enhanced customer preferences if they don't exist
-- SQLite doesn't have a direct way to check if column exists, so we use ALTER TABLE with a transaction
BEGIN TRANSACTION;

-- Add columns conditionally using the SQLite technique
-- We try to add each column and catch any errors
-- Checking first if the customer_preferences column exists
SELECT CASE 
    WHEN (SELECT COUNT(*) FROM pragma_table_info('bookings') WHERE name = 'customer_preferences') = 0 THEN
        ALTER TABLE bookings ADD COLUMN customer_preferences TEXT
    ELSE
        SELECT 0
END;

-- Checking if the special_requests column exists
SELECT CASE 
    WHEN (SELECT COUNT(*) FROM pragma_table_info('bookings') WHERE name = 'special_requests') = 0 THEN
        ALTER TABLE bookings ADD COLUMN special_requests TEXT
    ELSE
        SELECT 0
END;

-- Checking if the preferred_language column exists
SELECT CASE 
    WHEN (SELECT COUNT(*) FROM pragma_table_info('bookings') WHERE name = 'preferred_language') = 0 THEN
        ALTER TABLE bookings ADD COLUMN preferred_language TEXT
    ELSE
        SELECT 0
END;

-- Checking if the group_composition column exists
SELECT CASE 
    WHEN (SELECT COUNT(*) FROM pragma_table_info('bookings') WHERE name = 'group_composition') = 0 THEN
        ALTER TABLE bookings ADD COLUMN group_composition TEXT
    ELSE
        SELECT 0
END;

-- Checking if the dietary_requirements column exists
SELECT CASE 
    WHEN (SELECT COUNT(*) FROM pragma_table_info('bookings') WHERE name = 'dietary_requirements') = 0 THEN
        ALTER TABLE bookings ADD COLUMN dietary_requirements TEXT
    ELSE
        SELECT 0
END;

COMMIT;

-- Create indexes for better query performance (if they don't exist)
CREATE INDEX IF NOT EXISTS idx_companion_exp_companion_id ON companion_experiences(companion_id);
CREATE INDEX IF NOT EXISTS idx_companion_loc_companion_id ON companion_locations(companion_id);
CREATE INDEX IF NOT EXISTS idx_companion_loc_city ON companion_locations(city);
CREATE INDEX IF NOT EXISTS idx_companion_loc_region ON companion_locations(region);

-- Log the migration
INSERT OR REPLACE INTO _migrations (name, applied_at) 
VALUES ('009_add_companion_features', CURRENT_TIMESTAMP); 