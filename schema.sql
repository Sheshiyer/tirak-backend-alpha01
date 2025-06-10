-- Tirak Platform Database Schema

-- Users table (core user data)
CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    phone TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    user_type TEXT NOT NULL CHECK (user_type IN ('customer', 'supplier', 'admin')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('active', 'suspended', 'pending')),
    email_verified BOOLEAN DEFAULT FALSE,
    phone_verified BOOLEAN DEFAULT FALSE,
    preferred_language TEXT DEFAULT 'en' CHECK (preferred_language IN ('en', 'th')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login_at DATETIME
);

-- Supplier profiles
CREATE TABLE supplier_profiles (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL,
    bio TEXT,
    profile_images TEXT, -- JSON array of image URLs
    categories TEXT, -- JSON array of category IDs
    regions TEXT, -- JSON array of region IDs
    spoken_languages TEXT, -- JSON array of language codes
    rating_average REAL DEFAULT 0.0,
    rating_count INTEGER DEFAULT 0,
    verification_status TEXT DEFAULT 'pending' CHECK (verification_status IN ('pending', 'verified', 'rejected')),
    subscription_status TEXT DEFAULT 'inactive' CHECK (subscription_status IN ('active', 'inactive', 'expired')),
    subscription_tier TEXT DEFAULT 'basic' CHECK (subscription_tier IN ('basic', 'premium', 'enterprise')),
    subscription_expires_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Customer profiles
CREATE TABLE customer_profiles (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL,
    profile_image TEXT,
    preferences TEXT, -- JSON object for user preferences
    loyalty_points INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Services offered by suppliers
CREATE TABLE supplier_services (
    id TEXT PRIMARY KEY,
    supplier_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    price_min REAL NOT NULL,
    price_max REAL NOT NULL,
    currency TEXT DEFAULT 'THB',
    duration_hours INTEGER NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Supplier availability
CREATE TABLE supplier_availability (
    id TEXT PRIMARY KEY,
    supplier_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6), -- 0 = Sunday
    start_time TEXT NOT NULL, -- HH:MM format
    end_time TEXT NOT NULL, -- HH:MM format
    is_available BOOLEAN DEFAULT TRUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(supplier_id, day_of_week)
);

-- Chat rooms
CREATE TABLE chat_rooms (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL REFERENCES users(id),
    supplier_id TEXT NOT NULL REFERENCES users(id),
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'closed', 'archived')),
    last_message_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(customer_id, supplier_id)
);

-- Chat messages
CREATE TABLE chat_messages (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
    sender_id TEXT NOT NULL REFERENCES users(id),
    message_type TEXT NOT NULL CHECK (message_type IN ('text', 'image', 'system')),
    content TEXT,
    image_url TEXT,
    metadata TEXT, -- JSON for additional message data
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Bookings
CREATE TABLE bookings (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL REFERENCES users(id),
    supplier_id TEXT NOT NULL REFERENCES users(id),
    service_id TEXT NOT NULL REFERENCES supplier_services(id),
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'completed', 'cancelled')),
    scheduled_at DATETIME NOT NULL,
    duration INTEGER NOT NULL, -- in minutes
    total_amount REAL NOT NULL,
    currency TEXT DEFAULT 'THB',
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Reviews and ratings
CREATE TABLE reviews (
    id TEXT PRIMARY KEY,
    booking_id TEXT NOT NULL REFERENCES bookings(id),
    reviewer_id TEXT NOT NULL REFERENCES users(id),
    reviewee_id TEXT NOT NULL REFERENCES users(id),
    rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment TEXT,
    is_public BOOLEAN DEFAULT TRUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(booking_id, reviewer_id)
);

-- Categories (for services)
CREATE TABLE categories (
    id TEXT PRIMARY KEY,
    name_en TEXT NOT NULL,
    name_th TEXT NOT NULL,
    description_en TEXT,
    description_th TEXT,
    icon_url TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    sort_order INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Regions (geographical areas)
CREATE TABLE regions (
    id TEXT PRIMARY KEY,
    name_en TEXT NOT NULL,
    name_th TEXT NOT NULL,
    country_code TEXT DEFAULT 'TH',
    is_active BOOLEAN DEFAULT TRUE,
    sort_order INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- User sessions (for tracking active sessions)
CREATE TABLE user_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    refresh_token_hash TEXT NOT NULL,
    device_id TEXT,
    ip_address TEXT,
    user_agent TEXT,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_active_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Analytics events
CREATE TABLE analytics_events (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    user_id TEXT REFERENCES users(id),
    session_id TEXT,
    properties TEXT, -- JSON object
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    ip_address TEXT,
    user_agent TEXT
);

-- Content moderation queue
CREATE TABLE moderation_queue (
    id TEXT PRIMARY KEY,
    content_type TEXT NOT NULL CHECK (content_type IN ('message', 'profile', 'review', 'image')),
    content_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id),
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    priority TEXT DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
    flagged_reason TEXT,
    moderator_id TEXT REFERENCES users(id),
    moderator_notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    reviewed_at DATETIME
);
