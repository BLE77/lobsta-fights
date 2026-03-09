# Claw Fights Architecture

This is the simplest accurate description of how the app works today.

## One-Line Summary

Claw Fights uses:

- `Mainnet` for real betting and claiming
- `MagicBlock ER` on `devnet` for fast combat execution
- `MagicBlock VRF` for fair matchup seeding and the Ichor Shower lottery
- `Railway` as the game worker
- `Vercel` as the website and public API
- `Supabase` as the app database and public status mirror

It is a `hybrid` system, not a single-chain-only system.

## Simple Diagram

```text
Player Wallet
    |
    v
Vercel Website + API
    |
    +------------------------------+
    |                              |
    v                              v
Mainnet Betting Program        Railway Worker
(real bets / real claims)      (runs rumbles / bots / orchestration)
    |                              |
    |                              +--------------------------+
    |                                                         |
    v                                                         v
Bets + Claims on Mainnet                              Devnet Rumble Program
                                                      + MagicBlock ER Combat
                                                      + MagicBlock VRF
                                                         |
                                                         v
                                                Supabase Status / History
                                                         |
                                                         v
                                                   Vercel UI reads it
```

## What Runs Where

### 1. Mainnet Betting

This is where the real money side happens.

- user bet transactions are built against the `mainnet` rumble program
- user wallet signs the bet
- the signed transaction is submitted through the app
- claim transactions are also built and submitted on `mainnet`

Use this mental model:

- `money side = mainnet`

## 2. Devnet Combat

This is where the actual fight simulation happens.

- Railway starts a rumble
- Railway starts combat
- the `combat_state` PDA is delegated to `MagicBlock ER`
- turn resolution happens on the combat/devnet side

Use this mental model:

- `fight side = devnet + ER`

## 3. MagicBlock ER

`ER` is used for the fast combat state, not for betting.

- combat state is delegated into MagicBlock ER
- combat transactions run there for faster execution
- the app is pinned to the US validator for ER

Use this mental model:

- `ER = fast arena`
- `ER is not where bets live`

## 4. MagicBlock VRF

There are two VRF uses.

### Matchup VRF

- before turn 1, the worker requests `requestMatchupSeed`
- combat does not continue until the VRF seed is present
- that seed drives pairing order / matchup randomness

Use this mental model:

- `who fights who = VRF`

### Ichor Shower VRF

- after combat/payout flow, the worker requests `requestIchorShowerVrf`
- that decides the random shower / lottery event

Use this mental model:

- `lottery / shower trigger = VRF`

## 5. Railway

Railway is the game brain.

- runs the rumble worker
- manages house bots
- opens betting / starts combat
- requests VRF
- watches on-chain state
- finalizes rumbles
- pushes status into Supabase

Use this mental model:

- `Railway = game operator`

## 6. Vercel

Vercel is the frontend and public API layer.

- serves `clawfights.xyz`
- prepares wallet transactions
- submits signed wallet transactions through server routes
- serves rumble status, history, and UI data

Use this mental model:

- `Vercel = website + public API`

## 7. Supabase

Supabase is the app database and status mirror.

- stores rumble rows
- stores turn logs
- stores payout results
- stores queue / bot / UI support data

Important:

- Supabase is not the source of truth for real bets
- Supabase is mainly the app state mirror and persistence layer

Use this mental model:

- `Supabase = app memory + public mirror`

## End-to-End Flow

### Betting Flow

```text
User opens /rumble
-> Vercel shows active betting slot
-> Vercel prepares mainnet bet tx
-> wallet signs
-> Vercel submits signed tx
-> mainnet program records the bet
```

### Combat Flow

```text
Betting closes
-> Railway starts combat on devnet
-> Railway delegates combat state to MagicBlock ER
-> Railway requests matchup VRF
-> turn 1 only opens after VRF seed exists
-> turns resolve on ER/devnet
```

### Payout / Shower Flow

```text
Fight ends
-> Railway finalizes result
-> Railway requests Ichor Shower VRF
-> payout / reward flow completes
-> Supabase stores result
-> Vercel shows winner / final turn / payout state
```

## What Is On-Chain vs Off-Chain

### On-Chain

- mainnet bets
- mainnet claims
- devnet rumble/combat state
- MagicBlock ER combat execution
- VRF matchup seed
- VRF Ichor Shower result

### Off-Chain

- worker scheduling
- bot orchestration
- UI polling and rendering
- status mirroring in Supabase
- commentary/audio generation

## The Simple Truth

If someone asks, "What is the architecture?" the short answer is:

```text
Real money on mainnet.
Fast combat on MagicBlock ER.
Randomness from MagicBlock VRF.
Railway runs the game.
Vercel serves the app.
Supabase mirrors status for the UI.
```

## Important Caveat

This is not yet a pure single-chain production design because:

- betting is on `mainnet`
- combat is on `devnet`
- orchestration is still off-chain

So the correct statement is:

```text
The game uses on-chain betting, on-chain ER combat, and on-chain VRF,
but the full product is still a hybrid web app with off-chain orchestration.
```
