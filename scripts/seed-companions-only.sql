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

-- === Companion Experiences ===
INSERT OR IGNORE INTO companion_experiences (
    id, companion_id, title, description, duration_minutes, keywords, price, currency, is_active, created_at, updated_at
) VALUES
-- Malai Somboon (Bangkok) - City Tours, Cultural Experiences
('exp_001_1', 'companion_001', 'Grand Palace & Wat Phra Kaew Tour', 'A guided tour of the most iconic landmarks in Bangkok, including the Grand Palace and the Temple of the Emerald Buddha.', 180, '["history", "culture", "sightseeing"]', 1500, 'THB', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('exp_001_2', 'companion_001', 'Bangkok Canal Tour (Klongs)', 'Explore the traditional life along Bangkok''s canals on a long-tail boat.', 120, '["local life", "boating", "sightseeing"]', 1200, 'THB', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('exp_001_3', 'companion_001', 'Floating Market Adventure', 'Visit the vibrant Damnoen Saduak floating market and experience local commerce on the water.', 240, '["market", "food", "boating"]', 2000, 'THB', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('exp_001_4', 'companion_001', 'Street Food Discovery', 'A walking tour through Yaowarat (Chinatown) to sample the best of Bangkok''s street food.', 150, '["food", "dining", "local"]', 1000, 'THB', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

-- Pranee Navin (Chiang Mai) - Cultural Experiences, Shopping
('exp_002_1', 'companion_002', 'Doi Suthep Temple Visit', 'Journey up the mountain to the sacred Wat Phra That Doi Suthep temple for panoramic views and cultural insights.', 180, '["temple", "culture", "mountain"]', 1300, 'THB', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('exp_002_2', 'companion_002', 'Old City Temple Walk', 'A walking tour of the most significant temples within Chiang Mai''s ancient city walls.', 150, '["history", "culture", "walking tour"]', 900, 'THB', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('exp_002_3', 'companion_002', 'Traditional Lanna Crafts Workshop', 'Visit local artisan villages to see and try traditional crafts like silk weaving and umbrella painting.', 240, '["crafts", "workshop", "local"]', 1800, 'THB', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('exp_002_4', 'companion_002', 'Nimman Road Shopping Spree', 'Explore the trendy Nimmanhaemin Road, known for its boutiques, art galleries, and coffee shops.', 180, '["shopping", "fashion", "art"]', 1000, 'THB', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

-- Sunisa Chaiwat (Pattaya) - Nightlife, City Tours
('exp_003_1', 'companion_003', 'Pattaya Walking Street Night Tour', 'Experience the vibrant and electrifying atmosphere of Pattaya''s famous Walking Street.', 180, '["nightlife", "party", "entertainment"]', 2000, 'THB', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('exp_003_2', 'companion_003', 'Sanctuary of Truth Tour', 'Visit the magnificent all-wood building filled with sculptures based on traditional Buddhist and Hindu motifs.', 120, '["culture", "architecture", "sightseeing"]', 1500, 'THB', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('exp_003_3', 'companion_003', 'Island Hopping to Koh Larn', 'A day trip to the beautiful Coral Island (Koh Larn) for swimming, sunbathing, and water sports.', 360, '["beach", "island", "snorkeling"]', 2500, 'THB', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('exp_003_4', 'companion_003', 'Pattaya Viewpoint & City Highlights', 'A tour of Pattaya''s best viewpoints and key city landmarks.', 150, '["sightseeing", "viewpoint", "city tour"]', 1100, 'THB', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

-- Ratana Sunan (Phuket) - Dining, Cultural Experiences
('exp_004_1', 'companion_004', 'Phuket Old Town Food & Culture Tour', 'Explore the charming Sino-Portuguese architecture of Phuket Old Town and taste local delicacies.', 180, '["food", "history", "walking tour"]', 1400, 'THB', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('exp_004_2', 'companion_004', 'Big Buddha & Wat Chalong Visit', 'A trip to two of Phuket''s most revered landmarks: the Big Buddha and Wat Chalong temple.', 150, '["culture", "sightseeing", "temple"]', 1200, 'THB', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('exp_004_3', 'companion_004', 'Authentic Southern Thai Cooking Class', 'Learn to cook famous Southern Thai dishes in a hands-on class with a local expert.', 210, '["cooking", "food", "workshop"]', 1800, 'THB', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('exp_004_4', 'companion_004', 'Sunset Dinner at Promthep Cape', 'Enjoy a delicious seafood dinner while watching the breathtaking sunset at Promthep Cape.', 120, '["dining", "sunset", "romantic"]', 2200, 'THB', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

-- Malee Somsak (Bangkok) - Shopping, Nightlife
('exp_005_1', 'companion_005', 'Luxury Mall Shopping Experience', 'A guided shopping tour of Bangkok''s high-end malls like Siam Paragon and CentralWorld.', 240, '["shopping", "luxury", "fashion"]', 1500, 'THB', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('exp_005_2', 'companion_005', 'Chatuchak Weekend Market Hunt', 'Navigate the world''s largest weekend market to find unique items and bargain deals.', 240, '["shopping", "market", "local"]', 1200, 'THB', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('exp_005_3', 'companion_005', 'Rooftop Bar Hopping Tour', 'Visit some of Bangkok''s most stunning rooftop bars for amazing views and cocktails.', 180, '["nightlife", "drinks", "viewpoint"]', 2500, 'THB', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('exp_005_4', 'companion_005', 'Asiatique The Riverfront Evening', 'An evening of shopping, dining, and entertainment at the Asiatique open-air mall.', 210, '["shopping", "dining", "entertainment"]', 1300, 'THB', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

-- Wandee Samart (Hua Hin) - Cultural Experiences, City Tours
('exp_006_1', 'companion_006', 'Hua Hin Railway Station & Maruekhathaiyawan Palace', 'Visit the iconic Hua Hin railway station and the beautiful teakwood palace by the sea.', 180, '["history", "architecture", "sightseeing"]', 1200, 'THB', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('exp_006_2', 'companion_006', 'Khao Sam Roi Yot National Park', 'A day trip to the stunning national park to see the Phraya Nakhon Cave.', 360, '["nature", "hiking", "cave"]', 3000, 'THB', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('exp_006_3', 'companion_006', 'Hua Hin Night Market Food Tour', 'Explore the bustling night market and sample a variety of delicious local street food.', 120, '["food", "market", "nightlife"]', 800, 'THB', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('exp_006_4', 'companion_006', 'Pala-U Waterfall Adventure', 'A trip to the beautiful Pala-U waterfall located in the Kaeng Krachan National Park.', 240, '["nature", "waterfall", "hiking"]', 2200, 'THB', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

-- Siriwan Prasert (Khon Kaen) - City Tours, Cultural Experiences
('exp_007_1', 'companion_007', 'Khon Kaen City & Temple Tour', 'A tour of the main sights in Khon Kaen, including the nine-storey stupa at Wat Nong Wang.', 180, '["city tour", "temple", "culture"]', 1000, 'THB', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('exp_007_2', 'companion_007', 'Dinosaur Park Si Wiang', 'Visit the Phu Wiang Dinosaur Museum and excavation sites.', 240, '["history", "museum", "dinosaur"]', 1500, 'THB', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('exp_007_3', 'companion_007', 'Isan Culture & Food Experience', 'Discover the unique culture and spicy cuisine of the Isan region.', 210, '["culture", "food", "local"]', 1200, 'THB', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('exp_007_4', 'companion_007', 'Ubolratana Dam Visit', 'A trip to the impressive Ubolratana Dam for scenic views and relaxation.', 240, '["sightseeing", "nature", "dam"]', 1400, 'THB', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

-- Nattaya Somchai (Phuket) - Nightlife, Dining
('exp_008_1', 'companion_008', 'Bangla Road Nightlife Experience', 'A guided tour of the most famous party street in Phuket.', 180, '["nightlife", "party", "drinks"]', 2200, 'THB', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('exp_008_2', 'companion_008', 'Phuket Beach Club Tour', 'Visit some of the trendiest beach clubs in Phuket for music, drinks, and sun.', 300, '["beach", "party", "nightlife"]', 3000, 'THB', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('exp_008_3', 'companion_008', 'Fine Dining Seafood Experience', 'Enjoy a curated seafood dinner at one of Phuket''s top-rated restaurants.', 150, '["dining", "seafood", "luxury"]', 3500, 'THB', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('exp_008_4', 'companion_008', 'Simon Cabaret Show', 'An evening of spectacular entertainment at the famous Simon Cabaret show.', 120, '["entertainment", "show", "nightlife"]', 1500, 'THB', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

-- Pimchanok Anand (Bangkok) - Shopping, City Tours
('exp_009_1', 'companion_009', 'Vintage Shopping in Siam Square', 'Explore hidden thrift stores and vintage shops around Siam Square.', 180, '["shopping", "fashion", "vintage"]', 1000, 'THB', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('exp_009_2', 'companion_009', 'Jim Thompson House Museum Tour', 'Discover the beautiful traditional Thai house of Jim Thompson and learn about the silk industry.', 120, '["museum", "history", "culture"]', 800, 'THB', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('exp_009_3', 'companion_009', 'IconSiam & River Cruise', 'Visit the luxurious IconSiam mall and take a scenic dinner cruise on the Chao Phraya River.', 240, '["shopping", "dining", "cruise"]', 2800, 'THB', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('exp_009_4', 'companion_009', 'Bangkok Art & Culture Centre (BACC)', 'A guided tour of the contemporary art exhibits at BACC.', 150, '["art", "culture", "museum"]', 700, 'THB', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

-- Lalana Wichit (Chiang Mai) - Dining, Cultural Experiences
('exp_010_1', 'companion_010', 'Northern Thai Cuisine Discovery', 'A food tour dedicated to tasting famous Lanna dishes like Khao Soi and Sai Oua.', 180, '["food", "dining", "local"]', 1300, 'THB', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('exp_010_2', 'companion_010', 'Elephant Sanctuary Visit', 'An ethical experience visiting an elephant sanctuary to feed and bathe the elephants.', 240, '["nature", "animals", "ethical tourism"]', 2500, 'THB', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('exp_010_3', 'companion_010', 'Wiang Kum Kam Ancient City Tour', 'Explore the ruins of the ancient city of Wiang Kum Kam by horse-drawn carriage.', 150, '["history", "ruins", "culture"]', 1100, 'THB', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('exp_010_4', 'companion_010', 'Chiang Mai Night Safari', 'An evening adventure at the Chiang Mai Night Safari to see nocturnal animals.', 210, '["animals", "nightlife", "nature"]', 1800, 'THB', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP); 