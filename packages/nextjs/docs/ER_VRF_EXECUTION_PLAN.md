# ER + VRF Execution Plan

This is the rollout plan for running Lobsta Fights in strict on-chain mode with
MagicBlock ER and MagicBlock VRF. The goal is not to rescue old test rumbles.
The goal is to make new rumbles deterministic, region-pinned, and auditable.

## Target Architecture

- Betting state and claim state stay on Solana L1.
- `combat_state` runs on MagicBlock ER.
- matchup pairing randomness comes from `combat_state.vrf_seed` only
- Ichor Shower randomness comes from `requestIchorShowerVrf` only
- no production rumble silently switches back to legacy combat or slot-hash RNG

## Team Tracks

### Team 1: Program + Runtime

Scope:

- Keep `RUMBLE_ONCHAIN_TURN_AUTHORITY=true`.
- Keep `RUMBLE_ALLOW_LEGACY_FALLBACK=false`.
- Require matchup VRF before turn 1 opens.
- Require ER undelegation before final L1 finalize.
- Require shower VRF when the shower pool is non-zero.

Implemented in code:

- `packages/nextjs/lib/rumble-orchestrator.ts`
- `packages/nextjs/lib/solana-programs.ts`

Success criteria:

- `openTurn` never runs before `combat_state.vrf_seed` is non-zero.
- a rumble aborts if ER delegation is missing instead of continuing on L1.
- a rumble aborts if final undelegation times out instead of completing off-chain.
- payout retries if a required shower VRF request cannot be issued.

### Team 2: Infra + Deployment

Scope:

- Pin ER to the US validator explicitly.
- Route ER traffic through the router.
- mirror strict-mode env vars into Railway worker/runtime config.

Required env:

```bash
MAGICBLOCK_ER_ENABLED=true
MAGICBLOCK_ER_RPC_URL=https://devnet-router.magicblock.app
MAGICBLOCK_ER_VALIDATOR_PUBKEY=MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd
MAGICBLOCK_ER_VALIDATOR_RPC_URL=https://devnet-us.magicblock.app
RUMBLE_ONCHAIN_TURN_AUTHORITY=true
RUMBLE_ALLOW_LEGACY_FALLBACK=false
RUMBLE_REQUIRE_MATCHUP_VRF=true
RUMBLE_MATCHUP_VRF_RETRY_MS=5000
RUMBLE_MATCHUP_VRF_TIMEOUT_MS=60000
RUMBLE_REQUIRE_SHOWER_VRF=true
RUMBLE_FINALIZE_UNDELEGATE_RETRY_MS=15000
RUMBLE_FINALIZE_UNDELEGATE_TIMEOUT_MS=120000
```

Notes:

- do not leave Railway on "closest validator" behavior
- do not point production ER traffic directly at Asia or generic devnet endpoints
- the worker and any admin scripts must share the same ER validator config

### Team 3: QA + Observability

Scope:

- validate one fresh rumble end to end on devnet
- inspect logs for strict-mode retries vs silent fallback
- confirm VRF and ER sequencing on chain

Primary things to watch:

- `delegateCombat` uses the US validator
- `requestMatchupSeed` lands before `openTurn`
- `requestIchorShowerVrf` lands when shower pool is non-zero
- `pending_vrf_shower_result` is persisted until reconciliation completes
- no rumble finishes through legacy fallback

## Runtime Rules

- If ER delegation is required and not active, abort the rumble.
- If ER read fails and only L1 state is readable, abort the rumble.
- If combat advances before `vrf_seed` is present, abort the rumble.
- If matchup VRF never arrives before timeout, abort the rumble.
- If final undelegation never completes before timeout, abort the rumble.
- If shower VRF is required and a request cannot be issued, retry payout instead of degrading.
- If another shower VRF request is already active, delay the next shower until the current one settles.

## Deployment Sequence

1. Deploy the program version that includes the current turn-authority and VRF fields.
2. Update Railway env vars to the exact strict-mode values above.
3. Start from a fresh devnet program and fresh queue state.
4. Start the worker with ER enabled and confirm it reads the US validator config.
5. Run one rumble with enough betting/payout activity to accumulate a non-zero shower pool.
6. Review the logs and on-chain state before running broader traffic.

## Smoke Test

1. Create one fresh rumble.
2. Confirm `delegateCombat` succeeds and the `combat_state` owner moves to ER.
3. Confirm `requestMatchupSeed` is submitted.
4. Confirm `readRumbleCombatState(...).vrfSeed` becomes non-zero before `openTurn`.
5. Confirm turns continue on ER without an L1 fallback log.
6. Confirm final combat resolution waits for undelegation before `finalizeRumble`.
7. Confirm payout requests `requestIchorShowerVrf` if the shower pool is non-zero.
8. Confirm `pending_vrf_shower_result` clears only after reconciliation.

## Failure Policy

- Old stuck test rumbles are disposable. Do not spend engineering time recovering them unless they contain required state.
- New strict-mode rumbles should fail closed, not fail open.
- A failed rumble is cheaper than a rumble that silently mixes ER, L1, and fallback RNG.

## Acceptance Checks

- No production log line says `falling back to L1` during ER combat.
- No production log line says `legacy off-chain mode is active`.
- No production log line says `falling back to slot-hash RNG`.
- No production log line says `falling back to checkIchorShower`.
- `combat_state.vrf_seed` is present before the first turn opens.
- shower attribution survives a worker restart because pending VRF context is stored in `admin_config`.
