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

# 2.1 示例里的固定 BOOTSTRAP_TOKEN 必须换掉，否则等于公开了注册令牌
if grep -q '^BOOTSTRAP_TOKEN=secret_admin_bootstrap_token_123' .env; then
    NEW_TOKEN=$(openssl rand -hex 16 2>/dev/null || tr -dc 'a-zA-Z0-9' < /dev/urandom | head -c 24 || true)
    if [ -n "${NEW_TOKEN}" ]; then
        sed -i "s/^BOOTSTRAP_TOKEN=.*/BOOTSTRAP_TOKEN=${NEW_TOKEN}/" .env
        # 仓库是公开的，CI 日志会公开展示：这里只提示位置，绝不打印令牌本身
        log_warn "已生成随机 BOOTSTRAP_TOKEN，值保存在 .env（注册时填到“邀请码”栏）。"
    fi
fi

# 2.2 读取端口与 TLS 开关（缺省值需与 docker-compose.yml 保持一致）
env_value() {
    local key="$1"
    local fallback="$2"
    local raw
    raw=$(grep -E "^${key}=" .env 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d '\r' || true)
    if [ -z "${raw}" ]; then
        echo "${fallback}"
    else
        echo "${raw}"
    fi
}

SERVER_PORT="$(env_value SERVER_PORT 8085)"
ENABLE_TLS="$(env_value ENABLE_TLS false)"
DOMAIN_VALUE="$(env_value DOMAIN sync.example.com)"

PROFILE_ARGS=""
if [ "${ENABLE_TLS}" = "true" ]; then
    PROFILE_ARGS="--profile tls"
    if [ "${DOMAIN_VALUE}" = "sync.example.com" ]; then
        log_warn "ENABLE_TLS=true 但 DOMAIN 仍是示例值，Caddy 申请证书会失败；请改成你自己的域名。"
    fi
else
    # 未启用 TLS 时清掉可能残留的 caddy 容器，释放 80/443
    if ${COMPOSE_CMD} ps -a --format '{{.Name}}' 2>/dev/null | grep -q 'caddy'; then
        log_info "TLS 反代未启用：清理残留 caddy 容器（释放 80/443）..."
        ${COMPOSE_CMD} --profile tls rm -sf caddy >/dev/null 2>&1 || true
    fi
fi
log_info "API 暴露端口: ${SERVER_PORT}  |  TLS 反代: ${ENABLE_TLS}"

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

# 4.1 端口占用自愈
#     最常见的失败场景：上一次部署的 openshell-server 还在跑，端口被它自己占着，
#     旧脚本直接报错退出 —— 结果就是「服务一直停在老版本，永远升不上去」。
#     这里先把占用者区分为「自己的容器」和「别人的服务」：
#       * 自己的容器 → 停掉释放端口，随后 up -d 会用新镜像重建（命名卷不变，数据保留）
#       * 别人的服务 → 拒绝动手，打印出来让人工处理
port_busy() {
    command -v ss >/dev/null 2>&1 || return 1
    ss -lntH 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${SERVER_PORT}\$"
}

# 只认带 compose 标签的自家容器，避免误杀同端口上别人的服务
our_containers_on_port() {
    docker ps -q \
        --filter "publish=${SERVER_PORT}" \
        --filter "label=com.docker.compose.service=openshell-server" 2>/dev/null || true
}

if port_busy; then
    HOLDER_IDS="$(our_containers_on_port)"
    if [ -n "${HOLDER_IDS}" ]; then
        log_warn "端口 ${SERVER_PORT} 被上一次部署的 openshell-server 占用，先停止旧容器再拉起新版本："
        docker ps --filter "publish=${SERVER_PORT}" --format '    - {{.Names}} ({{.Image}})' || true
        # shellcheck disable=SC2086
        docker rm -sf ${HOLDER_IDS} >/dev/null 2>&1 || true
        for _ in 1 2 3 4 5; do
            port_busy || break
            sleep 1
        done
    fi
fi

# 换过 compose 项目名时 --remove-orphans 管不到旧容器，这里按 compose 标签兜底清理
STALE_IDS="$(docker ps -aq --filter "label=com.docker.compose.service=openshell-server" 2>/dev/null || true)"
if [ -n "${STALE_IDS}" ]; then
    log_info "清理残留的 openshell-server 容器（数据在命名卷中，不受影响）..."
    # shellcheck disable=SC2086
    docker rm -sf ${STALE_IDS} >/dev/null 2>&1 || true
fi

if port_busy; then
    log_error "端口 ${SERVER_PORT} 被非 OpenShell 进程占用，需人工处理（或改 .env 的 SERVER_PORT，如 8086）。"
    ss -lntp 2>/dev/null | grep -E "[:.]${SERVER_PORT}\s" || true
    docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}' | head -20 || true
    exit 1
fi

# 5. Launch containers
log_info "Starting containers..."
${COMPOSE_CMD} ${PROFILE_ARGS} up -d --remove-orphans

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

# 7.1 从宿主机侧再验一次对外端口（客户端实际访问的路径）
EXTERNAL_URL=""
if [ "${ENABLE_TLS}" = "true" ]; then
    EXTERNAL_URL="https://${DOMAIN_VALUE}"
else
    EXTERNAL_URL="http://<你的域名>"
fi

if command -v curl >/dev/null 2>&1; then
    HEALTH_OUT=$(curl -fsS --max-time 5 "http://127.0.0.1:${SERVER_PORT}/healthz" 2>/dev/null || true)
    if echo "${HEALTH_OUT}" | grep -q '"status"'; then
        log_success "对外端口 ${SERVER_PORT} 健康检查通过：${HEALTH_OUT}"
    else
        log_warn "对外端口 ${SERVER_PORT} 暂未响应，请检查防火墙 / 安全组是否放行该端口。"
    fi
fi

# 8. Print deployment status
log_success "=========================================================="
log_success " OpenShell container deployment completed successfully! "
log_success "=========================================================="
${COMPOSE_CMD} ${PROFILE_ARGS} ps

echo ""
if [ "${ENABLE_TLS}" = "true" ]; then
    log_success "客户端服务端地址填写：https://${DOMAIN_VALUE}"
else
    log_success "客户端服务端地址填写：http://<你的域名>:${SERVER_PORT}"
    log_info "（也可用公网 IP：http://<公网IP>:${SERVER_PORT}；请确保防火墙/安全组放行 ${SERVER_PORT}）"
    log_warn "8085 为明文 HTTP：业务数据仍是 E2EE 密文，但登录令牌会明文传输；有 80/443 时可改用 ENABLE_TLS=true。"
fi
if [ -f .env ] && [ "$(grep -c '^BOOTSTRAP_TOKEN=.\+' .env 2>/dev/null || true)" -gt 0 ]; then
    log_info "首次注册所需的 BOOTSTRAP_TOKEN 在 .env 中查看：grep BOOTSTRAP_TOKEN .env"
fi
