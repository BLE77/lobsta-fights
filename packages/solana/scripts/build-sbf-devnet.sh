#!/usr/bin/env bash
set -euo pipefail

# Build all on-chain programs into target/deploy using a toolchain version
# that supports edition2024-compatible dependencies.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

TOOLS_VERSION="v1.53"

echo "Building ichor-token..."
cargo-build-sbf \
  --manifest-path programs/ichor-token/Cargo.toml \
  --tools-version "$TOOLS_VERSION" \
  --sbf-out-dir target/deploy

echo "Building rumble-engine..."
cargo-build-sbf \
  --manifest-path programs/rumble-engine/Cargo.toml \
  --tools-version "$TOOLS_VERSION" \
  --sbf-out-dir target/deploy

echo "Building fighter-registry..."
cargo-build-sbf \
  --manifest-path programs/fighter-registry/Cargo.toml \
  --tools-version "$TOOLS_VERSION" \
  --sbf-out-dir target/deploy

echo "Build complete. Artifacts in packages/solana/target/deploy."
