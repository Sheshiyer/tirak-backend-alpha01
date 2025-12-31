-- Migration 004: Mobile App Features
-- Add tables and columns for mobile app functionality

-- Create bookings table (without companion_id - it will be added in migration 015)
CREATE TABLE IF NOT EXISTS bookings (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL,
    service_id TEXT,
    date TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    duration INTEGER NOT NULL,
    location TEXT,
    special_requests TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'in_progress', 'completed', 'cancelled')),
    total_amount REAL NOT NULL,
    service_fee REAL NOT NULL DEFAULT 0,
    payment_method_id TEXT,
    payment_status TEXT NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending', 'processing', 'completed', 'failed', 'refunded')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (customer_id) REFERENCES users(id),
    FOREIGN KEY (service_id) REFERENCES supplier_services(id),
    FOREIGN KEY (payment_method_id) REFERENCES payment_methods(id)
);

-- Create booking timeline table
CREATE TABLE IF NOT EXISTS booking_timeline (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id TEXT NOT NULL,
    status TEXT NOT NULL,
    timestamp TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    note TEXT,
    FOREIGN KEY (booking_id) REFERENCES bookings(id)
);

-- Create reviews table (companion_id will be added later if needed)
CREATE TABLE IF NOT EXISTS reviews (
    id TEXT PRIMARY KEY,
    booking_id TEXT NOT NULL,
    customer_id TEXT NOT NULL,
    reviewee_id TEXT NOT NULL, -- Can be companion_id or supplier_id
    rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
    comment TEXT,
    categories TEXT, -- JSON object with category ratings
    is_public BOOLEAN NOT NULL DEFAULT TRUE,
    verified BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (booking_id) REFERENCES bookings(id),
    FOREIGN KEY (reviewee_id) REFERENCES users(id),
    FOREIGN KEY (customer_id) REFERENCES users(id),
    UNIQUE(booking_id, customer_id)
);

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
-- Note: idx_bookings_companion_id will be created in migration 015 after companion_id column is added
CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(date);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
CREATE INDEX IF NOT EXISTS idx_booking_timeline_booking_id ON booking_timeline(booking_id);
CREATE INDEX IF NOT EXISTS idx_reviews_reviewee_id ON reviews(reviewee_id);
CREATE INDEX IF NOT EXISTS idx_reviews_customer_id ON reviews(customer_id);
CREATE INDEX IF NOT EXISTS idx_reviews_rating ON reviews(rating);
CREATE INDEX IF NOT EXISTS idx_payment_methods_user_id ON payment_methods(user_id);
CREATE INDEX IF NOT EXISTS idx_payment_methods_is_default ON payment_methods(is_default);
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at);

-- Update supplier_profiles table to add missing columns
ALTER TABLE supplier_profiles ADD COLUMN rating_average REAL DEFAULT 0;
ALTER TABLE supplier_profiles ADD COLUMN rating_count INTEGER DEFAULT 0;

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
CREATE INDEX IF NOT EXISTS idx_supplier_services_category_id ON supplier_services(category_id);
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
