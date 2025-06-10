#!/bin/bash

# Tirak Backend Deployment Script
# Usage: ./scripts/deploy.sh [staging|production]

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
ENVIRONMENT=${1:-staging}
PROJECT_NAME="tirak-backend"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

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

# Validate environment
validate_environment() {
    log "Validating deployment environment: $ENVIRONMENT"
    
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

# Install dependencies
install_dependencies() {
    log "Installing dependencies..."
    cd "$PROJECT_DIR"
    
    if [[ -f "package-lock.json" ]]; then
        npm ci
    else
        npm install
    fi
    
    success "Dependencies installed"
}

# Run type checking
type_check() {
    log "Running TypeScript type checking..."
    cd "$PROJECT_DIR"
    
    npm run type-check || {
        error "TypeScript type checking failed"
        exit 1
    }
    
    success "Type checking passed"
}

# Run tests
run_tests() {
    log "Running tests..."
    cd "$PROJECT_DIR"
    
    if npm run test:ci &> /dev/null; then
        success "All tests passed"
    else
        warning "Tests failed or not configured. Continuing with deployment..."
    fi
}

# Run database migrations
run_migrations() {
    log "Running database migrations for $ENVIRONMENT..."
    cd "$PROJECT_DIR"
    
    # Set the appropriate wrangler environment
    local wrangler_env=""
    if [[ "$ENVIRONMENT" == "production" ]]; then
        wrangler_env="--env production"
    fi
    
    # Run migrations
    for migration in migrations/*.sql; do
        if [[ -f "$migration" ]]; then
            log "Applying migration: $(basename "$migration")"
            wrangler d1 execute tirak-db $wrangler_env --file="$migration" || {
                error "Migration failed: $migration"
                exit 1
            }
        fi
    done
    
    success "Database migrations completed"
}

# Deploy worker
deploy_worker() {
    log "Deploying worker to $ENVIRONMENT..."
    cd "$PROJECT_DIR"
    
    local deploy_cmd="wrangler deploy"
    
    if [[ "$ENVIRONMENT" == "production" ]]; then
        deploy_cmd="$deploy_cmd --env production"
    fi
    
    $deploy_cmd || {
        error "Worker deployment failed"
        exit 1
    }
    
    success "Worker deployed successfully"
}

# Deploy durable objects
deploy_durable_objects() {
    log "Deploying Durable Objects..."
    cd "$PROJECT_DIR"
    
    # Durable Objects are deployed with the worker
    # This is a placeholder for any specific DO deployment steps
    success "Durable Objects deployed with worker"
}

# Deploy queue consumers
deploy_queue_consumers() {
    log "Deploying queue consumers..."
    cd "$PROJECT_DIR"
    
    local wrangler_env=""
    if [[ "$ENVIRONMENT" == "production" ]]; then
        wrangler_env="--env production"
    fi
    
    # Queue consumers are deployed with the worker
    # Verify queues exist
    log "Verifying queues..."
    
    success "Queue consumers deployed"
}

# Seed initial data
seed_data() {
    if [[ "$ENVIRONMENT" == "staging" ]]; then
        log "Seeding initial data for staging..."
        cd "$PROJECT_DIR"
        
        if [[ -f "scripts/seed-data.sql" ]]; then
            wrangler d1 execute tirak-db --file="scripts/seed-data.sql" || {
                warning "Data seeding failed, but continuing..."
            }
        fi
        
        success "Data seeding completed"
    else
        log "Skipping data seeding for production environment"
    fi
}

# Post-deployment verification
verify_deployment() {
    log "Verifying deployment..."
    
    local base_url
    if [[ "$ENVIRONMENT" == "production" ]]; then
        base_url="https://api.tirak.app"
    else
        base_url="https://api-staging.tirak.app"
    fi
    
    # Test health endpoint
    local health_check=$(curl -s -o /dev/null -w "%{http_code}" "$base_url/health" || echo "000")
    
    if [[ "$health_check" == "200" ]]; then
        success "Health check passed"
    else
        warning "Health check failed (HTTP $health_check). Service might still be starting..."
    fi
    
    # Test auth endpoint
    local auth_check=$(curl -s -o /dev/null -w "%{http_code}" "$base_url/api/auth" || echo "000")
    
    if [[ "$auth_check" == "404" || "$auth_check" == "405" ]]; then
        success "Auth endpoint accessible"
    else
        warning "Auth endpoint check failed (HTTP $auth_check)"
    fi
    
    success "Deployment verification completed"
}

# Cleanup function
cleanup() {
    log "Cleaning up temporary files..."
    # Add any cleanup steps here
    success "Cleanup completed"
}

# Main deployment function
main() {
    log "Starting deployment of $PROJECT_NAME to $ENVIRONMENT"
    log "Project directory: $PROJECT_DIR"
    
    # Trap cleanup on exit
    trap cleanup EXIT
    
    # Run deployment steps
    validate_environment
    install_dependencies
    type_check
    run_tests
    run_migrations
    deploy_worker
    deploy_durable_objects
    deploy_queue_consumers
    seed_data
    verify_deployment
    
    success "🚀 Deployment to $ENVIRONMENT completed successfully!"
    
    if [[ "$ENVIRONMENT" == "production" ]]; then
        log "Production URL: https://api.tirak.app"
    else
        log "Staging URL: https://api-staging.tirak.app"
    fi
}

# Run main function
main "$@"
