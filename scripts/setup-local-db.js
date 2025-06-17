#!/usr/bin/env node

/**
 * Setup script for local D1 database for Tirak backend
 * This script works on both Windows and Unix-like systems
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

// Helper function to execute commands and log output
async function runCommand(command) {
  try {
    console.log(`Running: ${command}`);
    const { stdout, stderr } = await execAsync(command);
    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);
    return true;
  } catch (error) {
    console.error(`Error: ${error.message}`);
    // Continue even if command fails (e.g., database already exists)
    return false;
  }
}

async function setupDatabase() {
  console.log("Setting up local D1 database for Tirak backend...");

  // Create local database if it doesn't exist
  console.log("Creating local D1 database (if it doesn't exist)...");
  await runCommand("npx wrangler d1 create tirak-development --local");

  // Run migrations
  console.log("Running database migrations...");

  console.log("Running 001_initial_schema.sql...");
  await runCommand("npx wrangler d1 execute tirak-development --local --file=./migrations/001_initial_schema.sql");

  console.log("Running 002_add_indexes.sql...");
  await runCommand("npx wrangler d1 execute tirak-development --local --file=./migrations/002_add_indexes.sql");

  console.log("Running 003_add_analytics_tables.sql...");
  await runCommand("npx wrangler d1 execute tirak-development --local --file=./migrations/003_add_analytics_tables.sql");

  console.log("Running 004_background_jobs_tables.sql...");
  await runCommand("npx wrangler d1 execute tirak-development --local --file=./migrations/004_background_jobs_tables.sql");

  console.log("Running 004_mobile_app_features.sql...");
  await runCommand("npx wrangler d1 execute tirak-development --local --file=./migrations/004_mobile_app_features.sql");

  // Add admin user for testing
  console.log("Creating admin user for testing...");
  const adminUserQuery = `
    INSERT INTO users (id, email, phone, password_hash, user_type, status, email_verified, phone_verified) 
    VALUES (
      'admin-user-123', 
      'admin@tirak.com', 
      '+66123456789', 
      '$2a$10$XDbQHSVpkgQxdTh9xC9QOunZk5T0PlDdT5PLjRDcyZU86zaOQj9jm', -- password: admin123
      'admin', 
      'active',
      true,
      true
    )
    ON CONFLICT (id) DO NOTHING;
  `;
  
  await runCommand(`npx wrangler d1 execute tirak-development --local --command="${adminUserQuery}"`);

  console.log("Database setup complete!");
  console.log("You can now run the backend with: npx wrangler dev");
}

// Run the setup function
setupDatabase().catch(err => {
  console.error("Error setting up database:", err);
  process.exit(1);
});
