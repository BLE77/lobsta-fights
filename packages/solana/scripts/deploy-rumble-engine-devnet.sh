#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

fail() {
  echo "Devnet rumble-engine deploy blocked: $1" >&2
  exit 1
}

require_instruction() {
  local instruction="$1"
  jq -e --arg instruction "$instruction" '
    .instructions // []
    | map(select(.name == $instruction))
    | length > 0
  ' target/idl/rumble_engine.json >/dev/null \
    || fail "local rumble_engine IDL is missing required combat instruction '${instruction}'"
}

echo "Building rumble-engine with combat feature for devnet..."
anchor build -p rumble-engine -- --features rumble-engine/combat

[[ -f target/idl/rumble_engine.json ]] || fail "missing target/idl/rumble_engine.json after build"

require_instruction "start_combat"
require_instruction "open_turn"
require_instruction "resolve_turn"
require_instruction "advance_turn"

echo "Combat instruction guard passed. Deploying rumble_engine to devnet..."
anchor deploy --program-name rumble_engine --provider.cluster devnet

echo "Devnet rumble_engine deploy complete."
