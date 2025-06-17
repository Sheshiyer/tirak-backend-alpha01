#!/bin/bash

# Script to create and set up local D1 database for Tirak backend

echo "Setting up local D1 database for Tirak backend..."

# Create local database if it doesn't exist
echo "Creating local D1 database (if it doesn't exist)..."
npx wrangler d1 create tirak-development --local || echo "Database might already exist, continuing..."

# Run migrations
echo "Running database migrations..."

echo "Running 001_initial_schema.sql..."
npx wrangler d1 execute tirak-development --local --file=./migrations/001_initial_schema.sql

echo "Running 002_add_indexes.sql..."
npx wrangler d1 execute tirak-development --local --file=./migrations/002_add_indexes.sql

echo "Running 003_add_analytics_tables.sql..."
npx wrangler d1 execute tirak-development --local --file=./migrations/003_add_analytics_tables.sql

echo "Running 004_background_jobs_tables.sql..."
npx wrangler d1 execute tirak-development --local --file=./migrations/004_background_jobs_tables.sql

echo "Running 004_mobile_app_features.sql..."
npx wrangler d1 execute tirak-development --local --file=./migrations/004_mobile_app_features.sql

# Add admin user for testing
echo "Creating admin user for testing..."
npx wrangler d1 execute tirak-development --local --command="
INSERT INTO users (id, email, phone, password_hash, user_type, status, email_verified, phone_verified) 
VALUES (
  'admin-user-123', 
  'admin@tirak.com', 
  '+66123456789', 
  '\$2a\$10\$XDbQHSVpkgQxdTh9xC9QOunZk5T0PlDdT5PLjRDcyZU86zaOQj9jm', -- password: admin123
  'admin', 
  'active',
  true,
  true
)
ON CONFLICT (id) DO NOTHING;
"

echo "Database setup complete!"
echo "You can now run the backend with: npx wrangler dev"
