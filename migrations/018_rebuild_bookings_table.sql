-- Migration to fix and rebuild the local bookings table schema.
-- This brings the schema up to date with the application code and makes service_id nullable.
-- Migration: 018_rebuild_bookings_table.sql

-- 1. Create the final, correct table structure.
CREATE TABLE bookings_rebuilt (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL,
    supplier_id TEXT NOT NULL,
    companion_id TEXT,
    service_id TEXT, -- Nullable
    experience_id TEXT,
    date TEXT,
    start_time TEXT,
    end_time TEXT,
    duration INTEGER,
    location TEXT,
    special_requests TEXT,
    meeting_point TEXT,
    template TEXT,
    preferred_languages TEXT,
    dietary_restrictions TEXT,
    accessibility_needs TEXT,
    status TEXT DEFAULT 'pending',
    total_amount REAL,
    service_fee REAL,
    payment_status TEXT DEFAULT 'pending',
    scheduled_at DATETIME, -- For backward compatibility
    created_at DATETIME,
    updated_at DATETIME
);

-- 2. Copy data from the old table to the new one.
-- The SELECT list matches the exact schema of your local database.
INSERT INTO bookings_rebuilt (
    id, customer_id, supplier_id, companion_id, service_id, experience_id,
    duration, status, total_amount, scheduled_at, created_at, updated_at
)
SELECT
    id, customer_id, supplier_id, companion_id, service_id, experience_id,
    duration, status, total_amount, scheduled_at, created_at, updated_at
FROM bookings;


-- 3. Drop the old table.
DROP TABLE bookings;

-- 4. Rename the new table to the original name.
ALTER TABLE bookings_rebuilt RENAME TO bookings; 