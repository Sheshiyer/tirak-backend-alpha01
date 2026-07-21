-- Tirak Backend Seed Data
-- This script populates the database with initial data for staging environment

-- Insert categories
INSERT OR IGNORE INTO categories (id, name_en, name_th, description_en, description_th, icon, color, sort_order, is_active) VALUES
('cat_city_walks', 'City Walks', 'เดินเที่ยวชมเมือง', 'Guided walking routes through local neighborhoods', 'เส้นทางเดินพร้อมไกด์ในย่านท้องถิ่น', 'map-pin', '#3B82F6', 1, TRUE),
('cat_tour_guide', 'Tour Guide', 'ไกด์นำเที่ยว', 'Local tour guide services', 'บริการไกด์นำเที่ยวท้องถิ่น', 'map', '#10B981', 2, TRUE),
('cat_translator', 'Translation', 'แปลภาษา', 'Language translation services', 'บริการแปลภาษา', 'globe', '#8B5CF6', 3, TRUE),
('cat_shopping', 'Shopping Assistant', 'ผู้ช่วยช้อปปิ้ง', 'Personal shopping assistance', 'ผู้ช่วยช้อปปิ้งส่วนตัว', 'shopping-bag', '#F59E0B', 4, TRUE),
('cat_food_tours', 'Food Tours', 'ทัวร์อาหาร', 'Guided market and local food experiences', 'ประสบการณ์ตลาดและอาหารท้องถิ่นพร้อมไกด์', 'utensils', '#EF4444', 5, TRUE),
('cat_cultural', 'Cultural Experience', 'ประสบการณ์วัฒนธรรม', 'Cultural and traditional experience guide', 'ไกด์ประสบการณ์วัฒนธรรมและประเพณี', 'star', '#06B6D4', 6, TRUE);

-- Insert regions
INSERT OR IGNORE INTO regions (id, name_en, name_th, country_code, sort_order, is_active) VALUES
('region_bangkok', 'Bangkok', 'กรุงเทพมหานคร', 'TH', 1, TRUE),
('region_chiang_mai', 'Chiang Mai', 'เชียงใหม่', 'TH', 2, TRUE),
('region_phuket', 'Phuket', 'ภูเก็ต', 'TH', 3, TRUE),
('region_pattaya', 'Pattaya', 'พัทยา', 'TH', 4, TRUE),
('region_krabi', 'Krabi', 'กระบี่', 'TH', 5, TRUE),
('region_koh_samui', 'Koh Samui', 'เกาะสมุย', 'TH', 6, TRUE),
('region_hua_hin', 'Hua Hin', 'หัวหิน', 'TH', 7, TRUE),
('region_ayutthaya', 'Ayutthaya', 'อยุธยา', 'TH', 8, TRUE);

-- Insert test admin user
INSERT OR IGNORE INTO users (
    id, 
    email, 
    phone, 
    password_hash, 
    user_type, 
    status, 
    email_verified, 
    phone_verified, 
    preferred_language,
    created_at,
    updated_at
) VALUES (
    'admin_001',
    'admin@tirak.app',
    '+66812345678',
    '$2a$12$LQv3c1yqBwEHXw.9UdN.ue6tMZjz2Z8qJ5U5J5U5J5U5J5U5J5U5J5',  -- password: admin123
    'admin',
    'active',
    TRUE,
    TRUE,
    'en',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
);

-- Insert test customer users
INSERT OR IGNORE INTO users (
    id, 
    email, 
    phone, 
    password_hash, 
    user_type, 
    status, 
    email_verified, 
    phone_verified, 
    preferred_language,
    created_at,
    updated_at
) VALUES 
(
    'customer_001',
    'customer1@example.com',
    '+66812345679',
    '$2a$12$LQv3c1yqBwEHXw.9UdN.ue6tMZjz2Z8qJ5U5J5U5J5U5J5U5J5U5J5',  -- password: customer123
    'customer',
    'active',
    TRUE,
    TRUE,
    'en',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
),
(
    'customer_002',
    'customer2@example.com',
    '+66812345680',
    '$2a$12$LQv3c1yqBwEHXw.9UdN.ue6tMZjz2Z8qJ5U5J5U5J5U5J5U5J5U5J5',  -- password: customer123
    'customer',
    'active',
    TRUE,
    TRUE,
    'th',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
);

-- Insert customer profiles
INSERT OR IGNORE INTO customer_profiles (
    user_id,
    display_name,
    date_of_birth,
    gender,
    bio,
    profile_images,
    preferences,
    created_at,
    updated_at
) VALUES 
(
    'customer_001',
    'John Doe',
    '1990-01-15',
    'male',
    'Travel enthusiast from the US',
    '["https://example.com/profile1.jpg"]',
    '{"currency": "USD", "language": "en", "notifications": {"push": true, "email": true, "sms": false}}',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
),
(
    'customer_002',
    'สมชาย ใจดี',
    '1985-05-20',
    'male',
    'ชอบเที่ยวและทำอาหาร',
    '["https://example.com/profile2.jpg"]',
    '{"currency": "THB", "language": "th", "notifications": {"push": true, "email": false, "sms": true}}',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
);

-- Insert test supplier users
INSERT OR IGNORE INTO users (
    id, 
    email, 
    phone, 
    password_hash, 
    user_type, 
    status, 
    email_verified, 
    phone_verified, 
    preferred_language,
    created_at,
    updated_at
) VALUES 
(
    'supplier_001',
    'supplier1@example.com',
    '+66812345681',
    '$2a$12$LQv3c1yqBwEHXw.9UdN.ue6tMZjz2Z8qJ5U5J5U5J5U5J5U5J5U5J5',  -- password: supplier123
    'supplier',
    'active',
    TRUE,
    TRUE,
    'en',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
),
(
    'supplier_002',
    'supplier2@example.com',
    '+66812345682',
    '$2a$12$LQv3c1yqBwEHXw.9UdN.ue6tMZjz2Z8qJ5U5J5U5J5U5J5U5J5U5J5',  -- password: supplier123
    'supplier',
    'active',
    TRUE,
    TRUE,
    'th',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
);

-- Insert supplier profiles
INSERT OR IGNORE INTO supplier_profiles (
    user_id,
    display_name,
    bio,
    categories,
    regions,
    spoken_languages,
    profile_images,
    verification_status,
    subscription_status,
    rating_average,
    rating_count,
    created_at,
    updated_at
) VALUES 
(
    'supplier_001',
    'Sarah Bangkok Guide',
    'Professional tour guide with 5 years experience in Bangkok. Fluent in English and Thai.',
    '["cat_tour_guide", "cat_cultural"]',
    '["region_bangkok", "region_ayutthaya"]',
    '["en", "th"]',
    '["https://example.com/supplier1.jpg"]',
    'verified',
    'active',
    4.8,
    25,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
),
(
    'supplier_002',
    'กิต ไกด์เชียงใหม่',
    'ไกด์ท้องถิ่นเชียงใหม่ มีประสบการณ์ 3 ปี รู้จักสถานที่ท่องเที่ยวดีๆ',
    '["cat_tour_guide", "cat_food_tours", "cat_cultural"]',
    '["region_chiang_mai"]',
    '["th", "en"]',
    '["https://example.com/supplier2.jpg"]',
    'verified',
    'active',
    4.9,
    18,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
);

-- Insert sample services
INSERT OR IGNORE INTO supplier_services (
    id,
    supplier_id,
    title,
    description,
    category_id,
    price_min,
    price_max,
    currency,
    duration_hours,
    is_active,
    created_at,
    updated_at
) VALUES 
(
    'service_001',
    'supplier_001',
    'Bangkok City Tour',
    'Full day Bangkok city tour including temples, markets, and local food',
    'cat_tour_guide',
    2000,
    3000,
    'THB',
    8,
    TRUE,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
),
(
    'service_002',
    'supplier_001',
    'Cultural Temple Experience',
    'Visit historic temples with cultural insights and traditional ceremonies',
    'cat_cultural',
    1500,
    2500,
    'THB',
    4,
    TRUE,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
),
(
    'service_003',
    'supplier_002',
    'Chiang Mai Food Tour',
    'Authentic northern Thai food experience with local markets',
    'cat_food_tours',
    1800,
    2800,
    'THB',
    6,
    TRUE,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
);

-- Insert sample availability
INSERT OR IGNORE INTO supplier_availability (
    supplier_id,
    day_of_week,
    start_time,
    end_time,
    is_available,
    created_at,
    updated_at
) VALUES 
-- Supplier 1 availability (Monday to Saturday)
('supplier_001', 1, '09:00', '18:00', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('supplier_001', 2, '09:00', '18:00', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('supplier_001', 3, '09:00', '18:00', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('supplier_001', 4, '09:00', '18:00', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('supplier_001', 5, '09:00', '18:00', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('supplier_001', 6, '10:00', '16:00', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('supplier_001', 0, '10:00', '16:00', FALSE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

-- Supplier 2 availability (Tuesday to Sunday)
('supplier_002', 2, '08:00', '17:00', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('supplier_002', 3, '08:00', '17:00', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('supplier_002', 4, '08:00', '17:00', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('supplier_002', 5, '08:00', '17:00', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('supplier_002', 6, '08:00', '17:00', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('supplier_002', 0, '09:00', '15:00', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('supplier_002', 1, '09:00', '15:00', FALSE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- Insert configuration data
INSERT OR IGNORE INTO system_config (key, value, description, created_at, updated_at) VALUES
('app_version', '1.0.0', 'Current application version', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('maintenance_mode', 'false', 'Application maintenance mode', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('max_booking_days_advance', '30', 'Maximum days in advance for booking', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('min_booking_hours_advance', '2', 'Minimum hours in advance for booking', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('default_currency', 'THB', 'Default currency for the platform', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('supported_languages', '["en", "th"]', 'Supported languages', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('platform_fee_percentage', '10', 'Platform fee percentage', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('max_file_size_mb', '10', 'Maximum file upload size in MB', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
