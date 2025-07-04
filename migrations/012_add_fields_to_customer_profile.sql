-- Migration 012: Add missing profile fields to customer_profiles table.
-- This makes the customer profile more aligned with the companion profile
-- for fields that are common in the API update payload.

ALTER TABLE customer_profiles ADD COLUMN date_of_birth TEXT;
ALTER TABLE customer_profiles ADD COLUMN gender TEXT;
ALTER TABLE customer_profiles ADD COLUMN social_links TEXT;
ALTER TABLE customer_profiles ADD COLUMN profile_images TEXT; 