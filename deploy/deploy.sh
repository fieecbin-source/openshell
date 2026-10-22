#!/usr/bin/env bash
# ==============================================================================
# OpenShell Production Deployment & Healthcheck Script
# ==============================================================================
# Usage:
#   ./deploy.sh
# ==============================================================================

set -euo pipefail

# Text formatting
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Resolve script directory (deploy/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${SCRIPT_DIR}"

log_info "Starting OpenShell deployment in ${SCRIPT_DIR}..."

# 1. Check Docker & Docker Compose
if ! command -v docker &> /dev/null; then
    log_error "Docker is not installed or not in PATH."
    exit 1
fi

COMPOSE_CMD=""
if docker compose version &> /dev/null; then
    COMPOSE_CMD="docker compose"
elif command -v docker-compose &> /dev/null; then
    COMPOSE_CMD="docker-compose"
else
    log_error "Neither 'docker compose' nor 'docker-compose' was found."
    exit 1
fi
log_info "Using compose command: ${COMPOSE_CMD}"

# 2. Check / Initialize .env file
if [ ! -f .env ]; then
    if [ -f .env.example ]; then
        log_warn ".env not found. Creating default .env from .env.example..."
        cp .env.example .env
        # Generate secure random secret for JWT
        RANDOM_SECRET=$(openssl rand -hex 32 2>/dev/null || tr -dc 'a-zA-Z0-9' < /dev/urandom | head -c 64 || true)
        if [ -n "${RANDOM_SECRET}" ]; then
            sed -i "s/generate_a_long_random_secret_with_at_least_32_characters_here/${RANDOM_SECRET}/g" .env
        fi
        log_warn "Generated new JWT_SECRET in .env. Please update DOMAIN if using public domain."
    else
        log_error "No .env or .env.example found in ${SCRIPT_DIR}."
        exit 1
    fi
fi

# 3. Hot Backup SQLite Database if service is currently running
BACKUP_DIR="${SCRIPT_DIR}/backups"
mkdir -p "${BACKUP_DIR}"

if ${COMPOSE_CMD} ps --status running | grep -q "openshell-server"; then
    TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
    log_info "Active openshell-server detected. Creating database snapshot to ${BACKUP_DIR}/backup_${TIMESTAMP}.db..."
    
    # Use sqlite3 in container if available, or direct volume copy fallback
    if ${COMPOSE_CMD} exec -T openshell-server sqlite3 /data/openshell-server.db ".backup '/data/backup_temp.db'" 2>/dev/null; then
        ${COMPOSE_CMD} cp openshell-server:/data/backup_temp.db "${BACKUP_DIR}/backup_${TIMESTAMP}.db" 2>/dev/null || true
        ${COMPOSE_CMD} exec -T openshell-server rm -f /data/backup_temp.db 2>/dev/null || true
        log_success "Database snapshot saved: ${BACKUP_DIR}/backup_${TIMESTAMP}.db"
    else
        log_info "Hot backup skipped or non-SQLite mode."
    fi

    # Retain only last 7 backups to prevent disk bloat
    ls -tp "${BACKUP_DIR}"/backup_*.db 2>/dev/null | grep -v '/$' | tail -n +8 | xargs -I {} rm -- {} 2>/dev/null || true
fi

# 4. Pull external images & build application container
log_info "Pulling external base images..."
${COMPOSE_CMD} pull caddy || true

log_info "Building openshell-server image..."
${COMPOSE_CMD} build --pull openshell-server

# 5. Launch containers
log_info "Starting containers..."
${COMPOSE_CMD} up -d --remove-orphans

# 6. Automated Health & Readiness Check
log_info "Waiting for openshell-server to become ready..."
MAX_ATTEMPTS=20
DELAY=2
READY=false

for i in $(seq 1 ${MAX_ATTEMPTS}); do
    # Probe internal container endpoint directly using wget
    STATUS_OUT=$(${COMPOSE_CMD} exec -T openshell-server wget -qO- http://127.0.0.1:8080/readyz 2>/dev/null || true)
    
    if echo "${STATUS_OUT}" | grep -q '"status":"ready"'; then
        READY=true
        log_success "Readiness check passed on attempt ${i}!"
        break
    fi

    echo -n "."
    sleep ${DELAY}
done
echo ""

if [ "${READY}" != "true" ]; then
    log_error "Deployment verification failed: openshell-server did not report ready within $((MAX_ATTEMPTS * DELAY))s."
    log_info "Recent container logs:"
    ${COMPOSE_CMD} logs --tail=100 openshell-server
    exit 1
fi

# 7. Clean up dangling images to keep VPS storage lean
log_info "Cleaning up unused container images..."
docker image prune -f || true

# 8. Print deployment status
log_success "=========================================================="
log_success " OpenShell container deployment completed successfully! "
log_success "=========================================================="
${COMPOSE_CMD} ps
