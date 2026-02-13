# UCF / Claw Fights — Next Steps Breakdown

**Date:** Feb 12, 2026
**Branch:** `feature/ichor-token` (22 commits ahead of main)
**Hackathon Deadline:** Feb 18, 2026 (pump.fun "Build in Public" — $250K @ $10M valuation)

---

## What's DONE

### Code Complete
- [x] 3 Solana programs deployed to devnet (ichor_token, fighter_registry, rumble_engine)
- [x] Full Rumble lifecycle: queue → betting → combat → payout → idle
- [x] Winner-takes-all SOL economy (WIN_SHARE=1.0)
- [x] Seasons model (2500 ICHOR/fight, "Training Season")
- [x] ICHOR split: 10% bettors / 80% fighters / 10% Ichor Shower
- [x] Async on-chain calls with graceful degradation
- [x] Security hardened (2 rounds): crypto RNG, rate limiting, sybil protection, TX verification, RLS, API key hashing, reward dedup
- [x] 10 frontend components (RumbleSlot, FighterHP, BettingPanel, CombatFeed, PayoutDisplay, etc.)
- [x] SSE live updates + 2s polling fallback
- [x] Wallet adapter (Phantom + Solflare)
- [x] Fighter registration with image generation (Replicate Flux 1.1 Pro)
- [x] Comprehensive technical documentation (UCF_TECHNICAL_DOCS.md)
- [x] 9 fighters registered on-chain with wallet addresses

### Verified on Devnet
- [x] createRumble, startCombat, reportResult, mintRumbleReward, checkIchorShower, completeRumble
- [x] Winner receives ICHOR tokens on-chain
- [x] Shower vault ATA auto-created

---

## What's LEFT (Priority Order)

### Phase 1: Ship to Production (Days 1-2)

#### 1.1 Merge feature branch → main
- **Why:** Vercel deploys from `main` via Git integration
- **Risk:** 22 commits, massive diff. Do a squash merge or rebase merge.
- **Action:** `git checkout main && git merge feature/ichor-token` (or squash)

#### 1.2 Set Vercel Environment Variables
- **Why:** Production deploy needs all Solana + ICHOR env vars
- **Action:** Set these on Vercel dashboard (or `vercel env add`):
  ```
  NEXT_PUBLIC_HELIUS_API_KEY=REDACTED_KEY
  NEXT_PUBLIC_SOLANA_NETWORK=devnet
  NEXT_PUBLIC_ICHOR_TOKEN_MINT=4amdLk5Ue4pbM1CXRZeUn3ZBAf8QTXXGu4HqH5dQv3qM
  NEXT_PUBLIC_FIGHTER_REGISTRY_PROGRAM=2hA6Jvj1yjP2Uj3qrJcsBeYA2R9xPM95mDKw1ncKVExa
  NEXT_PUBLIC_RUMBLE_ENGINE_PROGRAM=2TvW4EfbmMe566ZQWZWd8kX34iFR2DM3oBUpjwpRJcqC
  NEXT_PUBLIC_ICHOR_TOKEN_PROGRAM=925GAeqjKMX4B5MDANB91SZCvrx8HpEgmPJwHJzxKJx1
  SOLANA_DEPLOYER_KEYPAIR=[...secret key bytes JSON array...]
  SUPABASE_SERVICE_ROLE_KEY=[...from Supabase dashboard...]
  CRON_SECRET=[...generate new for production...]
  ```

#### 1.3 Fix Vercel Cron Config
- **File:** `packages/nextjs/vercel.json`
- **Issue:** Old cron paths still present (`/api/matchmaker/run`, `/api/cron/process-matches`) — these are legacy 1v1 routes
- **Action:** Keep only `/api/rumble/tick` cron. Remove old ones.

#### 1.4 Verify Build Passes on Vercel
- **Issue:** 419 TS errors in legacy code (old match/wager routes). Build may fail if strict.
- **Options:**
  - A) Delete legacy routes (clean but risky — they're the old 1v1 system)
  - B) Add `// @ts-nocheck` to legacy files (quick fix)
  - C) Move legacy routes to a `_legacy/` folder outside the build
- **Recommendation:** Option A — the old 1v1 system is fully replaced by Rumble

#### 1.5 Test Live on clawfights.xyz
- Deploy, hit `/rumble`, verify:
  - Status API returns 3 slots
  - Queue API accepts fighters
  - Tick cron fires every minute
  - Matches actually run through full lifecycle
  - PayoutDisplay shows results

---

### Phase 2: Pump.fun Token Launch (Days 2-3)

#### 2.1 Create $ICHOR on pump.fun
- Go to pump.fun → create token
- Set: name "ICHOR", ticker "$ICHOR", description, image (black oil aesthetic)
- Retain enough supply for the distribution vault
- Record the **mint address**

#### 2.2 Initialize On-Chain with Pump.fun Mint
- Call `initializeWithMint(pumpMintAddress, seasonReward)` using deployer keypair
- This points the ichor_token program at the pump.fun mint instead of our custom one
- Transfer reward tokens to the distribution vault PDA

#### 2.3 Update Environment
- Change `NEXT_PUBLIC_ICHOR_TOKEN_MINT` to the pump.fun mint address
- Redeploy to Vercel

#### 2.4 No Rust Changes Needed
- `initializeWithMint()` already exists in ichor_token program
- `distributeReward()` uses `transfer` from vault (not `mint`)
- `adminDistribute()` handles LP seeding, airdrops

---

### Phase 3: Testing & Polish (Days 3-4)

#### 3.1 Run Full E2E with Real Bots
- Use sample-bot (`packages/sample-bot/bot.js`) to queue fighters
- Watch full Rumble lifecycle on the spectator page
- Verify SOL payouts arrive on-chain
- Verify ICHOR distribution

#### 3.2 Fix SSE Named Events (Nice-to-Have)
- **Issue:** `/api/rumble/live` sends named events (`event: turn_resolved\n`) but `page.tsx` uses `EventSource.onmessage` which only catches unnamed events
- **Fix:** Use `addEventListener("turn_resolved", ...)` per event type
- **Impact:** Low — 2s polling fallback works fine

#### 3.3 Landing Page Update
- Update `app/page.tsx` (homepage) to link to `/rumble`
- Add ICHOR branding, explain the system
- Show live stats (active rumbles, total ICHOR mined)

#### 3.4 Update skill.md for Bots
- Verify all 8 Rumble API endpoints are documented
- Test that a fresh bot can register + queue + bet using only skill.md

---

### Phase 4: Hackathon Submission (Days 5-6, before Feb 18)

#### 4.1 Record Demo Video
- Show: fighter registration → queue → betting → live combat → payout → ICHOR on-chain
- Highlight: AI fighters, winner-takes-all, pump.fun token, Solana on-chain verification

#### 4.2 Write Submission Post
- "Build in Public" format — show the architecture, code, journey
- Link to: live site, GitHub, $ICHOR on pump.fun, technical docs

#### 4.3 Clean Up for Public Repo
- Remove any hardcoded secrets (none found, but double-check)
- Make sure `.env.local` is in `.gitignore`
- Add README.md with setup instructions

---

### Phase 5: Post-Launch (After Feb 18)

#### 5.1 Legacy Code Cleanup
- Delete old 1v1 system routes (match/*, wager/*, old cron routes)
- Remove `battle-image.ts`, `contracts.ts`, `moltbook.ts` (legacy)
- This eliminates all 419 TS errors

#### 5.2 Mainnet Preparation
- Switch from devnet → mainnet-beta
- Redeploy Solana programs to mainnet
- Real SOL betting, real ICHOR distribution

#### 5.3 ICHOR Staking & Whale Perks
- Implement staking tiers (Shark/Orca/Whale/Leviathan)
- Reduced rake for stakers
- Early betting access

#### 5.4 Decentralization
- Move combat execution on-chain (currently off-chain)
- Verifiable randomness (VRF) for pairings
- Fighter NFTs

---

## Known Issues to Track

| Issue | Severity | Notes |
|-------|----------|-------|
| 419 TS errors in legacy code | Medium | All in old 1v1 routes, delete them |
| SSE named events not caught by onmessage | Low | 2s polling works fine |
| Old cron paths in vercel.json | Medium | Remove before deploy |
| On-chain amount mismatch in orchestrator | Medium | Known bug, needs ICHOR decimal alignment |
| GitHub Actions deploy broken | Low | Using Vercel Git integration instead |
| Bettor ICHOR on-chain distribution | Medium | Currently off-chain only, needs claim mechanism |
