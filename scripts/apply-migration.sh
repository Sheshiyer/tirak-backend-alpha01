#!/bin/bash

# Usage: ./apply-migration.sh [migration_number]
# Example: ./apply-migration.sh 009

if [ -z "$1" ]; then
  echo "Error: Migration number is required."
  echo "Usage: ./apply-migration.sh [migration_number]"
  echo "Example: ./apply-migration.sh 009"
  exit 1
fi

MIGRATION_NUMBER=$1
MIGRATION_FILE="../migrations/${MIGRATION_NUMBER}_*.sql"

# Find the migration file
MIGRATION_PATH=$(find migrations -name "${MIGRATION_NUMBER}_*.sql" | head -n 1)

if [ -z "$MIGRATION_PATH" ]; then
  echo "Error: Migration file not found for number $MIGRATION_NUMBER"
  echo "Available migrations:"
  ls -la migrations/
  exit 1
fi

echo "Found migration: $MIGRATION_PATH"

# Apply the migration
echo "Applying migration..."
npx wrangler d1 execute TIRAK_DB --file="./$MIGRATION_PATH"

# Check if the command was successful
if [ $? -eq 0 ]; then
  echo "Migration applied successfully!"
else
  echo "Failed to apply migration. Check error messages above."
  exit 1
fi 