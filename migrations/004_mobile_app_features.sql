-- Migration 004: Mobile App Features
-- Add tables and columns for mobile app functionality

-- bookings: canonical definition lives in 001/schema.sql (supplier_id,
-- scheduled_at). The original 004 draft predated that rename and defined a
-- drifted companion_id table plus companion_id/date indexes that abort fresh
-- bootstraps ("no such column: companion_id"). Removed; the canonical indexes
-- below cover the same access paths.

-- Create booking timeline table
CREATE TABLE IF NOT EXISTS booking_timeline (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id TEXT NOT NULL,
    status TEXT NOT NULL,
    timestamp TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    note TEXT,
    FOREIGN KEY (booking_id) REFERENCES bookings(id)
);

-- reviews: canonical definition lives in 001/schema.sql (reviewer_id,
-- reviewee_id). The original 004 companion_id draft was removed for the same
-- reason as bookings above.

-- Create payment methods table
CREATE TABLE IF NOT EXISTS payment_methods (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('card', 'promptpay', 'truemoney', 'bank_transfer')),
    details TEXT NOT NULL, -- JSON object with payment method details
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Create notifications table
CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    data TEXT, -- JSON object with additional data
    read BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Add notification preferences column to users table
ALTER TABLE users ADD COLUMN notification_preferences TEXT DEFAULT '{}';

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_bookings_customer_id ON bookings(customer_id);
CREATE INDEX IF NOT EXISTS idx_bookings_supplier_id ON bookings(supplier_id);
CREATE INDEX IF NOT EXISTS idx_bookings_scheduled_at ON bookings(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
CREATE INDEX IF NOT EXISTS idx_booking_timeline_booking_id ON booking_timeline(booking_id);
CREATE INDEX IF NOT EXISTS idx_reviews_reviewer_id ON reviews(reviewer_id);
CREATE INDEX IF NOT EXISTS idx_reviews_reviewee_id ON reviews(reviewee_id);
CREATE INDEX IF NOT EXISTS idx_reviews_rating ON reviews(rating);
CREATE INDEX IF NOT EXISTS idx_payment_methods_user_id ON payment_methods(user_id);
CREATE INDEX IF NOT EXISTS idx_payment_methods_is_default ON payment_methods(is_default);
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at);

-- supplier_profiles rating columns: already present in 001 (rating_average,
-- rating_count). The duplicate ALTERs were removed; they abort fresh chains
-- with "duplicate column name".

-- Update customer_profiles table to add missing columns
ALTER TABLE customer_profiles ADD COLUMN date_of_birth TEXT;
ALTER TABLE customer_profiles ADD COLUMN gender TEXT CHECK (gender IN ('male', 'female', 'other'));

-- Create supplier services table if not exists
CREATE TABLE IF NOT EXISTS supplier_services (
    id TEXT PRIMARY KEY,
    supplier_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    category_id TEXT,
    price_min REAL NOT NULL,
    price_max REAL,
    currency TEXT NOT NULL DEFAULT 'THB',
    duration_hours REAL NOT NULL DEFAULT 1,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (supplier_id) REFERENCES users(id),
    FOREIGN KEY (category_id) REFERENCES categories(id)
);

-- Create supplier availability table if not exists
CREATE TABLE IF NOT EXISTS supplier_availability (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    supplier_id TEXT NOT NULL,
    day_of_week INTEGER NOT NULL CHECK (day_of_week >= 0 AND day_of_week <= 6), -- 0 = Sunday
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    is_available BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (supplier_id) REFERENCES users(id),
    UNIQUE(supplier_id, day_of_week)
);

-- Create system config table if not exists
CREATE TABLE IF NOT EXISTS system_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    description TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Add indexes for supplier tables
CREATE INDEX IF NOT EXISTS idx_supplier_services_supplier_id ON supplier_services(supplier_id);
CREATE INDEX IF NOT EXISTS idx_supplier_services_is_active ON supplier_services(is_active);
CREATE INDEX IF NOT EXISTS idx_supplier_availability_supplier_id ON supplier_availability(supplier_id);
CREATE INDEX IF NOT EXISTS idx_supplier_availability_day_of_week ON supplier_availability(day_of_week);

-- Update chat_messages table to add missing columns
ALTER TABLE chat_messages ADD COLUMN delivered_at TEXT;
ALTER TABLE chat_messages ADD COLUMN read_at TEXT;
ALTER TABLE chat_messages ADD COLUMN reply_to_id TEXT;

-- Add indexes for chat tables
CREATE INDEX IF NOT EXISTS idx_chat_messages_read_at ON chat_messages(read_at);
CREATE INDEX IF NOT EXISTS idx_chat_messages_delivered_at ON chat_messages(delivered_at);
CREATE INDEX IF NOT EXISTS idx_chat_messages_reply_to_id ON chat_messages(reply_to_id);

-- Create triggers to update timestamps
CREATE TRIGGER IF NOT EXISTS update_bookings_timestamp 
    AFTER UPDATE ON bookings
    BEGIN
        UPDATE bookings SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
    END;

CREATE TRIGGER IF NOT EXISTS update_reviews_timestamp 
    AFTER UPDATE ON reviews
    BEGIN
        UPDATE reviews SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
    END;

CREATE TRIGGER IF NOT EXISTS update_payment_methods_timestamp 
    AFTER UPDATE ON payment_methods
    BEGIN
        UPDATE payment_methods SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
    END;

CREATE TRIGGER IF NOT EXISTS update_notifications_timestamp 
    AFTER UPDATE ON notifications
    BEGIN
        UPDATE notifications SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
    END;

CREATE TRIGGER IF NOT EXISTS update_supplier_services_timestamp 
    AFTER UPDATE ON supplier_services
    BEGIN
        UPDATE supplier_services SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
    END;

CREATE TRIGGER IF NOT EXISTS update_supplier_availability_timestamp 
    AFTER UPDATE ON supplier_availability
    BEGIN
        UPDATE supplier_availability SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
    END;

CREATE TRIGGER IF NOT EXISTS update_system_config_timestamp 
    AFTER UPDATE ON system_config
    BEGIN
        UPDATE system_config SET updated_at = CURRENT_TIMESTAMP WHERE key = NEW.key;
    END;
