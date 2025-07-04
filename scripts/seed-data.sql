
-- === 10 Companions (seeded) ===
-- Password for all: companion123 (hash below is bcrypt for 'companion123')
INSERT OR IGNORE INTO users (
    id, email, phone, password_hash, user_type, status, email_verified, phone_verified, preferred_language, created_at, updated_at
) VALUES
('companion_001', 'somchai.sukjai.1@gmail.com', '+66812340001', '$2a$12$LQv3c1yqBwEHXw.9UdN.ue6tMZjz2Z8qJ5U5J5U5J5U5J5U5J5U5J5', 'companion', 'active', TRUE, TRUE, 'th', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('companion_002', 'orathai.thongdee.2@gmail.com', '+66812340002', '$2a$12$LQv3c1yqBwEHXw.9UdN.ue6tMZjz2Z8qJ5U5J5U5J5U5J5U5J5U5J5', 'companion', 'active', TRUE, TRUE, 'th', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('companion_003', 'wichai.jaidee.3@gmail.com', '+66812340003', '$2a$12$LQv3c1yqBwEHXw.9UdN.ue6tMZjz2Z8qJ5U5J5U5J5U5J5U5J5U5J5', 'companion', 'active', TRUE, TRUE, 'th', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('companion_004', 'supaporn.srisuk.4@gmail.com', '+66812340004', '$2a$12$LQv3c1yqBwEHXw.9UdN.ue6tMZjz2Z8qJ5U5J5U5J5U5J5U5J5U5J5', 'companion', 'active', TRUE, TRUE, 'th', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('companion_005', 'preecha.wattanakul.5@gmail.com', '+66812340005', '$2a$12$LQv3c1yqBwEHXw.9UdN.ue6tMZjz2Z8qJ5U5J5U5J5U5J5U5J5U5J5', 'companion', 'active', TRUE, TRUE, 'th', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('companion_006', 'siriporn.boonmee.6@gmail.com', '+66812340006', '$2a$12$LQv3c1yqBwEHXw.9UdN.ue6tMZjz2Z8qJ5U5J5U5J5U5J5U5J5U5J5', 'companion', 'active', TRUE, TRUE, 'th', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('companion_007', 'anan.rattanakul.7@gmail.com', '+66812340007', '$2a$12$LQv3c1yqBwEHXw.9UdN.ue6tMZjz2Z8qJ5U5J5U5J5U5J5U5J5U5J5', 'companion', 'active', TRUE, TRUE, 'th', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('companion_008', 'jaruwan.janphen.8@gmail.com', '+66812340008', '$2a$12$LQv3c1yqBwEHXw.9UdN.ue6tMZjz2Z8qJ5U5J5U5J5U5J5U5J5U5J5', 'companion', 'active', TRUE, TRUE, 'th', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('companion_009', 'kanya.sukjai.9@gmail.com', '+66812340009', '$2a$12$LQv3c1yqBwEHXw.9UdN.ue6tMZjz2Z8qJ5U5J5U5J5U5J5U5J5U5J5', 'companion', 'active', TRUE, TRUE, 'th', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('companion_010', 'manop.thongdee.10@gmail.com', '+66812340010', '$2a$12$LQv3c1yqBwEHXw.9UdN.ue6tMZjz2Z8qJ5U5J5U5J5U5J5U5J5U5J5', 'companion', 'active', TRUE, TRUE, 'th', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

INSERT OR IGNORE INTO companion_profiles (
    id, user_id, first_name, last_name, display_name, bio, social_links, date_of_birth, gender, cover_photo, profile_photo, location, languages, specialization, certifications, created_at, updated_at
) VALUES
('cp_001', 'companion_001', 'Somchai', 'Sukjai', 'Somchai Sukjai', 'Professional tour guide in Bangkok', NULL, '1985-01-01', 'male', 'https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=facearea&w=600&q=80', 'https://randomuser.me/api/portraits/men/11.jpg', 'Bangkok', '["th","en"]', '["City Tours","Nightlife"]', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('cp_002', 'companion_002', 'Orathai', 'Thongdee', 'Orathai Thongdee', 'Expert in Chiang Mai culture', NULL, '1990-02-02', 'female', 'https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=facearea&w=600&q=80', 'https://randomuser.me/api/portraits/women/12.jpg', 'Chiang Mai', '["th","en"]', '["Cultural Experiences"]', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('cp_003', 'companion_003', 'Wichai', 'Jaidee', 'Wichai Jaidee', 'Nightlife specialist in Pattaya', NULL, '1988-03-03', 'male', 'https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=facearea&w=600&q=80', 'https://randomuser.me/api/portraits/men/13.jpg', 'Pattaya', '["th","en"]', '["Nightlife"]', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('cp_004', 'companion_004', 'Supaporn', 'Srisuk', 'Supaporn Srisuk', 'Foodie and dining companion in Phuket', NULL, '1992-04-04', 'female', 'https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=facearea&w=600&q=80', 'https://randomuser.me/api/portraits/women/14.jpg', 'Phuket', '["th","en"]', '["Dining"]', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('cp_005', 'companion_005', 'Preecha', 'Wattanakul', 'Preecha Wattanakul', 'Shopping assistant in Ayutthaya', NULL, '1987-05-05', 'male', 'https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=facearea&w=600&q=80', 'https://randomuser.me/api/portraits/men/15.jpg', 'Ayutthaya', '["th","en"]', '["Shopping"]', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('cp_006', 'companion_006', 'Siriporn', 'Boonmee', 'Siriporn Boonmee', 'Cultural guide in Hua Hin', NULL, '1991-06-06', 'female', 'https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=facearea&w=600&q=80', 'https://randomuser.me/api/portraits/women/16.jpg', 'Hua Hin', '["th","en"]', '["Cultural Experiences"]', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('cp_007', 'companion_007', 'Anan', 'Rattanakul', 'Anan Rattanakul', 'Tour guide in Khon Kaen', NULL, '1986-07-07', 'male', 'https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=facearea&w=600&q=80', 'https://randomuser.me/api/portraits/men/17.jpg', 'Khon Kaen', '["th","en"]', '["City Tours"]', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('cp_008', 'companion_008', 'Jaruwan', 'Janphen', 'Jaruwan Janphen', 'Nightlife and events in Udon Thani', NULL, '1993-08-08', 'female', 'https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=facearea&w=600&q=80', 'https://randomuser.me/api/portraits/women/18.jpg', 'Udon Thani', '["th","en"]', '["Nightlife"]', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('cp_009', 'companion_009', 'Kanya', 'Sukjai', 'Kanya Sukjai', 'Tour and shopping in Bangkok', NULL, '1989-09-09', 'female', 'https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=facearea&w=600&q=80', 'https://randomuser.me/api/portraits/women/19.jpg', 'Bangkok', '["th","en"]', '["Shopping"]', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('cp_010', 'companion_010', 'Manop', 'Thongdee', 'Manop Thongdee', 'Dining and nightlife in Pattaya', NULL, '1984-10-10', 'male', 'https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=facearea&w=600&q=80', 'https://randomuser.me/api/portraits/men/20.jpg', 'Pattaya', '["th","en"]', '["Dining","Nightlife"]', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- === 10 Customers (seeded) ===
-- Password for all: customer123 (hash below is bcrypt for 'customer123')
INSERT OR IGNORE INTO users (
    id, email, phone, password_hash, user_type, status, email_verified, phone_verified, preferred_language, created_at, updated_at
) VALUES
('customer_011', 'wichai.srisuk.11@gmail.com', '+66812341011', '$2a$12$LQv3c1yqBwEHXw.9UdN.ue6tMZjz2Z8qJ5U5J5U5J5U5J5U5J5U5J5', 'customer', 'active', TRUE, TRUE, 'th', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('customer_012', 'supaporn.jaidee.12@gmail.com', '+66812341012', '$2a$12$LQv3c1yqBwEHXw.9UdN.ue6tMZjz2Z8qJ5U5J5U5J5U5J5U5J5U5J5', 'customer', 'active', TRUE, TRUE, 'th', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('customer_013', 'preecha.sukjai.13@gmail.com', '+66812341013', '$2a$12$LQv3c1yqBwEHXw.9UdN.ue6tMZjz2Z8qJ5U5J5U5J5U5J5U5J5U5J5', 'customer', 'active', TRUE, TRUE, 'th', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('customer_014', 'siriporn.thongdee.14@gmail.com', '+66812341014', '$2a$12$LQv3c1yqBwEHXw.9UdN.ue6tMZjz2Z8qJ5U5J5U5J5U5J5U5J5U5J5', 'customer', 'active', TRUE, TRUE, 'th', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('customer_015', 'anan.janphen.15@gmail.com', '+66812341015', '$2a$12$LQv3c1yqBwEHXw.9UdN.ue6tMZjz2Z8qJ5U5J5U5J5U5J5U5J5U5J5', 'customer', 'active', TRUE, TRUE, 'th', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('customer_016', 'jaruwan.boonmee.16@gmail.com', '+66812341016', '$2a$12$LQv3c1yqBwEHXw.9UdN.ue6tMZjz2Z8qJ5U5J5U5J5U5J5U5J5U5J5', 'customer', 'active', TRUE, TRUE, 'th', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('customer_017', 'kanya.rattanakul.17@gmail.com', '+66812341017', '$2a$12$LQv3c1yqBwEHXw.9UdN.ue6tMZjz2Z8qJ5U5J5U5J5U5J5U5J5U5J5', 'customer', 'active', TRUE, TRUE, 'th', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('customer_018', 'manop.srisuk.18@gmail.com', '+66812341018', '$2a$12$LQv3c1yqBwEHXw.9UdN.ue6tMZjz2Z8qJ5U5J5U5J5U5J5U5J5U5J5', 'customer', 'active', TRUE, TRUE, 'th', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('customer_019', 'somchai.jaidee.19@gmail.com', '+66812341019', '$2a$12$LQv3c1yqBwEHXw.9UdN.ue6tMZjz2Z8qJ5U5J5U5J5U5J5U5J5U5J5', 'customer', 'active', TRUE, TRUE, 'th', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('customer_020', 'orathai.wattanakul.20@gmail.com', '+66812341020', '$2a$12$LQv3c1yqBwEHXw.9UdN.ue6tMZjz2Z8qJ5U5J5U5J5U5J5U5J5U5J5', 'customer', 'active', TRUE, TRUE, 'th', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

INSERT OR IGNORE INTO customer_profiles (
    user_id, display_name, preferences, created_at, updated_at
) VALUES
('customer_011', 'Wichai Srisuk', '{"language":"th"}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('customer_012', 'Supaporn Jaidee', '{"language":"th"}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('customer_013', 'Preecha Sukjai', '{"language":"th"}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('customer_014', 'Siriporn Thongdee', '{"language":"th"}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('customer_015', 'Anan Janphen', '{"language":"th"}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('customer_016', 'Jaruwan Boonmee', '{"language":"th"}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('customer_017', 'Kanya Rattanakul', '{"language":"th"}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('customer_018', 'Manop Srisuk', '{"language":"th"}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('customer_019', 'Somchai Jaidee', '{"language":"th"}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('customer_020', 'Orathai Wattanakul', '{"language":"th"}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
