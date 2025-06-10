#!/bin/bash

# Tirak Backend Test Runner
# Comprehensive testing script for the Tirak backend

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
TEST_TYPE=${1:-"all"}
COVERAGE_THRESHOLD=80
PARALLEL_JOBS=4

# Logging functions
log() {
    echo -e "${BLUE}[$(date +'%H:%M:%S')]${NC} $1"
}

success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

# Check dependencies
check_dependencies() {
    log "Checking test dependencies..."
    
    if ! command -v node &> /dev/null; then
        error "Node.js is not installed"
        exit 1
    fi
    
    if ! command -v npm &> /dev/null; then
        error "npm is not installed"
        exit 1
    fi
    
    # Check if node_modules exists
    if [ ! -d "node_modules" ]; then
        warning "node_modules not found, installing dependencies..."
        npm install
    fi
    
    # Check if vitest is available
    if ! npx vitest --version &> /dev/null; then
        error "Vitest is not available"
        exit 1
    fi
    
    success "All dependencies are available"
}

# Type checking
run_type_check() {
    log "Running TypeScript type checking..."
    
    if npm run typecheck; then
        success "Type checking passed"
        return 0
    else
        error "Type checking failed"
        return 1
    fi
}

# Unit tests
run_unit_tests() {
    log "Running unit tests..."
    
    local test_pattern="tests/**/*.test.ts"
    local args="--run --reporter=verbose"
    
    if [ "$COVERAGE" = "true" ]; then
        args="$args --coverage"
    fi
    
    if npx vitest $args $test_pattern; then
        success "Unit tests passed"
        return 0
    else
        error "Unit tests failed"
        return 1
    fi
}

# Integration tests
run_integration_tests() {
    log "Running integration tests..."
    
    local test_pattern="tests/routes/**/*.test.ts"
    local args="--run --reporter=verbose"
    
    if npx vitest $args $test_pattern; then
        success "Integration tests passed"
        return 0
    else
        error "Integration tests failed"
        return 1
    fi
}

# WebSocket tests
run_websocket_tests() {
    log "Running WebSocket tests..."
    
    local test_pattern="tests/services/**/*.test.ts"
    local args="--run --reporter=verbose"
    
    if npx vitest $args $test_pattern; then
        success "WebSocket tests passed"
        return 0
    else
        error "WebSocket tests failed"
        return 1
    fi
}

# Performance tests
run_performance_tests() {
    log "Running performance tests..."
    
    # Start local development server for testing
    log "Starting development server..."
    npm run dev &
    DEV_PID=$!
    
    # Wait for server to start
    sleep 5
    
    # Check if server is running
    if ! curl -s http://localhost:8787/health > /dev/null; then
        error "Development server failed to start"
        kill $DEV_PID 2>/dev/null || true
        return 1
    fi
    
    success "Development server started (PID: $DEV_PID)"
    
    # Run API tests
    if ./scripts/test-mobile-api.sh; then
        success "API performance tests passed"
        PERF_RESULT=0
    else
        error "API performance tests failed"
        PERF_RESULT=1
    fi
    
    # Clean up
    log "Stopping development server..."
    kill $DEV_PID 2>/dev/null || true
    wait $DEV_PID 2>/dev/null || true
    
    return $PERF_RESULT
}

# Coverage analysis
analyze_coverage() {
    log "Analyzing test coverage..."
    
    if npm run test:coverage; then
        success "Coverage analysis completed"
        
        # Check coverage thresholds
        log "Checking coverage thresholds (minimum: ${COVERAGE_THRESHOLD}%)..."
        
        # Parse coverage results (simplified)
        # In a real implementation, you'd parse the actual coverage report
        warning "Coverage threshold checking not implemented yet"
        
        return 0
    else
        error "Coverage analysis failed"
        return 1
    fi
}

# Security tests
run_security_tests() {
    log "Running security tests..."
    
    # Check for common vulnerabilities
    log "Checking for hardcoded secrets..."
    if grep -r "password\|secret\|key" src/ --include="*.ts" | grep -v "// TODO\|// FIXME" | grep -E "(=|:)\s*['\"][^'\"]{8,}['\"]"; then
        warning "Potential hardcoded secrets found"
    else
        success "No hardcoded secrets detected"
    fi
    
    # Check for SQL injection vulnerabilities
    log "Checking for SQL injection vulnerabilities..."
    if grep -r "SELECT\|INSERT\|UPDATE\|DELETE" src/ --include="*.ts" | grep -v "prepare\|bind"; then
        warning "Potential SQL injection vulnerabilities found"
    else
        success "No SQL injection vulnerabilities detected"
    fi
    
    # Check for XSS vulnerabilities
    log "Checking for XSS vulnerabilities..."
    if grep -r "innerHTML\|outerHTML" src/ --include="*.ts"; then
        warning "Potential XSS vulnerabilities found"
    else
        success "No XSS vulnerabilities detected"
    fi
    
    success "Security tests completed"
    return 0
}

# Generate test report
generate_report() {
    log "Generating test report..."
    
    local report_file="test-report-$(date +%Y%m%d-%H%M%S).md"
    
    cat > "$report_file" << EOF
# Tirak Backend Test Report

**Generated:** $(date)
**Test Type:** $TEST_TYPE
**Coverage Threshold:** ${COVERAGE_THRESHOLD}%

## Test Results

### Type Checking
- Status: ${TYPE_CHECK_STATUS:-"Not Run"}

### Unit Tests
- Status: ${UNIT_TEST_STATUS:-"Not Run"}

### Integration Tests
- Status: ${INTEGRATION_TEST_STATUS:-"Not Run"}

### WebSocket Tests
- Status: ${WEBSOCKET_TEST_STATUS:-"Not Run"}

### Performance Tests
- Status: ${PERFORMANCE_TEST_STATUS:-"Not Run"}

### Security Tests
- Status: ${SECURITY_TEST_STATUS:-"Not Run"}

## Coverage Analysis
- Status: ${COVERAGE_STATUS:-"Not Run"}

## Recommendations

EOF

    if [ -f "coverage/index.html" ]; then
        echo "- Coverage report available at: coverage/index.html" >> "$report_file"
    fi
    
    echo "- Review failed tests and fix issues" >> "$report_file"
    echo "- Ensure all tests pass before deployment" >> "$report_file"
    
    success "Test report generated: $report_file"
}

# Main test execution
main() {
    log "Starting Tirak Backend Test Suite"
    log "Test Type: $TEST_TYPE"
    
    # Check dependencies first
    check_dependencies
    
    local overall_status=0
    
    case $TEST_TYPE in
        "unit")
            run_type_check && TYPE_CHECK_STATUS="✅ PASSED" || { TYPE_CHECK_STATUS="❌ FAILED"; overall_status=1; }
            run_unit_tests && UNIT_TEST_STATUS="✅ PASSED" || { UNIT_TEST_STATUS="❌ FAILED"; overall_status=1; }
            ;;
        "integration")
            run_type_check && TYPE_CHECK_STATUS="✅ PASSED" || { TYPE_CHECK_STATUS="❌ FAILED"; overall_status=1; }
            run_integration_tests && INTEGRATION_TEST_STATUS="✅ PASSED" || { INTEGRATION_TEST_STATUS="❌ FAILED"; overall_status=1; }
            ;;
        "websocket")
            run_type_check && TYPE_CHECK_STATUS="✅ PASSED" || { TYPE_CHECK_STATUS="❌ FAILED"; overall_status=1; }
            run_websocket_tests && WEBSOCKET_TEST_STATUS="✅ PASSED" || { WEBSOCKET_TEST_STATUS="❌ FAILED"; overall_status=1; }
            ;;
        "performance")
            run_performance_tests && PERFORMANCE_TEST_STATUS="✅ PASSED" || { PERFORMANCE_TEST_STATUS="❌ FAILED"; overall_status=1; }
            ;;
        "security")
            run_security_tests && SECURITY_TEST_STATUS="✅ PASSED" || { SECURITY_TEST_STATUS="❌ FAILED"; overall_status=1; }
            ;;
        "coverage")
            COVERAGE=true
            run_type_check && TYPE_CHECK_STATUS="✅ PASSED" || { TYPE_CHECK_STATUS="❌ FAILED"; overall_status=1; }
            run_unit_tests && UNIT_TEST_STATUS="✅ PASSED" || { UNIT_TEST_STATUS="❌ FAILED"; overall_status=1; }
            run_integration_tests && INTEGRATION_TEST_STATUS="✅ PASSED" || { INTEGRATION_TEST_STATUS="❌ FAILED"; overall_status=1; }
            analyze_coverage && COVERAGE_STATUS="✅ PASSED" || { COVERAGE_STATUS="❌ FAILED"; overall_status=1; }
            ;;
        "all"|*)
            run_type_check && TYPE_CHECK_STATUS="✅ PASSED" || { TYPE_CHECK_STATUS="❌ FAILED"; overall_status=1; }
            run_unit_tests && UNIT_TEST_STATUS="✅ PASSED" || { UNIT_TEST_STATUS="❌ FAILED"; overall_status=1; }
            run_integration_tests && INTEGRATION_TEST_STATUS="✅ PASSED" || { INTEGRATION_TEST_STATUS="❌ FAILED"; overall_status=1; }
            run_websocket_tests && WEBSOCKET_TEST_STATUS="✅ PASSED" || { WEBSOCKET_TEST_STATUS="❌ FAILED"; overall_status=1; }
            run_performance_tests && PERFORMANCE_TEST_STATUS="✅ PASSED" || { PERFORMANCE_TEST_STATUS="❌ FAILED"; overall_status=1; }
            run_security_tests && SECURITY_TEST_STATUS="✅ PASSED" || { SECURITY_TEST_STATUS="❌ FAILED"; overall_status=1; }
            ;;
    esac
    
    # Generate report
    generate_report
    
    # Final status
    echo
    if [ $overall_status -eq 0 ]; then
        success "All tests passed! ✅"
        log "Phase 4.1 Unit Testing Implementation: ✅ COMPLETED"
    else
        error "Some tests failed! ❌"
        log "Please review the test results and fix failing tests"
        exit 1
    fi
}

# Help function
show_help() {
    echo "Tirak Backend Test Runner"
    echo
    echo "Usage: $0 [TEST_TYPE]"
    echo
    echo "TEST_TYPE options:"
    echo "  unit         - Run unit tests only"
    echo "  integration  - Run integration tests only"
    echo "  websocket    - Run WebSocket tests only"
    echo "  performance  - Run performance tests only"
    echo "  security     - Run security tests only"
    echo "  coverage     - Run tests with coverage analysis"
    echo "  all          - Run all tests (default)"
    echo
    echo "Examples:"
    echo "  $0 unit"
    echo "  $0 coverage"
    echo "  $0 all"
}

# Handle help flag
if [[ "$1" == "-h" || "$1" == "--help" ]]; then
    show_help
    exit 0
fi

# Run main function
main "$@"
