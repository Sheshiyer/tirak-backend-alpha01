-- Performance indexes migration
-- Migration: 002_add_indexes.sql

-- User table indexes
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_phone ON users(phone);
CREATE INDEX idx_users_user_type ON users(user_type);
CREATE INDEX idx_users_status ON users(status);
CREATE INDEX idx_users_created_at ON users(created_at);

-- Supplier profile indexes
CREATE INDEX idx_supplier_profiles_verification_status ON supplier_profiles(verification_status);
CREATE INDEX idx_supplier_profiles_subscription_status ON supplier_profiles(subscription_status);
CREATE INDEX idx_supplier_profiles_rating_average ON supplier_profiles(rating_average);
CREATE INDEX idx_supplier_profiles_created_at ON supplier_profiles(created_at);

-- Service indexes
CREATE INDEX idx_supplier_services_supplier_id ON supplier_services(supplier_id);
CREATE INDEX idx_supplier_services_is_active ON supplier_services(is_active);
CREATE INDEX idx_supplier_services_price_min ON supplier_services(price_min);
CREATE INDEX idx_supplier_services_price_max ON supplier_services(price_max);

-- Availability indexes
CREATE INDEX idx_supplier_availability_supplier_id ON supplier_availability(supplier_id);
CREATE INDEX idx_supplier_availability_day_of_week ON supplier_availability(day_of_week);
CREATE INDEX idx_supplier_availability_is_available ON supplier_availability(is_available);

-- Chat room indexes
CREATE INDEX idx_chat_rooms_customer_id ON chat_rooms(customer_id);
CREATE INDEX idx_chat_rooms_supplier_id ON chat_rooms(supplier_id);
CREATE INDEX idx_chat_rooms_status ON chat_rooms(status);
CREATE INDEX idx_chat_rooms_last_message_at ON chat_rooms(last_message_at);
CREATE INDEX idx_chat_rooms_created_at ON chat_rooms(created_at);

-- Chat message indexes
CREATE INDEX idx_chat_messages_room_id ON chat_messages(room_id);
CREATE INDEX idx_chat_messages_sender_id ON chat_messages(sender_id);
CREATE INDEX idx_chat_messages_message_type ON chat_messages(message_type);
CREATE INDEX idx_chat_messages_created_at ON chat_messages(created_at);

-- Booking indexes
CREATE INDEX idx_bookings_customer_id ON bookings(customer_id);
CREATE INDEX idx_bookings_supplier_id ON bookings(supplier_id);
CREATE INDEX idx_bookings_service_id ON bookings(service_id);
CREATE INDEX idx_bookings_status ON bookings(status);
CREATE INDEX idx_bookings_scheduled_at ON bookings(scheduled_at);
CREATE INDEX idx_bookings_created_at ON bookings(created_at);

-- Review indexes
CREATE INDEX idx_reviews_booking_id ON reviews(booking_id);
CREATE INDEX idx_reviews_reviewer_id ON reviews(reviewer_id);
CREATE INDEX idx_reviews_reviewee_id ON reviews(reviewee_id);
CREATE INDEX idx_reviews_rating ON reviews(rating);
CREATE INDEX idx_reviews_is_public ON reviews(is_public);
CREATE INDEX idx_reviews_created_at ON reviews(created_at);

-- Category indexes
CREATE INDEX idx_categories_is_active ON categories(is_active);
CREATE INDEX idx_categories_sort_order ON categories(sort_order);

-- Region indexes
CREATE INDEX idx_regions_country_code ON regions(country_code);
CREATE INDEX idx_regions_is_active ON regions(is_active);
CREATE INDEX idx_regions_sort_order ON regions(sort_order);

-- Session indexes
CREATE INDEX idx_user_sessions_user_id ON user_sessions(user_id);
CREATE INDEX idx_user_sessions_expires_at ON user_sessions(expires_at);
CREATE INDEX idx_user_sessions_last_active_at ON user_sessions(last_active_at);

-- Composite indexes for common queries
CREATE INDEX idx_suppliers_search ON supplier_profiles(verification_status, subscription_status, rating_average);
CREATE INDEX idx_chat_messages_room_time ON chat_messages(room_id, created_at);
CREATE INDEX idx_bookings_supplier_status ON bookings(supplier_id, status);
CREATE INDEX idx_reviews_reviewee_public ON reviews(reviewee_id, is_public);
