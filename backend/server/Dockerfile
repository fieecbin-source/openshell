# ===================================================
# OpenShell Server Multi-stage Production Dockerfile
# ===================================================

# Stage 1: Build binary
FROM rust:1.80-alpine AS builder

RUN apk add --no-cache musl-dev perl make pkgconfig openssl-dev

WORKDIR /app

# Copy root workspace manifests
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY backend/crates ./backend/crates
COPY backend/server ./backend/server
COPY backend/desktop ./backend/desktop

# Build server in release mode
RUN cargo build --release -p openshell-server

# Stage 2: Minimal runtime image
FROM alpine:3.20

RUN apk add --no-cache ca-certificates tzdata sqlite-libs libgcc

WORKDIR /app

# Create non-root user
RUN addgroup -S openshell && adduser -S openshell -G openshell

# Copy compiled binary from builder
COPY --from=builder /app/target/release/openshell-server /usr/local/bin/openshell-server

# Create data directories
RUN mkdir -p /data /data/artifacts && chown -R openshell:openshell /app /data

USER openshell

ENV HOST=0.0.0.0
ENV PORT=8080
ENV DATABASE_URL=/data/openshell-server.db
ENV ARTIFACTS_DIR=/data/artifacts
ENV RUST_LOG=openshell_server=info,tower_http=info

EXPOSE 8080

VOLUME ["/data"]

ENTRYPOINT ["/usr/local/bin/openshell-server"]
