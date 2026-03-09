# Hard Reset (Fresh Redeploy Path)

Use this when you want to discard old stuck rumbles/delegations and start clean.

## 1. Disable ER + wipe local/session/DB state

From `packages/nextjs`:

```bash
npm run reset:hard-rumble -- --apply
```

What this does:

- Writes a new `.rumble-session.json` floor timestamp.
- Sets `MAGICBLOCK_ER_ENABLED=false` in `.env.local`.
- Deletes rows from:
  - `ucf_bets`
  - `ucf_rumbles`
  - `ucf_rumble_queue`
  - `ucf_used_tx_signatures` (if table exists)
- Resets aggregate rows in `ucf_ichor_shower` and `ucf_rumble_stats`.

Dry-run:

```bash
npm run reset:hard-rumble
```

## 2. Redeploy Rumble Engine as a new program ID

In `packages/solana`:

1. Generate/update the program keypair for `rumble_engine`.
2. Update `declare_id!` in `programs/rumble-engine/src/lib.rs`.
3. Update `Anchor.toml` `programs.devnet.rumble_engine`.
4. Build and deploy.

## 3. Point app env to new program ID

In `packages/nextjs/.env.local`:

```bash
NEXT_PUBLIC_RUMBLE_ENGINE_PROGRAM=<new_program_id>
RUMBLE_ENGINE_PROGRAM_ID=<new_program_id>
MAGICBLOCK_ER_ENABLED=false
```

## 4. Re-initialize on-chain config

Run your init script(s) so the new program has fresh config PDAs.

## 5. Re-enable ER only after validation

When you are ready to test ER again:

```bash
MAGICBLOCK_ER_ENABLED=true
MAGICBLOCK_ER_RPC_URL=https://devnet-router.magicblock.app
MAGICBLOCK_ER_VALIDATOR_PUBKEY=MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd
MAGICBLOCK_ER_VALIDATOR_RPC_URL=https://devnet-us.magicblock.app
RUMBLE_ONCHAIN_TURN_AUTHORITY=true
RUMBLE_ALLOW_LEGACY_FALLBACK=false
RUMBLE_REQUIRE_MATCHUP_VRF=true
RUMBLE_MATCHUP_VRF_TIMEOUT_MS=60000
RUMBLE_REQUIRE_SHOWER_VRF=true
```

For a US-only deployment, set both validator variables. That pins delegation to
the US validator instead of relying on MagicBlock's "closest validator"
selection.

For strict full on-chain mode:

- Do not allow legacy combat fallback.
- Do not open turn 1 until `combat_state.vrf_seed` is non-zero.
- Do not use `checkIchorShower` if shower VRF is required.
- Do not finish a delegated rumble off-chain while waiting for undelegation.

If MagicBlock support says a PDA is pinned to a specific region, run recovery
against that validator first before switching back to the router, for example:

```bash
npx tsx scripts/debug-er-undelegate.ts --rumble-id <id> --er-rpc https://devnet-as.magicblock.app
```

Then run a full end-to-end test pass.
