-- Migration to create the booking_timeline table.
-- This table is used to track the status changes and history of a booking.
-- Migration: 019_create_booking_timeline.sql

CREATE TABLE booking_timeline (
    id TEXT PRIMARY KEY,
    booking_id TEXT NOT NULL,
    status TEXT NOT NULL,
    timestamp DATETIME NOT NULL,
    note TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE
);

CREATE INDEX idx_booking_timeline_booking_id ON booking_timeline (booking_id); 