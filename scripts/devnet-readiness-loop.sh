#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NEXTJS_DIR="$ROOT_DIR/packages/nextjs"
SOLANA_DIR="$ROOT_DIR/packages/solana"
OUT_DIR="$ROOT_DIR/artifacts/devnet-readiness"
mkdir -p "$OUT_DIR"

LOOP_INTERVAL_SEC="${LOOP_INTERVAL_SEC:-20}"
LOOP_MAX_ITERATIONS="${LOOP_MAX_ITERATIONS:-0}" # 0 = infinite
STOP_ON_SUCCESS="${STOP_ON_SUCCESS:-false}"
RUN_RUNTIME_SMOKE="${RUN_RUNTIME_SMOKE:-true}"
RUNTIME_API_URL="${RUNTIME_API_URL:-http://localhost:3000}"
MIN_SOL_BALANCE="${MIN_SOL_BALANCE:-8}"
REQUIRE_ENTROPY_CONFIG="${REQUIRE_ENTROPY_CONFIG:-false}"

lower() {
  printf "%s" "$1" | tr '[:upper:]' '[:lower:]'
}

is_true() {
  case "$(lower "${1:-}")" in
    1|true|yes|y|on) return 0 ;;
    *) return 1 ;;
  esac
}

run_once() {
  local iteration="$1"
  local log_file="$OUT_DIR/run-${iteration}.log"
  local now_utc
  now_utc="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

  {
    echo "=== Devnet Readiness Iteration ${iteration} @ ${now_utc} ==="
    echo "[1/4] Next.js typecheck"
    (cd "$NEXTJS_DIR" && npx tsc --noEmit)

    echo "[2/4] Solana cargo check"
    (
      cd "$SOLANA_DIR"
      cargo check -p ichor-token -p rumble-engine -p fighter-registry
    )

    echo "[3/4] Devnet preflight"
    (
      cd "$SOLANA_DIR"
      MIN_SOL_BALANCE="$MIN_SOL_BALANCE" \
      REQUIRE_ENTROPY_CONFIG="$REQUIRE_ENTROPY_CONFIG" \
      npm run preflight:devnet
    )

    if is_true "$RUN_RUNTIME_SMOKE"; then
      echo "[4/4] Runtime API smoke (${RUNTIME_API_URL})"
      local status_json history_json
      status_json="$(curl -fsS "${RUNTIME_API_URL}/api/rumble/status")"
      history_json="$(curl -fsS "${RUNTIME_API_URL}/api/rumble/history?limit=1")"

      node -e '
        const status = JSON.parse(process.argv[1]);
        if (!Array.isArray(status.slots)) throw new Error("status.slots missing");
        if (!Array.isArray(status.queue)) throw new Error("status.queue missing");
        if (!status.ichorShower || typeof status.ichorShower !== "object") {
          throw new Error("status.ichorShower missing");
        }
        console.log(`status-ok slots=${status.slots.length} queue=${status.queue.length}`);
      ' "$status_json"

      node -e '
        const history = JSON.parse(process.argv[1]);
        if (!Array.isArray(history.results)) throw new Error("history.results missing");
        console.log(`history-ok total=${history.total ?? 0} page=${history.results.length}`);
      ' "$history_json"
    else
      echo "[4/4] Runtime API smoke skipped (RUN_RUNTIME_SMOKE=${RUN_RUNTIME_SMOKE})"
    fi

    echo "RESULT: PASS"
  } >"$log_file" 2>&1
}

echo "Starting devnet readiness loop"
echo "Logs: $OUT_DIR"
echo "Config: LOOP_INTERVAL_SEC=$LOOP_INTERVAL_SEC LOOP_MAX_ITERATIONS=$LOOP_MAX_ITERATIONS STOP_ON_SUCCESS=$STOP_ON_SUCCESS RUN_RUNTIME_SMOKE=$RUN_RUNTIME_SMOKE MIN_SOL_BALANCE=$MIN_SOL_BALANCE REQUIRE_ENTROPY_CONFIG=$REQUIRE_ENTROPY_CONFIG"
echo

iteration=0
while true; do
  iteration=$((iteration + 1))
  latest="$OUT_DIR/latest.log"

  if run_once "$iteration"; then
    ln -sf "run-${iteration}.log" "$latest"
    echo "[$(date +"%H:%M:%S")] PASS iteration=${iteration} log=${latest}"
    if is_true "$STOP_ON_SUCCESS"; then
      exit 0
    fi
  else
    ln -sf "run-${iteration}.log" "$latest"
    echo "[$(date +"%H:%M:%S")] FAIL iteration=${iteration} log=${latest}"
  fi

  if [[ "$LOOP_MAX_ITERATIONS" != "0" ]] && (( iteration >= LOOP_MAX_ITERATIONS )); then
    echo "Reached LOOP_MAX_ITERATIONS=${LOOP_MAX_ITERATIONS}. Exiting."
    exit 0
  fi

  sleep "$LOOP_INTERVAL_SEC"
done
