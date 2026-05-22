-- Persist mobile registration and companion setup fields.
-- These fields back the current traveler and local-guide onboarding/edit flows.

ALTER TABLE supplier_profiles ADD COLUMN first_name TEXT;
ALTER TABLE supplier_profiles ADD COLUMN last_name TEXT;
ALTER TABLE supplier_profiles ADD COLUMN cover_photo TEXT;
ALTER TABLE supplier_profiles ADD COLUMN location TEXT;
ALTER TABLE supplier_profiles ADD COLUMN social_links TEXT DEFAULT '{}';
ALTER TABLE supplier_profiles ADD COLUMN date_of_birth TEXT;
ALTER TABLE supplier_profiles ADD COLUMN gender TEXT CHECK (gender IN ('male', 'female', 'other'));
ALTER TABLE supplier_profiles ADD COLUMN certifications TEXT DEFAULT '[]';
ALTER TABLE supplier_profiles ADD COLUMN experience_stats TEXT DEFAULT '{}';

ALTER TABLE customer_profiles ADD COLUMN bio TEXT;
