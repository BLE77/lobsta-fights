# Code Review Todo

Status: completed on March 13, 2026 after implementation and follow-up review passes.

Purpose:
- Track concrete bugs found during code review.
- Keep the list implementation-focused, not discussion-focused.
- Work from top severity downward.

## High Priority

- [x] Prevent `close_rumble` from draining real unclaimed winner payouts when the remaining payout is below the rent floor.
  Files:
  - `packages/solana/programs/rumble-engine/src/lib.rs`
  Fix target:
  - Stop using `vault_balance <= rent.minimum_balance(0)` as the proxy for "winner claims are exhausted".
  - Gate close on actual claim exhaustion / winner-claim safety, not rent-floor math.
  Review refs:
  - `lib.rs:1721`
  - `lib.rs:1985`
  - `lib.rs:2003`
  - `lib.rs:629`

- [x] Remove the rent-reserve assumption from result-finalization treasury extraction for ephemeral vault PDAs.
  Files:
  - `packages/solana/programs/rumble-engine/src/lib.rs`
  Fix target:
  - Make `extract_result_treasury_cut` work for small pots.
  - Avoid wedging payout transition when a valid rumble has a tiny vault.
  Review refs:
  - `lib.rs:3115`
  - `lib.rs:3121`
  - `lib.rs:1546`
  - `lib.rs:1600`
  - `lib.rs:629`

- [x] Replace the in-memory registration nonce store with a shared durable store, and only consume nonces after signature validation succeeds.
  Files:
  - `packages/nextjs/lib/mobile-siws.ts`
  - `packages/nextjs/app/api/fighter/register/route.ts`
  - `packages/nextjs/app/api/mobile-auth/nonce/route.ts`
  Fix target:
  - Make wallet-signature registration work across Vercel instances.
  - Prevent malformed or replayed submissions from burning a real user's live nonce before verification.
  Review refs:
  - `mobile-siws.ts:5`
  - `mobile-siws.ts:13`
  - `mobile-siws.ts:25`
  - `route.ts:112`

- [x] Fix the public status route so it never regresses a slot from `combat` back to `betting`.
  Files:
  - `packages/nextjs/app/api/rumble/status/route.ts`
  Fix target:
  - Preserve monotonic stage progression when local state is already more advanced than chain-read lag.
  - Do not return a betting-shaped slot after local betting has already closed.
  Review refs:
  - `status/route.ts:992`
  - `status/route.ts:997`
  - `status/route.ts:1001`
  - `status/route.ts:1026`

- [x] Decouple mainnet betting visibility from betting-ready marker persistence failures.
  Files:
  - `packages/nextjs/lib/rumble-orchestrator.ts`
  Fix target:
  - Do not clear an already-armed betting window just because `publishBettingReadyMarker()` failed.
  - Treat marker persistence as a mirror/recovery mechanism, not a hard dependency for a live on-chain betting window.
  Review refs:
  - `rumble-orchestrator.ts:2020`
  - `rumble-orchestrator.ts:3077`
  - `rumble-orchestrator.ts:3081`
  - `rumble-orchestrator.ts:3083`

## Medium Priority

- [x] Make Seeker Genesis auto-approval atomic so one asset cannot auto-approve two wallets concurrently.
  Files:
  - `packages/nextjs/lib/wallet-trust.ts`
  - `packages/nextjs/app/api/fighter/register/route.ts`
  Fix target:
  - Reserve / mark the Seeker asset as used atomically with approval.
  - Prevent two parallel registrations from both observing the asset as unused.
  Review refs:
  - `wallet-trust.ts:495`
  - `wallet-trust.ts:506`
  - `wallet-trust.ts:535`
  - `route.ts:801`

- [x] Add retry/backoff for mobile bet registration when the bet transaction is still propagating on-chain.
  Files:
  - `packages/mobile-native/App.tsx`
  - `packages/nextjs/app/rumble/page.tsx`
  Fix target:
  - Match the web client behavior so mobile does not report false bet failures after successful sends.
  - Reuse the existing retryable-registration pattern already present on web.
  Review refs:
  - `App.tsx:1845`
  - `App.tsx:1856`
  - `App.tsx:1869`
  - `page.tsx:1807`

- [x] Re-check `MAX_BET_SOL` after duplicate batch legs are aggregated in bet-prepare.
  Files:
  - `packages/nextjs/app/api/rumble/bet/prepare/route.ts`
  Fix target:
  - Prevent callers from bypassing the intended max by splitting one fighter stake across multiple legs in the same batch.
  Review refs:
  - `prepare/route.ts:205`
  - `prepare/route.ts:219`
  - `prepare/route.ts:250`
  - `prepare/route.ts:262`
  - `prepare/route.ts:277`

- [x] Scope SSE slot patches by `rumbleId`, not just `slotIndex`.
  Files:
  - `packages/nextjs/app/rumble/page.tsx`
  Fix target:
  - Ignore stale SSE events that belong to an older rumble in the same slot.
  - Prevent transient UI corruption such as reopened betting or wrong payout state.
  Review refs:
  - `page.tsx:1281`
  - `page.tsx:1328`
  - `page.tsx:1346`

## Lower Priority / Visibility Bugs

- [x] Fix active exposure reporting in on-chain claims snapshot so active betting/combat rumbles are not underreported.
  Files:
  - `packages/nextjs/lib/rumble-onchain-claims.ts`
  Fix target:
  - Use `rumble_number` or another authoritative numeric field instead of parsing `ucf_rumbles.id`.
  Review refs:
  - `rumble-onchain-claims.ts:557`
  - `rumble-onchain-claims.ts:562`
  - `rumble-onchain-claims.ts:581`

- [x] Fix `totalClaimableSol` aggregation so it reflects all claimable rumbles, not just the paginated slice.
  Files:
  - `packages/nextjs/lib/rumble-onchain-claims.ts`
  Fix target:
  - Compute totals before applying the result limit, or return both sliced and full totals explicitly.
  Review refs:
  - `rumble-onchain-claims.ts:640`
  - `rumble-onchain-claims.ts:647`

- [x] Replace spoofable/in-memory fighter-registration anti-sybil controls with durable, trusted request identity.
  Files:
  - `packages/nextjs/app/api/fighter/register/route.ts`
  - `packages/nextjs/lib/rate-limit.ts`
  Fix target:
  - Stop trusting raw `x-forwarded-for` / `x-real-ip` as the abuse key.
  - Move registration quotas and per-IP fighter limits out of process memory if they are meant to matter in production.
  Review refs:
  - `route.ts:28`
  - `route.ts:38`
  - `route.ts:579`

- [x] Fix status hydration when worker slot reports are ahead of persisted rumble rows.
  Files:
  - `packages/nextjs/app/api/rumble/status/route.ts`
  Fix target:
  - Do not apply a new `rumbleId` / `state` to a slot while leaving stale fighters/turns from the previous rumble attached.
  Review refs:
  - `status/route.ts:1685`
  - `status/route.ts:1696`

- [x] Use the worker-reported queue countdown for `nextRumbleIn` instead of local Vercel queue-manager state.
  Files:
  - `packages/nextjs/app/api/rumble/status/route.ts`
  Fix target:
  - Eliminate countdown drift between Railway-owned runtime state and the public API.
  Review refs:
  - `status/route.ts:1599`
  - `status/route.ts:1640`

## Notes

- This file is a work queue, not the runtime source of truth.
- Keep `docs/RUMBLE_SYSTEMS_SOURCE_OF_TRUTH.md` and `docs/RUMBLE_SYSTEM_FLOW.html` focused on system behavior, not bug backlog.
