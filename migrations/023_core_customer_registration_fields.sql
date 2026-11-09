-- Core registration fields required by createCustomerProfile.
-- Apply once after the reviewed canonical baseline. Never replay the
-- quarantined historical migration chain to initialize an isolated QA DB.
ALTER TABLE customer_profiles ADD COLUMN date_of_birth TEXT;
ALTER TABLE customer_profiles ADD COLUMN gender TEXT
  CHECK (gender IN ('male', 'female', 'other'));
