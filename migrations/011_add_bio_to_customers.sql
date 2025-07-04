-- Migration 011: Add bio column to customer_profiles
-- This migration adds a text column for biographical information to the customer_profiles table.

ALTER TABLE customer_profiles ADD COLUMN bio TEXT; 