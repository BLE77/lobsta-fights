#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PROGRAM_ID_MAINNET="${PROGRAM_ID_MAINNET:-2TvW4EfbmMe566ZQWZWd8kX34iFR2DM3oBUpjwpRJcqC}"
UPGRADE_AUTHORITY="${SOLANA_MAINNET_AUTHORITY:-$HOME/.config/solana/mainnet-admin.json}"
RPC_URL="${SOLANA_MAINNET_RPC_URL:-mainnet-beta}"
PROGRAM_SO="target/deploy/rumble_engine.so"

fail() {
  echo "Mainnet rumble-engine deploy blocked: $1" >&2
  exit 1
}

[[ -f "$UPGRADE_AUTHORITY" ]] || fail "missing upgrade authority keypair at $UPGRADE_AUTHORITY"

EXPECTED_AUTHORITY="$(solana address -k "$UPGRADE_AUTHORITY")"
ONCHAIN_AUTHORITY="$(
  solana program show "$PROGRAM_ID_MAINNET" --url "$RPC_URL" \
    | awk -F': ' '/Authority:/ {print $2; exit}'
)"

[[ -n "$ONCHAIN_AUTHORITY" ]] || fail "unable to read current on-chain authority for $PROGRAM_ID_MAINNET"
[[ "$EXPECTED_AUTHORITY" == "$ONCHAIN_AUTHORITY" ]] \
  || fail "upgrade authority mismatch (local=$EXPECTED_AUTHORITY, onchain=$ONCHAIN_AUTHORITY)"

"$ROOT_DIR/scripts/build-sbf-mainnet.sh"

echo "Deploying rumble-engine to mainnet program $PROGRAM_ID_MAINNET..."
solana program deploy "$PROGRAM_SO" \
  --program-id "$PROGRAM_ID_MAINNET" \
  --url "$RPC_URL" \
  --keypair "$UPGRADE_AUTHORITY" \
  --upgrade-authority "$UPGRADE_AUTHORITY"

echo "Mainnet rumble-engine deploy complete."
