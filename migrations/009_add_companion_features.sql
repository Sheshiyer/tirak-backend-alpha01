-- Migration to add companion experience and location tables
-- Migration: 009_add_companion_features.sql

-- Create table for companion experiences
CREATE TABLE companion_experiences (
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

-- Create table for companion locations
CREATE TABLE companion_locations (
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
ALTER TABLE bookings ADD COLUMN customer_preferences TEXT;
ALTER TABLE bookings ADD COLUMN special_requests TEXT;
ALTER TABLE bookings ADD COLUMN preferred_language TEXT;
ALTER TABLE bookings ADD COLUMN group_composition TEXT;
ALTER TABLE bookings ADD COLUMN dietary_requirements TEXT;

-- Create indexes for better query performance
CREATE INDEX idx_companion_exp_companion_id ON companion_experiences(companion_id);
CREATE INDEX idx_companion_loc_companion_id ON companion_locations(companion_id);
CREATE INDEX idx_companion_loc_city ON companion_locations(city);
CREATE INDEX idx_companion_loc_region ON companion_locations(region);

-- Log the migration
INSERT INTO _migrations (name, applied_at) 
VALUES ('009_add_companion_features', CURRENT_TIMESTAMP); 