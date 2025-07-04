-- === 10 Female Companions (seeded) ===
-- Password for all: companion123 (hash below is bcrypt for 'companion123')
INSERT OR IGNORE INTO users (
    id, email, phone, password_hash, user_type, status, email_verified, phone_verified, preferred_language, created_at, updated_at
) VALUES
('companion_001', 'malai.somboon.1@gmail.com', '+66812340001', '$2a$12$LQv3c1yqBwEHXw.9UdN.ue6tMZjz2Z8qJ5U5J5U5J5U5J5U5J5U5J5', 'companion', 'active', TRUE, TRUE, 'th', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('companion_002', 'pranee.navin.2@gmail.com', '+66812340002', '$2a$12$LQv3c1yqBwEHXw.9UdN.ue6tMZjz2Z8qJ5U5J5U5J5U5J5U5J5U5J5', 'companion', 'active', TRUE, TRUE, 'th', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('companion_003', 'sunisa.chaiwat.3@gmail.com', '+66812340003', '$2a$12$LQv3c1yqBwEHXw.9UdN.ue6tMZjz2Z8qJ5U5J5U5J5U5J5U5J5U5J5', 'companion', 'active', TRUE, TRUE, 'th', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('companion_004', 'ratana.sunan.4@gmail.com', '+66812340004', '$2a$12$LQv3c1yqBwEHXw.9UdN.ue6tMZjz2Z8qJ5U5J5U5J5U5J5U5J5U5J5', 'companion', 'active', TRUE, TRUE, 'th', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('companion_005', 'malee.somsak.5@gmail.com', '+66812340005', '$2a$12$LQv3c1yqBwEHXw.9UdN.ue6tMZjz2Z8qJ5U5J5U5J5U5J5U5J5U5J5', 'companion', 'active', TRUE, TRUE, 'th', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('companion_006', 'wandee.samart.6@gmail.com', '+66812340006', '$2a$12$LQv3c1yqBwEHXw.9UdN.ue6tMZjz2Z8qJ5U5J5U5J5U5J5U5J5U5J5', 'companion', 'active', TRUE, TRUE, 'th', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('companion_007', 'siriwan.prasert.7@gmail.com', '+66812340007', '$2a$12$LQv3c1yqBwEHXw.9UdN.ue6tMZjz2Z8qJ5U5J5U5J5U5J5U5J5U5J5', 'companion', 'active', TRUE, TRUE, 'th', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('companion_008', 'nattaya.somchai.8@gmail.com', '+66812340008', '$2a$12$LQv3c1yqBwEHXw.9UdN.ue6tMZjz2Z8qJ5U5J5U5J5U5J5U5J5U5J5', 'companion', 'active', TRUE, TRUE, 'th', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('companion_009', 'pimchanok.anand.9@gmail.com', '+66812340009', '$2a$12$LQv3c1yqBwEHXw.9UdN.ue6tMZjz2Z8qJ5U5J5U5J5U5J5U5J5U5J5', 'companion', 'active', TRUE, TRUE, 'th', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('companion_010', 'lalana.wichit.10@gmail.com', '+66812340010', '$2a$12$LQv3c1yqBwEHXw.9UdN.ue6tMZjz2Z8qJ5U5J5U5J5U5J5U5J5U5J5', 'companion', 'active', TRUE, TRUE, 'th', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

INSERT OR IGNORE INTO companion_profiles (
    id, user_id, first_name, last_name, display_name, bio, social_links, date_of_birth, gender, cover_photo, profile_photo, location, languages, specialization, certifications, created_at, updated_at
) VALUES
('cp_001', 'companion_001', 'Malai', 'Somboon', 'Malai Somboon', 'Professional tour guide in Bangkok with expertise in cultural sites', NULL, '1992-01-15', 'female', 'https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=facearea&w=600&q=80', 'https://randomuser.me/api/portraits/women/21.jpg', 'Bangkok', '["th","en"]', '["City Tours","Cultural Experiences"]', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('cp_002', 'companion_002', 'Pranee', 'Navin', 'Pranee Navin', 'Expert in Chiang Mai culture and traditional experiences', NULL, '1990-02-22', 'female', 'https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=facearea&w=600&q=80', 'https://randomuser.me/api/portraits/women/22.jpg', 'Chiang Mai', '["th","en"]', '["Cultural Experiences","Shopping"]', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('cp_003', 'companion_003', 'Sunisa', 'Chaiwat', 'Sunisa Chaiwat', 'Nightlife specialist in Pattaya with local connections', NULL, '1993-03-13', 'female', 'https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=facearea&w=600&q=80', 'https://randomuser.me/api/portraits/women/23.jpg', 'Pattaya', '["th","en","jp"]', '["Nightlife","City Tours"]', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('cp_004', 'companion_004', 'Ratana', 'Sunan', 'Ratana Sunan', 'Foodie and dining companion in Phuket with knowledge of hidden gems', NULL, '1991-04-24', 'female', 'https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=facearea&w=600&q=80', 'https://randomuser.me/api/portraits/women/24.jpg', 'Phuket', '["th","en","cn"]', '["Dining","Cultural Experiences"]', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('cp_005', 'companion_005', 'Malee', 'Somsak', 'Malee Somsak', 'Shopping assistant specializing in luxury brands in Bangkok', NULL, '1994-05-05', 'female', 'https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=facearea&w=600&q=80', 'https://randomuser.me/api/portraits/women/25.jpg', 'Bangkok', '["th","en"]', '["Shopping","Nightlife"]', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('cp_006', 'companion_006', 'Wandee', 'Samart', 'Wandee Samart', 'Cultural guide in Hua Hin with historical expertise', NULL, '1989-06-16', 'female', 'https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=facearea&w=600&q=80', 'https://randomuser.me/api/portraits/women/26.jpg', 'Hua Hin', '["th","en"]', '["Cultural Experiences","City Tours"]', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('cp_007', 'companion_007', 'Siriwan', 'Prasert', 'Siriwan Prasert', 'Tour guide in Khon Kaen with focus on local traditions', NULL, '1992-07-27', 'female', 'https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=facearea&w=600&q=80', 'https://randomuser.me/api/portraits/women/27.jpg', 'Khon Kaen', '["th","en"]', '["City Tours","Cultural Experiences"]', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('cp_008', 'companion_008', 'Nattaya', 'Somchai', 'Nattaya Somchai', 'Nightlife and events specialist in Phuket', NULL, '1993-08-18', 'female', 'https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=facearea&w=600&q=80', 'https://randomuser.me/api/portraits/women/28.jpg', 'Phuket', '["th","en","ru"]', '["Nightlife","Dining"]', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('cp_009', 'companion_009', 'Pimchanok', 'Anand', 'Pimchanok Anand', 'Tour and shopping expert in Bangkok with fashion background', NULL, '1990-09-09', 'female', 'https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=facearea&w=600&q=80', 'https://randomuser.me/api/portraits/women/29.jpg', 'Bangkok', '["th","en","kr"]', '["Shopping","City Tours"]', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('cp_010', 'companion_010', 'Lalana', 'Wichit', 'Lalana Wichit', 'Dining and cultural experiences specialist in Chiang Mai', NULL, '1991-10-30', 'female', 'https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=facearea&w=600&q=80', 'https://randomuser.me/api/portraits/women/30.jpg', 'Chiang Mai', '["th","en"]', '["Dining","Cultural Experiences"]', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- === Availability for each companion: 7 days, 09:00–17:00 ===
INSERT OR IGNORE INTO supplier_availability (
    id, supplier_id, day_of_week, start_time, end_time, is_available, created_at, updated_at
) VALUES
-- Malai Somboon
('avail_001_0', 'companion_001', 0, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('avail_001_1', 'companion_001', 1, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('avail_001_2', 'companion_001', 2, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('avail_001_3', 'companion_001', 3, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('avail_001_4', 'companion_001', 4, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('avail_001_5', 'companion_001', 5, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('avail_001_6', 'companion_001', 6, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
-- Pranee Navin
('avail_002_0', 'companion_002', 0, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('avail_002_1', 'companion_002', 1, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('avail_002_2', 'companion_002', 2, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('avail_002_3', 'companion_002', 3, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('avail_002_4', 'companion_002', 4, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('avail_002_5', 'companion_002', 5, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('avail_002_6', 'companion_002', 6, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
-- Sunisa Chaiwat
('avail_003_0', 'companion_003', 0, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('avail_003_1', 'companion_003', 1, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('avail_003_2', 'companion_003', 2, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('avail_003_3', 'companion_003', 3, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('avail_003_4', 'companion_003', 4, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('avail_003_5', 'companion_003', 5, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('avail_003_6', 'companion_003', 6, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
-- Ratana Sunan
('avail_004_0', 'companion_004', 0, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('avail_004_1', 'companion_004', 1, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('avail_004_2', 'companion_004', 2, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('avail_004_3', 'companion_004', 3, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('avail_004_4', 'companion_004', 4, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('avail_004_5', 'companion_004', 5, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('avail_004_6', 'companion_004', 6, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
-- Malee Somsak
('avail_005_0', 'companion_005', 0, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('avail_005_1', 'companion_005', 1, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('avail_005_2', 'companion_005', 2, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('avail_005_3', 'companion_005', 3, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('avail_005_4', 'companion_005', 4, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('avail_005_5', 'companion_005', 5, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('avail_005_6', 'companion_005', 6, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
-- Wandee Samart
('avail_006_0', 'companion_006', 0, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('avail_006_1', 'companion_006', 1, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('avail_006_2', 'companion_006', 2, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('avail_006_3', 'companion_006', 3, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('avail_006_4', 'companion_006', 4, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('avail_006_5', 'companion_006', 5, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('avail_006_6', 'companion_006', 6, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
-- Siriwan Prasert
('avail_007_0', 'companion_007', 0, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('avail_007_1', 'companion_007', 1, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('avail_007_2', 'companion_007', 2, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('avail_007_3', 'companion_007', 3, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('avail_007_4', 'companion_007', 4, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('avail_007_5', 'companion_007', 5, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('avail_007_6', 'companion_007', 6, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
-- Nattaya Somchai
('avail_008_0', 'companion_008', 0, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('avail_008_1', 'companion_008', 1, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('avail_008_2', 'companion_008', 2, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('avail_008_3', 'companion_008', 3, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('avail_008_4', 'companion_008', 4, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('avail_008_5', 'companion_008', 5, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('avail_008_6', 'companion_008', 6, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
-- Pimchanok Anand
('avail_009_0', 'companion_009', 0, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('avail_009_1', 'companion_009', 1, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('avail_009_2', 'companion_009', 2, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('avail_009_3', 'companion_009', 3, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('avail_009_4', 'companion_009', 4, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('avail_009_5', 'companion_009', 5, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('avail_009_6', 'companion_009', 6, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
-- Lalana Wichit
('avail_010_0', 'companion_010', 0, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('avail_010_1', 'companion_010', 1, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('avail_010_2', 'companion_010', 2, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('avail_010_3', 'companion_010', 3, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('avail_010_4', 'companion_010', 4, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('avail_010_5', 'companion_010', 5, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('avail_010_6', 'companion_010', 6, '09:00', '17:00', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP); 