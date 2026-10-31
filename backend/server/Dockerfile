# ===================================================
# OpenShell Server Multi-stage Production Dockerfile
# ===================================================

# Stage 1: Build binary
FROM rust:alpine3.23 AS builder

RUN apk add --no-cache musl-dev perl make pkgconfig openssl-dev

WORKDIR /app

# Copy root workspace manifests
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY backend/crates ./backend/crates
COPY backend/server ./backend/server
COPY backend/desktop ./backend/desktop
COPY backend/xtask ./backend/xtask

# Build server in release mode
RUN cargo build --release --locked -p openshell-server

# Stage 2: Minimal runtime image
FROM alpine:3.23

RUN apk add --no-cache ca-certificates tzdata libgcc

ARG APP_VERSION=development
ARG VCS_REF=unknown
LABEL org.opencontainers.image.title="OpenShell Server" \
      org.opencontainers.image.description="Self-hosted OpenShell sync server" \
      org.opencontainers.image.source="https://github.com/fieecbin-source/openshell" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version=$APP_VERSION \
      org.opencontainers.image.revision=$VCS_REF

WORKDIR /app

# Create non-root user
RUN addgroup -S openshell && adduser -S openshell -G openshell

# Copy compiled binary from builder
COPY --from=builder /app/target/release/openshell-server /usr/local/bin/openshell-server
COPY --chmod=0755 deploy/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY LICENSE /usr/share/licenses/openshell/LICENSE

# Create data directories
RUN mkdir -p /data /data/artifacts && chown -R openshell:openshell /app /data

USER openshell

ENV HOST=0.0.0.0
ENV PORT=8080
ENV DATABASE_URL=/data/openshell-server.db
ENV DATA_DIR=/data
ENV ARTIFACTS_DIR=/data/artifacts
ENV RUST_LOG=openshell_server=info,tower_http=info

EXPOSE 8080

VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/readyz || exit 1

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
