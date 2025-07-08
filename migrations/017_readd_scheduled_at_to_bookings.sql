-- Re-add the scheduled_at column to the bookings table for backward compatibility
-- with endpoints that still rely on it.
-- Migration: 017_readd_scheduled_at_to_bookings.sql

ALTER TABLE bookings ADD COLUMN scheduled_at DATETIME;

-- Populate the new scheduled_at column for existing bookings from the date and start_time columns.
-- This ensures that old endpoints can function with data created after the schema change.
UPDATE bookings SET scheduled_at = DATETIME(date || ' ' || start_time) WHERE date IS NOT NULL AND start_time IS NOT NULL; 