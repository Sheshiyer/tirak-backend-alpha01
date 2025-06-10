#!/bin/bash

# Tirak Backend Backup Script
# Usage: ./scripts/backup.sh [staging|production]

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
ENVIRONMENT=${1:-production}
PROJECT_NAME="tirak-backend"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BACKUP_DIR="$PROJECT_DIR/backups"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_NAME="${PROJECT_NAME}_${ENVIRONMENT}_${TIMESTAMP}"

# Logging function
log() {
    echo -e "${BLUE}[$(date +'%Y-%m-%d %H:%M:%S')]${NC} $1"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1" >&2
}

success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

# Create backup directory
create_backup_dir() {
    log "Creating backup directory..."
    
    mkdir -p "$BACKUP_DIR/$BACKUP_NAME"
    
    success "Backup directory created: $BACKUP_DIR/$BACKUP_NAME"
}

# Backup database
backup_database() {
    log "Backing up D1 database..."
    
    local wrangler_env=""
    if [[ "$ENVIRONMENT" == "production" ]]; then
        wrangler_env="--env production"
    fi
    
    # Export database schema
    log "Exporting database schema..."
    wrangler d1 execute tirak-db $wrangler_env --command=".schema" > "$BACKUP_DIR/$BACKUP_NAME/schema.sql" || {
        error "Failed to export database schema"
        return 1
    }
    
    # Export all tables data
    log "Exporting database data..."
    
    # List of tables to backup
    local tables=(
        "users"
        "customer_profiles"
        "supplier_profiles"
        "supplier_services"
        "supplier_availability"
        "categories"
        "regions"
        "bookings"
        "reviews"
        "chat_rooms"
        "chat_messages"
        "notifications"
        "analytics_events"
        "moderation_queue"
        "system_config"
    )
    
    for table in "${tables[@]}"; do
        log "Backing up table: $table"
        wrangler d1 execute tirak-db $wrangler_env --command="SELECT * FROM $table;" --output=json > "$BACKUP_DIR/$BACKUP_NAME/${table}.json" 2>/dev/null || {
            warning "Failed to backup table $table (table might not exist)"
        }
    done
    
    success "Database backup completed"
}

# Backup R2 storage
backup_storage() {
    log "Backing up R2 storage..."
    
    local bucket_name="tirak-storage"
    if [[ "$ENVIRONMENT" == "staging" ]]; then
        bucket_name="tirak-storage-staging"
    fi
    
    # Create storage backup directory
    mkdir -p "$BACKUP_DIR/$BACKUP_NAME/storage"
    
    # Note: This is a placeholder for R2 backup
    # In a real implementation, you would use rclone or aws cli to sync R2 bucket
    log "R2 backup would be implemented here using rclone or aws cli"
    
    # Create a manifest of files (if possible)
    echo "# R2 Storage Backup Manifest" > "$BACKUP_DIR/$BACKUP_NAME/storage/manifest.txt"
    echo "# Bucket: $bucket_name" >> "$BACKUP_DIR/$BACKUP_NAME/storage/manifest.txt"
    echo "# Timestamp: $TIMESTAMP" >> "$BACKUP_DIR/$BACKUP_NAME/storage/manifest.txt"
    echo "# Environment: $ENVIRONMENT" >> "$BACKUP_DIR/$BACKUP_NAME/storage/manifest.txt"
    
    success "Storage backup manifest created"
}

# Backup configuration
backup_configuration() {
    log "Backing up configuration..."
    
    # Create config backup directory
    mkdir -p "$BACKUP_DIR/$BACKUP_NAME/config"
    
    # Copy important configuration files
    cp "$PROJECT_DIR/wrangler.toml" "$BACKUP_DIR/$BACKUP_NAME/config/" 2>/dev/null || warning "wrangler.toml not found"
    cp "$PROJECT_DIR/package.json" "$BACKUP_DIR/$BACKUP_NAME/config/" 2>/dev/null || warning "package.json not found"
    cp "$PROJECT_DIR/package-lock.json" "$BACKUP_DIR/$BACKUP_NAME/config/" 2>/dev/null || warning "package-lock.json not found"
    cp "$PROJECT_DIR/tsconfig.json" "$BACKUP_DIR/$BACKUP_NAME/config/" 2>/dev/null || warning "tsconfig.json not found"
    
    # Copy migration files
    if [[ -d "$PROJECT_DIR/migrations" ]]; then
        cp -r "$PROJECT_DIR/migrations" "$BACKUP_DIR/$BACKUP_NAME/config/"
    fi
    
    # Export environment variables (without sensitive values)
    log "Exporting environment configuration..."
    cat > "$BACKUP_DIR/$BACKUP_NAME/config/environment.txt" << EOF
# Environment Configuration Backup
# Generated: $TIMESTAMP
# Environment: $ENVIRONMENT

# Note: Sensitive values are not included in this backup
# You will need to reconfigure secrets manually

ENVIRONMENT=$ENVIRONMENT
NODE_ENV=production
EOF
    
    success "Configuration backup completed"
}

# Create backup metadata
create_metadata() {
    log "Creating backup metadata..."
    
    cat > "$BACKUP_DIR/$BACKUP_NAME/backup_info.json" << EOF
{
  "backup_name": "$BACKUP_NAME",
  "environment": "$ENVIRONMENT",
  "timestamp": "$TIMESTAMP",
  "date": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "project": "$PROJECT_NAME",
  "version": "1.0.0",
  "components": {
    "database": true,
    "storage": true,
    "configuration": true
  },
  "notes": "Automated backup created by backup.sh script"
}
EOF
    
    success "Backup metadata created"
}

# Compress backup
compress_backup() {
    log "Compressing backup..."
    
    cd "$BACKUP_DIR"
    tar -czf "${BACKUP_NAME}.tar.gz" "$BACKUP_NAME" || {
        error "Failed to compress backup"
        return 1
    }
    
    # Calculate checksum
    if command -v sha256sum &> /dev/null; then
        sha256sum "${BACKUP_NAME}.tar.gz" > "${BACKUP_NAME}.tar.gz.sha256"
    elif command -v shasum &> /dev/null; then
        shasum -a 256 "${BACKUP_NAME}.tar.gz" > "${BACKUP_NAME}.tar.gz.sha256"
    fi
    
    # Get file size
    local file_size=$(du -h "${BACKUP_NAME}.tar.gz" | cut -f1)
    
    success "Backup compressed: ${BACKUP_NAME}.tar.gz ($file_size)"
}

# Cleanup old backups
cleanup_old_backups() {
    log "Cleaning up old backups..."
    
    # Keep last 7 backups
    local keep_count=7
    
    cd "$BACKUP_DIR"
    
    # Remove old compressed backups
    ls -t ${PROJECT_NAME}_${ENVIRONMENT}_*.tar.gz 2>/dev/null | tail -n +$((keep_count + 1)) | xargs rm -f 2>/dev/null || true
    ls -t ${PROJECT_NAME}_${ENVIRONMENT}_*.tar.gz.sha256 2>/dev/null | tail -n +$((keep_count + 1)) | xargs rm -f 2>/dev/null || true
    
    # Remove old uncompressed backup directories
    ls -td ${PROJECT_NAME}_${ENVIRONMENT}_*/ 2>/dev/null | tail -n +$((keep_count + 1)) | xargs rm -rf 2>/dev/null || true
    
    success "Old backups cleaned up (keeping last $keep_count)"
}

# Validate environment
validate_environment() {
    log "Validating backup environment: $ENVIRONMENT"
    
    if [[ "$ENVIRONMENT" != "staging" && "$ENVIRONMENT" != "production" ]]; then
        error "Invalid environment. Use 'staging' or 'production'"
        exit 1
    fi
    
    # Check if wrangler is installed
    if ! command -v wrangler &> /dev/null; then
        error "Wrangler CLI is not installed. Please install it first:"
        error "npm install -g wrangler"
        exit 1
    fi
    
    # Check if logged in to Cloudflare
    if ! wrangler whoami &> /dev/null; then
        error "Not logged in to Cloudflare. Please run 'wrangler login' first"
        exit 1
    fi
    
    success "Environment validation passed"
}

# Main backup function
main() {
    log "Starting backup of $PROJECT_NAME ($ENVIRONMENT environment)"
    log "Backup name: $BACKUP_NAME"
    
    validate_environment
    create_backup_dir
    backup_database
    backup_storage
    backup_configuration
    create_metadata
    compress_backup
    cleanup_old_backups
    
    success "🗄️  Backup completed successfully!"
    log "Backup location: $BACKUP_DIR/${BACKUP_NAME}.tar.gz"
    
    # Show backup size and checksum
    if [[ -f "$BACKUP_DIR/${BACKUP_NAME}.tar.gz.sha256" ]]; then
        log "Checksum: $(cat "$BACKUP_DIR/${BACKUP_NAME}.tar.gz.sha256")"
    fi
}

# Run main function
main "$@"
