-- Migration to fix the bookings table schema
-- This brings the schema up to date with the application code.
-- Migration: 016_fix_bookings_table.sql

-- Add missing columns based on application code requirements
ALTER TABLE bookings ADD COLUMN experience_id TEXT;
ALTER TABLE bookings ADD COLUMN date TEXT;
ALTER TABLE bookings ADD COLUMN start_time TEXT;
ALTER TABLE bookings ADD COLUMN end_time TEXT;
ALTER TABLE bookings ADD COLUMN location TEXT;
ALTER TABLE bookings ADD COLUMN meeting_point TEXT;
ALTER TABLE bookings ADD COLUMN template TEXT;
ALTER TABLE bookings ADD COLUMN preferred_languages TEXT; -- Stored as JSON
ALTER TABLE bookings ADD COLUMN dietary_restrictions TEXT; -- Stored as JSON
ALTER TABLE bookings ADD COLUMN accessibility_needs TEXT; -- Stored as JSON
ALTER TABLE bookings ADD COLUMN service_fee REAL;
ALTER TABLE bookings ADD COLUMN payment_status TEXT DEFAULT 'pending';

-- Drop obsolete columns that have been replaced by the new fields
ALTER TABLE bookings DROP COLUMN scheduled_at;
ALTER TABLE bookings DROP COLUMN notes;
ALTER TABLE bookings DROP COLUMN customer_preferences;
ALTER TABLE bookings DROP COLUMN preferred_language;
ALTER TABLE bookings DROP COLUMN group_composition;
ALTER TABLE bookings DROP COLUMN dietary_requirements; 