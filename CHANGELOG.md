# Changelog

All notable changes to the Tirak Backend will be documented in this file.

## [Unreleased]

### Fixed
- **API**: Resolved an issue where companion experiences were not being returned from the `GET /api/companions/:id/experiences` endpoint. The fix involved:
  - Removing a duplicate, conflicting route handler for the same path.
  - Correcting a JSON parsing error for the `keywords` field which could fail silently.
  - Ensuring the endpoint correctly handles pagination and returns experience data even if the associated companion profile is missing from `supplier_profiles`.
- Fixed "no such table: companion_experiences" error by adding automatic database migration checks
- Added graceful error handling for missing tables in companions route
- Created utility scripts for applying specific migrations

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