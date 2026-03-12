# Rumble Systems Source Of Truth

Status: canonical runtime map for the live rumble stack as of March 11, 2026.

Companion files:
- `docs/RUMBLE_SYSTEM_FLOW.html` for the stage-by-stage visual map
- `docs/CODEBASE_MAP.md` for a lighter repo map

How to use this file:
- Treat this as the authoritative written description of the live rumble systems.
- When product behavior changes, update this file in the same PR as the code and env changes.
- If code disagrees with this file, the mismatch is either a bug, an unfinished migration, or a stale doc. Resolve it explicitly.

Scope:
- This file covers the live game/runtime systems: worker ownership, queueing, betting, combat, payouts, clients, persistence, and operations.
- It does not try to fully document art pipelines, LoRA training, tokenomics strategy, or broader whitepaper material.

## Canonical Top-Line Truths

- One active rumble runs at a time in the live runtime. `NUM_SLOTS = 1`.
- Railway is the single mutating runtime. It owns lifecycle advancement and combat progression.
- Vercel serves UI and public APIs, but it must not create rumbles or run combat in production.
- Mainnet is the money side. Real bets, real bettor accounting, and real claimability live there.
- Settlement economics are `1%` platform + `1%` fighter sponsorship upfront, `98%` to pool, then `3%` of losers' pool extracted once at result finalization.
- Combat runs on the combat side, using the combat connection. When enabled, that means MagicBlock ER; otherwise it falls back to Solana L1/devnet combat RPC.
- Supabase is the durable mirror and recovery layer. It is how Vercel sees Railway-owned state and how the worker recovers after churn.
- Public betting is not truly open until the mainnet rumble account exists, is readable, is in `betting`, and has a real close deadline.
- Winner claims are intended to remain available until claimed. The `24h` buffer is for completion/ops flow, not a bettor-claim expiry.
- Web and mobile are mostly poll-driven readers of `/api/rumble/status`, with local merge logic to smooth out-of-order snapshots.

## Source Of Truth By Concern

| Concern | Primary truth | Secondary / mirror |
| --- | --- | --- |
| Live lifecycle advancement | Railway worker + `RumbleOrchestrator` | Supabase persistence for recovery |
| Queue membership | Railway memory while worker is healthy | `ucf_rumble_queue` |
| Active rumble identity | Railway slot state + `ucf_rumbles` | betting-ready marker + status API |
| Whether betting can actually accept money | mainnet rumble program | status API projection |
| Bet transaction validity | mainnet transaction contents | `/api/rumble/bet` verification result |
| Combat turn state | combat program state | status API + persisted turns/comments |
| Claimability | mainnet rumble + bettor/vault state | `/api/rumble/balance` and Supabase payout mirror |
| Frontend stage display | `/api/rumble/status` plus client merge rules | local UI state |

## System Inventory

| System | Purpose | Main files |
| --- | --- | --- |
| Runtime / stage machine | Owns queue, slot stages, combat, payout, cleanup | `packages/nextjs/lib/queue-manager.ts`, `packages/nextjs/lib/rumble-orchestrator.ts`, `packages/nextjs/rumble-worker.ts` |
| Queue system | Holds fighters until a rumble locks and starts | `packages/nextjs/lib/queue-manager.ts`, `packages/nextjs/lib/rumble-config.ts`, `packages/nextjs/app/api/rumble/queue/route.ts` |
| Betting / money side | Creates mainnet rumbles, prepares bet txs, verifies bet txs, tracks claims | `packages/nextjs/app/api/rumble/bet/*`, `packages/nextjs/lib/solana-programs.ts`, `packages/nextjs/lib/tx-verify.ts`, `packages/solana/programs/rumble-engine/src/lib.rs` |
| Combat / move side | Builds commit/reveal txs, runs turns, resolves eliminations and winner | `packages/nextjs/app/api/rumble/move/*`, `packages/nextjs/lib/rumble-orchestrator.ts`, `packages/nextjs/lib/solana-connection.ts`, `packages/solana/programs/rumble-engine/src/lib.rs` |
| Payout / claims | Settles winner-takes-all state and lets winners claim | `packages/nextjs/app/api/rumble/claim/*`, `packages/nextjs/lib/rumble-onchain-claims.ts`, `packages/nextjs/lib/rumble-persistence.ts`, `packages/solana/programs/rumble-engine/src/lib.rs` |
| Client surfaces | Render the live arena and drive wallet interactions | `packages/nextjs/app/rumble/page.tsx`, `packages/nextjs/app/rumble/components/*`, `packages/mobile-native/App.tsx`, `packages/mobile-native/lib/utils.ts` |
| Persistence / recovery | Makes Railway state recoverable and Vercel-readable | `packages/nextjs/lib/rumble-persistence.ts`, `packages/nextjs/lib/rumble-state-recovery.ts`, `packages/nextjs/lib/mainnet-retry.ts`, `packages/nextjs/lib/commentary-hook.ts` |
| Ops / control plane | Worker lease, health, command queue, admin-triggered actions | `packages/nextjs/rumble-worker.ts`, `packages/nextjs/lib/worker-commands.ts`, `packages/nextjs/lib/rumble-persistence.ts` |

## 1. Runtime And Stage Machine

### What this system is

This is the game brain. It owns the authoritative lifecycle:

`idle -> betting_init -> betting_live -> combat -> payout -> idle`

In code, `QueueManager` only exposes coarse slot states like `idle`, `betting`, `combat`, and `payout`, but the real behavior includes an internal split between:

- `betting_init`: slot is in `betting`, but `bettingDeadline === null`
- `betting_live`: slot is in `betting`, and `bettingDeadline` is armed

### Who owns it

- Railway worker process in `packages/nextjs/rumble-worker.ts`
- `RumbleOrchestrator` in `packages/nextjs/lib/rumble-orchestrator.ts`
- `RumbleQueueManager` in `packages/nextjs/lib/queue-manager.ts`

### What is authoritative

- Railway worker is the only intended mutator in production.
- `orchestrator.tick()` is the lifecycle authority.
- `QueueManager` holds the live in-memory slot and queue state.
- Supabase is the durable recovery layer, not the active execution owner.

### How it works

1. The worker wakes on an interval.
2. It acquires the singleton worker lease from Supabase.
3. It runs recovery and reconciliation jobs as needed.
4. It calls `orchestrator.tick()`.
5. `advanceSlots()` in `QueueManager` moves coarse stages forward.
6. `RumbleOrchestrator` handles all non-trivial phase work:
   - rumble creation
   - mainnet readiness checks
   - betting arming
   - combat turn execution
   - payout persistence
   - cleanup

### Current runtime values

- `NUM_SLOTS = 1`
- Active worker tick interval default: `2000ms`
- Idle worker tick interval default: `15000ms`
- Reconcile interval default: `60000ms`
- Mainnet retry interval default: `30000ms`
- Worker lease TTL: `max(15000, activeTickInterval * 3)`

### Important guards

- Vercel mutation guard: `tick()` returns early on Vercel unless explicitly force-enabled.
- In-process concurrency guard: `tickInFlight` prevents overlapping ticks in one process.
- Cross-process concurrency guard: `worker_lease` table prevents overlapping Railway writers.

### Failure and recovery

- Cold start recovery: `recoverOrchestratorState()` rebuilds live slot state from Supabase.
- Betting-init fail-closed: a slot can sit in `betting` with no public deadline until mainnet is ready.
- Duplicate rumble prevention: duplicate slot creates are rejected via persisted checks.
- Stalled betting abort: unready betting slots can be recycled and fighters re-queued.
- Payout retry: payout persistence failures throw so the next worker tick retries.

## 2. Queue System

### What this system is

This system decides when a rumble starts and which fighters are pulled into it.

### Main files

- `packages/nextjs/lib/queue-manager.ts`
- `packages/nextjs/lib/rumble-config.ts`
- `packages/nextjs/app/api/rumble/queue/route.ts`
- `packages/nextjs/lib/rumble-queue-reconcile.ts`

### Canonical truths

- Today the runtime is one active queue feeding one active rumble slot.
- Queue state lives in memory first and is mirrored to `ucf_rumble_queue`.
- Queue position and countdown visible in the UI come from the worker/status projection, not from chain.

### Current config behavior

- Default `MIN_FIGHTERS_TO_START = 12`
- Default `FIGHTERS_PER_RUMBLE = 12`
- Code allows clamping up to `16`
- Default queue lock countdown: `30000ms`

### Actual flow today

1. Fighters join the queue.
2. When the queue can start a rumble, `QueueManager` pulls up to `FIGHTERS_PER_RUMBLE`.
3. The slot moves from `idle` to `betting`.
4. At that moment, the slot gets:
   - a new rumble id
   - its fighter list
   - an empty betting pool
   - `bettingDeadline = null`
5. Railway then attempts to create the rumble record and on-chain state.

### Important nuance

There are two different product ideas floating around:

- current code default: `12 start / 12 full / 30s lock`
- intended target being discussed: `12 start / 16 full / 10s lock`

That mismatch is currently a live alignment issue, not just documentation wording.

### Failure and recovery

- If Railway restarts, queue can be rehydrated from `ucf_rumble_queue`.
- If a betting slot fails before real betting opens, fighters can be recycled into the queue.
- Queue reconciliation tries to re-add fighters that exist in Supabase but are missing from the in-memory queue.

## 3. Betting And Mainnet Money System

### What this system is

This is the money side of the product.

It is responsible for:

- creating the mainnet rumble account
- exposing betting only when mainnet is actually ready
- building user bet transactions
- sending those transactions
- verifying those transactions
- mirroring accepted bets into app persistence

### Main files

- `packages/nextjs/lib/rumble-orchestrator.ts`
- `packages/nextjs/lib/solana-programs.ts`
- `packages/nextjs/app/api/rumble/bet/prepare/route.ts`
- `packages/nextjs/app/api/rumble/wallet-submit/route.ts`
- `packages/nextjs/app/api/rumble/bet/route.ts`
- `packages/nextjs/lib/tx-verify.ts`
- `packages/nextjs/lib/betting-rumble-candidates.ts`
- `packages/solana/programs/rumble-engine/src/lib.rs`

### What is authoritative

- The mainnet rumble program is the authority for whether betting is really open.
- The transaction on chain is the authority for whether a user really placed a bet.
- Supabase is the mirror that lets the app show odds/history and recover after worker churn.

### Step 1: Railway creates the mainnet rumble

When Railway starts a betting slot, it eventually calls into the on-chain create flow.

The important behavior:

- a mainnet rumble PDA must exist
- it must contain the fighter list
- it must be in `betting`
- it must have a valid betting close deadline

`createRumbleMainnet(...)` in `solana-programs.ts` converts the desired close time into either:

- a slot-based close value, or
- a unix-based close value

depending on env/config and fallback behavior.

### Step 2: Public betting stays hidden until mainnet is readable

The public window is not armed immediately.

`armBettingWindowIfReady(...)` in `rumble-orchestrator.ts` checks mainnet and only arms the local/public deadline when:

- the mainnet rumble account is readable
- mainnet state is `betting`
- the close slot or unix deadline is valid and still in the future

If any of those checks fail, public betting stays closed.

Once armed, Railway publishes a betting-ready marker to Supabase:

- admin config key: `public_betting_ready_slot_{slotIndex}`

That marker lets readers and APIs agree on which rumble is the current bettable one.

### Step 3: The client prepares a real bet transaction

Route:

- `POST /api/rumble/bet/prepare`

The client sends:

- `slot_index`
- `wallet_address`
- one bet or a batch of bets

The prepare route:

1. resolves the current bettable rumble for that slot
2. checks that the fighter list is complete enough
3. checks that betting is not too close to closing
4. converts SOL amounts into lamports
5. resolves fighter ids to fighter indexes
6. builds an unsigned mainnet transaction

Returned payload includes:

- `transaction_base64`
- `rumble_id`
- `rumble_id_num`
- `bets`
- `tx_kind`
- on-chain close metadata

### Step 4: The wallet signs the transaction

Web and mobile both decode the returned transaction and ask the user wallet to sign it.

Important truth:

- the backend does not spend user funds by itself
- the wallet signature is the real user authorization

### Step 5: The signed transaction is sent to mainnet

There are two main submission patterns in the code:

- web commonly relays through `POST /api/rumble/wallet-submit`
- mobile can send the raw signed transaction directly using the betting connection

For betting relays, `wallet-submit` refuses transactions that do not include the mainnet rumble program id.

### Step 6: The app registers the bet after send

Route:

- `POST /api/rumble/bet`

The client submits:

- `slot_index`
- `wallet_address`
- `tx_signature`
- bet legs
- rumble metadata returned by prepare

The registration route then verifies the chain transaction.

Checks include:

- the wallet really signed the tx
- the tx succeeded on chain
- it contains `place_bet` instructions for the expected rumble
- fighter indexes match expected legs
- amounts match expected legs
- the transaction signature has not already been used

Replay protection:

- primary path uses `ucf_used_tx_signatures`
- fallback path uses in-memory signature tracking if the table is unavailable

### Step 7: The app mirrors the accepted bet

If verification succeeds, the app writes the bet into Supabase.

Primary table:

- `ucf_bets`

When the live slot still matches, Railway memory odds are updated too. If the live slot moved, persistence is still used so the accepted transaction is not lost.

### Fee flow inside `place_bet`

On chain, `place_bet` does not send the full user amount into the winner pool.

Current fee split:

- `1%` platform fee to treasury
- `1%` sponsorship fee to the fighter sponsorship account
- remaining `98%` goes to the vault / betting pool

Quick formula:

- `bet_amount = treasury_1pct + sponsorship_1pct + net_pool_98pct`
- on result finalization: `losers_pool * 3% -> treasury`, then winners split the remaining losers' pool pro-rata on top of their winning net stake

The bettor account PDA also tracks:

- authority wallet
- rumble id
- total deployed
- per-fighter deployments
- later claimable / claimed values

### Current betting timing values

- default public betting duration: `60000ms`
- close grace: `1500ms`
- minimum visible betting window: `45000ms`
- close guards also exist in prepare-time logic to avoid building txs right at the edge

### Known failure modes

- mainnet rumble exists locally in app state, but is not yet readable on chain
- close deadline is nearly expired, so prepare refuses to build a tx
- client sends a tx for one rumble while the live slot has already rotated
- signature replay attempts
- persistence drift between current slot and the prepared rumble identity

The recent fix direction is fail-closed:

- no public timer without a real mainnet deadline
- no open bet UI without `bettingDeadline`
- registration tied to the prepared/verified rumble, not just whatever the live slot says now

## 4. Combat And Move System

### What this system is

This is the fight side of the product.

It is responsible for:

- accepting commit transactions
- accepting reveal transactions
- advancing turns
- resolving damage/eliminations
- producing the winner and placements

### Main files

- `packages/nextjs/app/api/rumble/move/commit/prepare/route.ts`
- `packages/nextjs/app/api/rumble/move/reveal/prepare/route.ts`
- `packages/nextjs/lib/solana-programs.ts`
- `packages/nextjs/lib/solana-connection.ts`
- `packages/nextjs/lib/rumble-orchestrator.ts`
- `packages/nextjs/lib/turn-resolution.ts`
- `packages/solana/programs/rumble-engine/src/lib.rs`

### What is authoritative

- Combat state lives on the combat chain side.
- The app uses `getCombatConnectionAuto()`, which means:
  - MagicBlock ER if `MAGICBLOCK_ER_ENABLED=true`
  - otherwise the normal combat connection

### Move lifecycle

#### Commit

Route:

- `POST /api/rumble/move/commit/prepare`

The client sends:

- `wallet_address`
- `rumble_id`
- `turn`
- `move_hash`

The route builds an unsigned commit transaction against the combat connection.

#### Reveal

Route:

- `POST /api/rumble/move/reveal/prepare`

The client sends:

- `wallet_address`
- `rumble_id`
- `turn`
- `move_code` or move name
- `salt`

The route builds an unsigned reveal transaction against the combat connection.

### Turn windows currently in code

- commit window: `30 slots`
- reveal window: `30 slots`
- with the current `400ms` slot estimate, that is about `12s` commit and `12s` reveal
- max on-chain combat turns: `120`

### Orchestrator responsibilities

Railway still does the surrounding fight orchestration:

- deciding when combat starts
- advancing turns
- collecting/falling back agent decisions
- recording resolved turns
- deciding when the rumble is over
- persisting result state for the rest of the app

Current agent-side timing:

- internal agent timeout default: `3500ms`

### Important truths

- The next commit does not currently overlap the current reveal in the public lifecycle.
- Railway resolves the current turn, then the next turn opens.
- Combat is not the same thing as betting. Even though both use the same broader program family, they live on different runtime paths.

## 5. Result Settlement, Payout, And Claims

### What this system is

This system decides who won the money and how they claim it.

### Main files

- `packages/nextjs/lib/rumble-persistence.ts`
- `packages/nextjs/app/api/rumble/claim/prepare/route.ts`
- `packages/nextjs/app/api/rumble/claim/confirm/route.ts`
- `packages/nextjs/lib/rumble-onchain-claims.ts`
- `packages/solana/programs/rumble-engine/src/lib.rs`

### Current payout model

- `winner-takes-all`
- only bets on first place are eligible
- losers' pool pays winners
- treasury takes `3%` of losers' pool before winner distribution
- that `3%` is extracted exactly once when the result is finalized
- the payout vault keeps bettor-claimable funds after that extraction
- winner claims remain available until they are claimed

On-chain constants:

- `FIRST_PLACE_BPS = 100%`
- `SECOND_PLACE_BPS = 0%`
- `THIRD_PLACE_BPS = 0%`
- `TREASURY_CUT_BPS = 300`
- `PAYOUT_CLAIM_WINDOW_SECONDS = 86400` as a completion buffer, not a winner-claim expiry

### Off-chain mirror settlement

`settleWinnerTakeAllBets(...)` in `rumble-persistence.ts` mirrors the payout logic into `ucf_bets`.

For each rumble:

- losing bets become `lost`
- winning bets become:
  - `pending` in `accrue_claim` mode
  - `paid` in `instant` mode

Default mode in code:

- `RUMBLE_PAYOUT_MODE = accrue_claim`

### Claim flow

#### Prepare

Route:

- `POST /api/rumble/claim/prepare`

The route:

1. discovers claimable rumbles for the wallet from on-chain state
2. sorts by claimable amount
3. checks vault balances so it can skip underfunded claims
4. builds a single or batched `claim_payout` transaction

Returned payload includes:

- `transaction_base64`
- selected rumble ids
- total claimable SOL
- skipped underfunded count

#### Confirm

Route:

- `POST /api/rumble/claim/confirm`

The route verifies:

- wallet was the tx signer
- transaction succeeded on chain
- transaction includes `claim_payout` instruction(s) for the requested rumble PDA(s)

This is a confirmation/mirroring step, not the actual value transfer. The actual transfer happened on chain when the signed claim transaction landed.

### What is authoritative

- mainnet vault + bettor PDA state are the authority for claimability
- Supabase payout rows are the mirror used for wallet history and UX continuity

### Known failure modes

- claim flow disabled by payout mode
- vault underfunding
- transaction not found yet because client uses fire-and-forget submit
- stale pending payout rows in Supabase after a completed rumble

## 6. Client Surfaces, Status, Commentary, And Final-Hold UX

### Main files

- `packages/nextjs/app/rumble/page.tsx`
- `packages/nextjs/app/rumble/components/RumbleSlot.tsx`
- `packages/nextjs/app/rumble/components/BettingPanel.tsx`
- `packages/nextjs/app/rumble/components/CommentaryPlayer.tsx`
- `packages/mobile-native/App.tsx`
- `packages/mobile-native/lib/utils.ts`
- `packages/nextjs/app/api/rumble/status/route.ts`

### What this system is

This is the spectator/user-facing system.

It is responsible for:

- polling status
- merging snapshots
- rendering queue / betting / fight / payout
- sending wallet actions to the API
- playing commentary/audio

### Status flow

- Web and mobile both read `/api/rumble/status`.
- They do not trust raw responses blindly; both use monotonic merge rules so the UI does not visually rewind when responses arrive out of order.
- Realtime hooks exist, but in practice they mostly act as a refetch nudge. Polling remains the main production truth path because Railway and Vercel are separate runtimes.

### Betting UX rules

- Both web and mobile now fail closed for betting when `bettingDeadline` is missing.
- `state === betting` by itself is not enough to show a real open betting window.
- Web labels unarmed betting as initializing on-chain.
- Mobile shows `ARMING ON-CHAIN`.

### Countdown behavior

- Betting countdown comes from `bettingDeadline`, adjusted by close-guard behavior in the UI.
- Combat countdown uses `nextTurnTargetSlot`, `nextTurnAt`, or interval hints returned by status.

### Commentary behavior

- Railway generates/persists commentary artifacts.
- Vercel status API reads those persisted clips from Supabase.
- Web commentary is richer and has more playback logic.
- Mobile commentary is simpler and mostly follows the featured slot stream.

### Final-turn hold behavior

- Web currently has a hard final-turn hold of `5000ms` before payout replaces the combat view.
- Mobile does not appear to have the same dedicated final-turn hold path yet.

### Important risk

The client merge logic is intentionally protective, but it can also mask some server-side regressions by preferring the stronger previous local snapshot over a weaker new snapshot. That is good for UX smoothness and bad for debugging simplicity.

## 7. Persistence, Recovery, And Reconciliation

### What this system is

This is the durable memory layer that lets the game survive Railway restarts and lets Vercel read Railway-owned state.

### Main files

- `packages/nextjs/lib/rumble-persistence.ts`
- `packages/nextjs/lib/rumble-state-recovery.ts`
- `packages/nextjs/lib/mainnet-retry.ts`
- `packages/nextjs/lib/commentary-hook.ts`
- `packages/nextjs/lib/rumble-onchain-claims.ts`

### Core tables and records

- `ucf_rumble_queue`
- `ucf_rumbles`
- `ucf_bets`
- `ucf_used_tx_signatures`
- `mainnet_pending_ops`
- `worker_commands`
- `worker_lease`
- `ucf_commentary_clips`
- admin config keys such as:
  - `public_betting_ready_slot_{n}`
  - `worker_runtime_health`

### What is mirrored here

- queue membership
- rumble identity, stage, winner, and metadata
- bet rows and mirrored payout state
- transaction replay locks
- pending mainnet retries
- commentary clips
- worker health and control signals

### Recovery behavior

- `recoverOrchestratorState()` reloads queue and active rumbles after restart.
- Betting rumbles can restore as:
  - armed if they already have a valid visible deadline
  - forced-expired if bets already exist and the deadline is uncertain
  - unarmed if still waiting on chain readiness

### Reconciliation behavior

- queue reconciliation re-adds missing queue fighters from DB
- payout reconciliation repairs stale pending payout state
- mainnet retry replays pending create/report/complete/sweep ops from `mainnet_pending_ops`
- status route uses persisted betting-ready markers and active betting rows to identify the current bettable rumble

### Why this layer matters

Without this layer:

- Railway restarts would wipe the live queue and slot memory
- Vercel would not be able to display active betting odds or commentary generated by Railway
- clients could not reliably confirm historical bet and claim state

## 8. Operations And Control Plane

### What this system is

This is the operational plumbing around the game runtime.

### Main files

- `packages/nextjs/rumble-worker.ts`
- `packages/nextjs/lib/worker-commands.ts`
- `packages/nextjs/lib/rumble-persistence.ts`
- `packages/nextjs/app/api/admin/rumble/*`

### Worker lease

The worker lease is the cross-process single-writer lock.

- table: `worker_lease`
- one row id: `singleton`
- Railway worker must acquire it before mutating

This protects against duplicate lifecycle execution during deploy overlaps or multi-instance conditions.

### Worker health

The worker exposes `/healthz` and also persists runtime health into admin config:

- worker id
- last tick time
- queue length
- slot reports
- on-chain failure state

### Command queue

Admin actions initiated from Vercel are often queued into `worker_commands` for Railway to execute.

Examples:

- start bots
- stop bots
- set bot target
- restart bots
- test run

This avoids letting Vercel act as the real mutator.

### Mainnet retry queue

Mainnet ops that fail transiently are persisted into `mainnet_pending_ops` and retried later.

Op types include:

- `createRumble`
- `reportResult`
- `completeRumble`
- `sweepTreasury`

Rule:

- `sweepTreasury` is only valid for no-winner-bet rumbles
- winner rumbles extract the treasury cut at result finalization instead

## 9. Canonical Config Values To Keep In Sync

These values matter because they can drift between code defaults, local env, and Railway env:

- `FIGHTERS_PER_RUMBLE`
- `MIN_FIGHTERS_TO_START`
- `RUMBLE_QUEUE_LOCK_COUNTDOWN_MS`
- `RUMBLE_BETTING_DURATION_MS`
- `RUMBLE_BETTING_CLOSE_GRACE_MS`
- `RUMBLE_MIN_VISIBLE_BETTING_MS`
- `RUMBLE_PAYOUT_DURATION_MS`
- `RUMBLE_SLOT_MS_ESTIMATE`
- `RUMBLE_WORKER_MODE`
- `RUMBLE_PAYOUT_MODE`
- `MAGICBLOCK_ER_ENABLED`

Rule:

- if product chooses a number, that number must be aligned in code, Railway env, and this document

## 10. Current Known Alignment Gaps

- Queue spec is not fully locked. Product target and live defaults still disagree.
- Betting duration is not fully locked across checked-in env and code defaults.
- Final-move hold is not client-parity; web has it, mobile does not clearly match it.
- Status smoothing is strong enough that it can hide some regressions while making the UX feel better.
- The codebase still contains language and scaffolding that imply multi-slot behavior, but live runtime is one active slot.

## 11. Recommended Working Rule Going Forward

For every gameplay change:

1. Update `docs/RUMBLE_SYSTEMS_SOURCE_OF_TRUTH.md`
2. Update `docs/RUMBLE_SYSTEM_FLOW.html` if the stage diagram changed
3. Update code and Railway env in the same change
4. Treat any doc/code/env mismatch as a real bug, not as “just docs”
