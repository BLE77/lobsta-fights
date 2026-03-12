#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

TOOLS_VERSION="${SBF_TOOLS_VERSION:-v1.53}"

fail() {
  echo "Mainnet rumble-engine build blocked: $1" >&2
  exit 1
}

echo "Running mainnet program-id guard..."
cargo test \
  --manifest-path programs/rumble-engine/Cargo.toml \
  --features mainnet \
  mainnet_feature_selects_mainnet_program_id

echo "Building rumble-engine with mainnet feature..."
cargo-build-sbf \
  --manifest-path programs/rumble-engine/Cargo.toml \
  --features mainnet \
  --tools-version "$TOOLS_VERSION" \
  --sbf-out-dir target/deploy

[[ -f target/deploy/rumble_engine.so ]] || fail "missing target/deploy/rumble_engine.so after build"

echo "Mainnet rumble-engine build complete."
