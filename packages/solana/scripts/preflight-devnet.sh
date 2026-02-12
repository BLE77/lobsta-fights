#!/usr/bin/env bash
set -euo pipefail

# Repeatable devnet preflight for production-like upgrades.
# Validates:
# 1) Program authorities and deploy slots
# 2) On-chain IDL availability + parity with local IDL
# 3) Wallet and cluster safety checks
# 4) Optional entropy-mode readiness checks

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SOLANA_DIR="$ROOT_DIR/packages/solana"
NEXTJS_IDL_DIR="$ROOT_DIR/packages/nextjs/lib/idl"
EXPECTED_DEPLOYER="${EXPECTED_DEPLOYER:-FXvriUM1dTwDeVXaWTSqGo14jPQk7363FQsQaUP1tvdE}"
MIN_SOL_BALANCE="${MIN_SOL_BALANCE:-8}"
REQUIRE_ENTROPY_CONFIG="${REQUIRE_ENTROPY_CONFIG:-false}"
ICHOR_PROGRAM_ID="8CHYSuh1Y3F83PyK95E3F1Uya6pgPk4m3vM3MF3mP5hg"

fail() {
  echo "Preflight failed: $1" >&2
  exit 1
}

PROGRAMS=(
  "ichor_token:${ICHOR_PROGRAM_ID}"
  "rumble_engine:2TvW4EfbmMe566ZQWZWd8kX34iFR2DM3oBUpjwpRJcqC"
  "fighter_registry:2hA6Jvj1yjP2Uj3qrJcsBeYA2R9xPM95mDKw1ncKVExa"
)

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

echo "== Cluster =="
rpc_url="$(solana config get | awk -F': ' '/RPC URL:/{print $2}')"
echo "RPC URL: ${rpc_url}"
[[ "${rpc_url}" == *"devnet"* ]] || fail "solana CLI RPC is not set to devnet"
echo

echo "== Wallet =="
wallet_address="$(solana address)"
wallet_balance="$(solana balance -u devnet | awk '{print $1}')"
echo "${wallet_address}"
echo "${wallet_balance} SOL"
[[ "${wallet_address}" == "${EXPECTED_DEPLOYER}" ]] || fail "wallet does not match EXPECTED_DEPLOYER (${EXPECTED_DEPLOYER})"
awk -v bal="${wallet_balance}" -v min="${MIN_SOL_BALANCE}" 'BEGIN { exit !(bal + 0 >= min + 0) }' \
  || fail "wallet balance ${wallet_balance} SOL is below MIN_SOL_BALANCE=${MIN_SOL_BALANCE}"
echo

echo "== Program state =="
for pair in "${PROGRAMS[@]}"; do
  name="${pair%%:*}"
  id="${pair##*:}"
  echo "--- ${name} (${id})"
  show_output="$(solana program show -u devnet "$id")"
  echo "${show_output}" | rg "Program Id:|Authority:|Last Deployed In Slot:|Data Length:"
  authority="$(echo "${show_output}" | awk -F': ' '/Authority:/{print $2}')"
  [[ "${authority}" == "${EXPECTED_DEPLOYER}" ]] \
    || fail "${name} authority ${authority} does not match EXPECTED_DEPLOYER ${EXPECTED_DEPLOYER}"
done
echo

echo "== On-chain IDL parity =="
for pair in "${PROGRAMS[@]}"; do
  name="${pair%%:*}"
  id="${pair##*:}"
  onchain="$tmpdir/${name}_onchain.json"
  local_sorted="$tmpdir/${name}_local_sorted.json"
  onchain_sorted="$tmpdir/${name}_onchain_sorted.json"

  anchor idl fetch -o "$onchain" "$id" --provider.cluster devnet >/dev/null
  jq -S . "$NEXTJS_IDL_DIR/${name}.json" > "$local_sorted"
  jq -S . "$onchain" > "$onchain_sorted"

  if cmp -s "$local_sorted" "$onchain_sorted"; then
    echo "${name}: OK (local IDL matches on-chain IDL)"
  else
    echo "${name}: MISMATCH (local IDL differs from on-chain IDL)"
    exit 1
  fi
done
echo

echo "== Entropy security =="
entropy_pda="$(solana find-program-derived-address "${ICHOR_PROGRAM_ID}" string:entropy_config)"
if entropy_json="$(solana account -u devnet "${entropy_pda}" --output json 2>/dev/null)"; then
  entropy_b64="$(echo "${entropy_json}" | jq -r '.account.data[0]')"
  entropy_hex="$(echo "${entropy_b64}" | base64 --decode | xxd -p -c 999)"
  # Anchor account layout: discriminator(8) + initialized(1) + enabled(1) + ...
  initialized_hex="${entropy_hex:16:2}"
  enabled_hex="${entropy_hex:18:2}"
  if [[ "${initialized_hex}" != "01" ]]; then
    fail "entropy config account exists but initialized=false"
  fi
  if [[ "${enabled_hex}" == "01" ]]; then
    echo "Entropy config: ENABLED (${entropy_pda})"
  elif [[ "${REQUIRE_ENTROPY_CONFIG}" == "true" ]]; then
    fail "entropy config exists but enabled=false while REQUIRE_ENTROPY_CONFIG=true"
  else
    echo "Entropy config: present but disabled (${entropy_pda})"
    echo "Warning: shower RNG will use SlotHashes fallback (not VRF-grade)."
  fi
else
  if [[ "${REQUIRE_ENTROPY_CONFIG}" == "true" ]]; then
    fail "entropy config PDA not found (${entropy_pda}) while REQUIRE_ENTROPY_CONFIG=true"
  fi
  echo "Entropy config: not initialized (${entropy_pda})"
  echo "Warning: shower RNG will use SlotHashes fallback (not VRF-grade)."
fi
echo

echo "Preflight complete: devnet state and IDLs are consistent."
