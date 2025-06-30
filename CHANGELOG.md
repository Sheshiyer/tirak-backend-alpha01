# Changelog

All notable changes to the Tirak Backend will be documented in this file.

## [Unreleased]

### Fixed
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