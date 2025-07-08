# Changelog

All notable changes to the Tirak Backend will be documented in this file.

## [Unreleased]

### Fixed
- **Auth**: Fixed an issue in the login route where the display name for 'companion' users was being looked up in the wrong table. It now correctly queries `companion_profiles`.
- **Auth**: Fixed user registration to use the provided `name` for the profile's `displayName` instead of deriving it from the email.
- **API**: Resolved an issue where companion experiences were not being returned from the `GET /api/companions/:id/experiences` endpoint. The fix involved:
  - Removing a duplicate, conflicting route handler for the same path.
  - Correcting a JSON parsing error for the `keywords` field which could fail silently.
  - Ensuring the endpoint correctly handles pagination and returns experience data even if the associated companion profile is missing from `supplier_profiles`.
- Fixed "no such table: companion_experiences" error by adding automatic database migration checks
- Added graceful error handling for missing tables in companions route
- Created utility scripts for applying specific migrations
- **Database**: Fixed "no such table: companion_profiles" error by creating migration 010_add_companion_profiles_table.sql to add the missing companion_profiles table
- **Storage**: Fixed image serving issue by creating a new `/api/uploads/:type/:userId/:filename` route to serve images from R2 storage through Workers API instead of relying on custom domain
- **API**: Fixed companion details endpoint (`GET /api/companions/:id`) to use `companion_profiles` table instead of `supplier_profiles` table, resolving "Companion not found" errors
- **API**: Fixed duplicate companion entries in "get all companions" endpoint by adding SELECT DISTINCT to prevent multiple rows from LEFT JOIN with companion_experiences
- **API**: Fixed 500 Internal Server Error in companion details endpoint by adding null checks for database query results and safe JSON parsing with try-catch blocks
- **API**: Fixed reviews query in companion details endpoint to use `companion_profiles` table for reviewer display names and profile images
- **API**: Fixed companion details endpoint to use LEFT JOIN like "get all companions" endpoint, allowing companions without profiles to be retrieved

### Added
- Database migration documentation in DATABASE_MIGRATIONS.md
- Error fix guide in ERROR_COMPANION_EXPERIENCES_FIX.md
- Automatic database table check on application startup
- Helper scripts for database migration management

## [1.0.0] - 2023-06-30

### Added
- Initial release of the Tirak Backend application
- Core API endpoints for user management
- Booking and payment workflows
- Chat and notification systems
- Mobile application support
- Admin dashboard APIs 