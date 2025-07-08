-- === 3 Sample Customers ===
INSERT OR IGNORE INTO users (
    id, email, phone, password_hash, user_type, status, email_verified, phone_verified, preferred_language, created_at, updated_at
) VALUES
('customer_001', 'test.customer.1@example.com', '+14155550101', '$2a$12$LQv3c1yqBwEHXw.9UdN.ue6tMZjz2Z8qJ5U5J5U5J5U5J5U5J5U5J5', 'customer', 'active', TRUE, TRUE, 'en', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('customer_002', 'test.customer.2@example.com', '+14155550102', '$2a$12$LQv3c1yqBwEHXw.9UdN.ue6tMZjz2Z8qJ5U5J5U5J5U5J5U5J5U5J5', 'customer', 'active', TRUE, TRUE, 'en', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('customer_003', 'test.customer.3@example.com', '+14155550103', '$2a$12$LQv3c1yqBwEHXw.9UdN.ue6tMZjz2Z8qJ5U5J5U5J5U5J5U5J5U5J5', 'customer', 'active', TRUE, TRUE, 'en', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

INSERT OR IGNORE INTO customer_profiles (
    user_id, display_name, created_at, updated_at
) VALUES
('customer_001', 'John Doe', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('customer_002', 'Jane Smith', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('customer_003', 'Alex Ray', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- === 9 Sample Bookings (3 for each customer) ===
INSERT OR IGNORE INTO bookings (
    id, customer_id, companion_id, experience_id, date, start_time, end_time, duration, location, status, total_amount, service_fee, payment_status, created_at, updated_at
) VALUES
-- Bookings for Customer 1 (John Doe)
('booking_001', 'customer_001', 'companion_001', 'exp_001_1', '2024-08-10', '10:00', '13:00', 180, 'Grand Palace, Bangkok', 'confirmed', 1650, 150, 'paid', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('booking_002', 'customer_001', 'companion_004', 'exp_004_1', '2024-08-12', '18:00', '21:00', 180, 'Old Town, Phuket', 'pending', 1540, 140, 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('booking_003', 'customer_001', 'companion_005', 'exp_005_3', '2024-08-15', '20:00', '23:00', 180, 'Rooftop Bar, Bangkok', 'completed', 2750, 250, 'paid', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

-- Bookings for Customer 2 (Jane Smith)
('booking_004', 'customer_002', 'companion_002', 'exp_002_1', '2024-08-11', '09:00', '12:00', 180, 'Doi Suthep, Chiang Mai', 'completed', 1430, 130, 'paid', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('booking_005', 'customer_002', 'companion_008', 'exp_008_1', '2024-08-14', '21:00', '00:00', 180, 'Bangla Road, Phuket', 'confirmed', 2420, 220, 'paid', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('booking_006', 'customer_002', 'companion_010', 'exp_010_2', '2024-08-18', '10:00', '14:00', 240, 'Elephant Sanctuary, Chiang Mai', 'confirmed', 2750, 250, 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

-- Bookings for Customer 3 (Alex Ray)
('booking_007', 'customer_003', 'companion_003', 'exp_003_3', '2024-08-20', '10:00', '16:00', 360, 'Koh Larn, Pattaya', 'cancelled', 2750, 250, 'refunded', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('booking_008', 'customer_003', 'companion_007', 'exp_007_3', '2024-08-22', '12:00', '15:30', 210, 'Khon Kaen', 'confirmed', 1320, 120, 'paid', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('booking_009', 'customer_003', 'companion_009', 'exp_009_1', '2024-08-25', '14:00', '17:00', 180, 'Siam Square, Bangkok', 'pending', 1100, 100, 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP); 