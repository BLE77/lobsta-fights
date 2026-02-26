use anchor_lang::prelude::*;
use anchor_lang::system_program;
#[cfg(feature = "combat")]
use sha2::{Digest, Sha256};

declare_id!("2TvW4EfbmMe566ZQWZWd8kX34iFR2DM3oBUpjwpRJcqC");

/// Maximum fighters per rumble
const MAX_FIGHTERS: usize = 16;

/// PDA seeds
const RUMBLE_SEED: &[u8] = b"rumble";
const VAULT_SEED: &[u8] = b"vault";
const BETTOR_SEED: &[u8] = b"bettor";
const CONFIG_SEED: &[u8] = b"rumble_config";
const SPONSORSHIP_SEED: &[u8] = b"sponsorship";
#[cfg(feature = "combat")]
const MOVE_COMMIT_SEED: &[u8] = b"move_commit";
#[cfg(feature = "combat")]
const MOVE_COMMIT_DOMAIN: &[u8] = b"rumble:v1";
#[cfg(feature = "combat")]
const COMBAT_STATE_SEED: &[u8] = b"combat_state";
const PENDING_ADMIN_SEED: &[u8] = b"pending_admin_re";
const FIGHTER_REGISTRY_PROGRAM_ID: Pubkey = pubkey!("2hA6Jvj1yjP2Uj3qrJcsBeYA2R9xPM95mDKw1ncKVExa");
const FIGHTER_ACCOUNT_DISCRIMINATOR: [u8; 8] = [24, 221, 27, 113, 60, 210, 101, 211];

/// Fee basis points (out of 10_000)
const ADMIN_FEE_BPS: u64 = 100; // 1%
const SPONSORSHIP_FEE_BPS: u64 = 500; // 5%

/// Winner-takes-all: 100% of losers' pool (after treasury cut) goes to 1st place bettors
const FIRST_PLACE_BPS: u64 = 10_000; // 100%
const SECOND_PLACE_BPS: u64 = 0; // 0% — winner-takes-all
const THIRD_PLACE_BPS: u64 = 0; // 0% — winner-takes-all

/// Treasury cut from losers' pool before payout distribution
const TREASURY_CUT_BPS: u64 = 1_000; // 10%

/// Claim window after report_result before admin can finalize/sweep (24 hours).
const PAYOUT_CLAIM_WINDOW_SECONDS: i64 = 86_400;

/// On-chain turn timing windows (slots).
#[cfg(feature = "combat")]
const COMMIT_WINDOW_SLOTS: u64 = 30;
#[cfg(feature = "combat")]
const REVEAL_WINDOW_SLOTS: u64 = 30;
#[cfg(feature = "combat")]
const MAX_ONCHAIN_COMBAT_TURNS: u32 = 120;
#[cfg(feature = "combat")]
const COMBAT_TIMEOUT_SLOTS: u64 = 5000; // ~33 minutes; prevents stuck rumbles

#[cfg(feature = "combat")]
const MOVE_HIGH_STRIKE: u8 = 0;
#[cfg(feature = "combat")]
const MOVE_MID_STRIKE: u8 = 1;
#[cfg(feature = "combat")]
const MOVE_LOW_STRIKE: u8 = 2;
#[cfg(feature = "combat")]
const MOVE_GUARD_HIGH: u8 = 3;
#[cfg(feature = "combat")]
const MOVE_GUARD_MID: u8 = 4;
#[cfg(feature = "combat")]
const MOVE_GUARD_LOW: u8 = 5;
#[cfg(feature = "combat")]
const MOVE_DODGE: u8 = 6;
#[cfg(feature = "combat")]
const MOVE_CATCH: u8 = 7;
#[cfg(feature = "combat")]
const MOVE_SPECIAL: u8 = 8;

#[cfg(feature = "combat")]
const STRIKE_DAMAGE_HIGH: u16 = 26;
#[cfg(feature = "combat")]
const STRIKE_DAMAGE_MID: u16 = 20;
#[cfg(feature = "combat")]
const STRIKE_DAMAGE_LOW: u16 = 15;
#[cfg(feature = "combat")]
const CATCH_DAMAGE: u16 = 30;
#[cfg(feature = "combat")]
const COUNTER_DAMAGE: u16 = 12;
#[cfg(feature = "combat")]
const SPECIAL_DAMAGE: u16 = 35;
#[cfg(feature = "combat")]
const METER_PER_TURN: u8 = 20;
#[cfg(feature = "combat")]
const SPECIAL_METER_COST: u8 = 100;
#[cfg(feature = "combat")]
const START_HP: u16 = 100;

struct ParsedBettorAccount {
    authority: Pubkey,
    rumble_id: u64,
    fighter_index: u8,
    sol_deployed: u64,
    claimable_lamports: u64,
    total_claimed_lamports: u64,
    last_claim_ts: i64,
    claimed: bool,
    bump: u8,
    fighter_deployments: [u64; MAX_FIGHTERS],
}

fn read_u64_le(data: &[u8], offset: &mut usize) -> Result<u64> {
    let end = offset
        .checked_add(8)
        .ok_or(RumbleError::InvalidBettorAccount)?;
    let bytes: [u8; 8] = data
        .get(*offset..end)
        .ok_or(RumbleError::InvalidBettorAccount)?
        .try_into()
        .map_err(|_| error!(RumbleError::InvalidBettorAccount))?;
    *offset = end;
    Ok(u64::from_le_bytes(bytes))
}

fn read_i64_le(data: &[u8], offset: &mut usize) -> Result<i64> {
    let end = offset
        .checked_add(8)
        .ok_or(RumbleError::InvalidBettorAccount)?;
    let bytes: [u8; 8] = data
        .get(*offset..end)
        .ok_or(RumbleError::InvalidBettorAccount)?
        .try_into()
        .map_err(|_| error!(RumbleError::InvalidBettorAccount))?;
    *offset = end;
    Ok(i64::from_le_bytes(bytes))
}

fn write_u64_le(data: &mut [u8], offset: &mut usize, value: u64) -> Result<()> {
    let end = offset
        .checked_add(8)
        .ok_or(RumbleError::InvalidBettorAccount)?;
    let slice = data
        .get_mut(*offset..end)
        .ok_or(RumbleError::InvalidBettorAccount)?;
    slice.copy_from_slice(&value.to_le_bytes());
    *offset = end;
    Ok(())
}

fn write_i64_le(data: &mut [u8], offset: &mut usize, value: i64) -> Result<()> {
    let end = offset
        .checked_add(8)
        .ok_or(RumbleError::InvalidBettorAccount)?;
    let slice = data
        .get_mut(*offset..end)
        .ok_or(RumbleError::InvalidBettorAccount)?;
    slice.copy_from_slice(&value.to_le_bytes());
    *offset = end;
    Ok(())
}

fn parse_bettor_account_data(data: &[u8]) -> Result<ParsedBettorAccount> {
    // Legacy V2 minimum: discriminator + authority + rumble_id + fighter_index + sol_deployed
    // + claimable + total_claimed + last_claim_ts + claimed + bump
    const LEGACY_V2_LEN: usize = 8 + 32 + 8 + 1 + 8 + 8 + 8 + 8 + 1 + 1; // 83
    const CURRENT_LEN: usize = 8 + BettorAccount::INIT_SPACE; // 211

    require!(
        data.len() >= LEGACY_V2_LEN,
        RumbleError::InvalidBettorAccount
    );
    require!(
        &data[..8] == BettorAccount::DISCRIMINATOR,
        RumbleError::InvalidBettorAccount
    );

    let mut offset = 8usize;
    let authority_bytes: [u8; 32] = data[offset..offset + 32]
        .try_into()
        .map_err(|_| error!(RumbleError::InvalidBettorAccount))?;
    let authority = Pubkey::new_from_array(authority_bytes);
    offset += 32;

    let rumble_id = read_u64_le(data, &mut offset)?;
    let fighter_index = *data.get(offset).ok_or(RumbleError::InvalidBettorAccount)?;
    offset += 1;
    let sol_deployed = read_u64_le(data, &mut offset)?;

    let claimable_lamports = read_u64_le(data, &mut offset)?;
    let total_claimed_lamports = read_u64_le(data, &mut offset)?;
    let last_claim_ts = read_i64_le(data, &mut offset)?;
    let claimed = *data.get(offset).ok_or(RumbleError::InvalidBettorAccount)? == 1;
    offset += 1;
    let bump = *data.get(offset).ok_or(RumbleError::InvalidBettorAccount)?;
    offset += 1;

    let mut fighter_deployments = [0u64; MAX_FIGHTERS];
    if data.len() >= CURRENT_LEN {
        for i in 0..MAX_FIGHTERS {
            fighter_deployments[i] = read_u64_le(data, &mut offset)?;
        }
    } else {
        if (fighter_index as usize) < MAX_FIGHTERS {
            fighter_deployments[fighter_index as usize] = sol_deployed;
        }
    }

    Ok(ParsedBettorAccount {
        authority,
        rumble_id,
        fighter_index,
        sol_deployed,
        claimable_lamports,
        total_claimed_lamports,
        last_claim_ts,
        claimed,
        bump,
        fighter_deployments,
    })
}

fn write_bettor_account_data(data: &mut [u8], bettor: &ParsedBettorAccount) -> Result<()> {
    // Legacy V2 minimum: discriminator + authority + rumble_id + fighter_index + sol_deployed
    // + claimable + total_claimed + last_claim_ts + claimed + bump
    const LEGACY_V2_LEN: usize = 8 + 32 + 8 + 1 + 8 + 8 + 8 + 8 + 1 + 1; // 83
    const CURRENT_LEN: usize = 8 + BettorAccount::INIT_SPACE; // 211

    require!(
        data.len() >= LEGACY_V2_LEN,
        RumbleError::InvalidBettorAccount
    );
    require!(
        &data[..8] == BettorAccount::DISCRIMINATOR,
        RumbleError::InvalidBettorAccount
    );

    let mut offset = 8usize;
    data[offset..offset + 32].copy_from_slice(bettor.authority.as_ref());
    offset += 32;
    write_u64_le(data, &mut offset, bettor.rumble_id)?;
    data[offset] = bettor.fighter_index;
    offset += 1;
    write_u64_le(data, &mut offset, bettor.sol_deployed)?;

    write_u64_le(data, &mut offset, bettor.claimable_lamports)?;
    write_u64_le(data, &mut offset, bettor.total_claimed_lamports)?;
    write_i64_le(data, &mut offset, bettor.last_claim_ts)?;
    data[offset] = if bettor.claimed { 1 } else { 0 };
    offset += 1;
    data[offset] = bettor.bump;
    offset += 1;

    if data.len() >= CURRENT_LEN {
        for value in bettor.fighter_deployments {
            write_u64_le(data, &mut offset, value)?;
        }
    }

    Ok(())
}

#[cfg(feature = "combat")]
fn fighter_in_rumble(rumble: &Rumble, fighter: &Pubkey) -> Option<usize> {
    let fighter_count = rumble.fighter_count as usize;
    rumble.fighters[..fighter_count]
        .iter()
        .position(|f| f == fighter)
}

#[cfg(feature = "combat")]
fn is_valid_move_code(move_code: u8) -> bool {
    move_code <= 8
}

#[cfg(feature = "combat")]
fn compute_move_commitment_hash(
    rumble_id: u64,
    turn: u32,
    fighter: &Pubkey,
    move_code: u8,
    salt: &[u8; 32],
) -> [u8; 32] {
    let rumble_id_bytes = rumble_id.to_le_bytes();
    let turn_bytes = turn.to_le_bytes();
    let move_code_bytes = [move_code];
    let mut hasher = Sha256::new();
    hasher.update(MOVE_COMMIT_DOMAIN);
    hasher.update(rumble_id_bytes.as_ref());
    hasher.update(turn_bytes.as_ref());
    hasher.update(fighter.as_ref());
    hasher.update(move_code_bytes.as_ref());
    hasher.update(salt.as_ref());
    let digest = hasher.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    out
}

#[cfg(feature = "combat")]
fn hash_u64(parts: &[&[u8]]) -> u64 {
    let mut hasher = Sha256::new();
    for p in parts {
        hasher.update(p);
    }
    let digest = hasher.finalize();
    let mut bytes = [0u8; 8];
    bytes.copy_from_slice(&digest[..8]);
    u64::from_le_bytes(bytes)
}

#[cfg(feature = "combat")]
fn is_strike(move_code: u8) -> bool {
    move_code == MOVE_HIGH_STRIKE || move_code == MOVE_MID_STRIKE || move_code == MOVE_LOW_STRIKE
}

#[cfg(feature = "combat")]
fn is_guard(move_code: u8) -> bool {
    move_code == MOVE_GUARD_HIGH || move_code == MOVE_GUARD_MID || move_code == MOVE_GUARD_LOW
}

#[cfg(feature = "combat")]
fn guard_for_strike(move_code: u8) -> Option<u8> {
    match move_code {
        MOVE_HIGH_STRIKE => Some(MOVE_GUARD_HIGH),
        MOVE_MID_STRIKE => Some(MOVE_GUARD_MID),
        MOVE_LOW_STRIKE => Some(MOVE_GUARD_LOW),
        _ => None,
    }
}

#[cfg(feature = "combat")]
fn strike_damage(move_code: u8) -> u16 {
    match move_code {
        MOVE_HIGH_STRIKE => STRIKE_DAMAGE_HIGH,
        MOVE_MID_STRIKE => STRIKE_DAMAGE_MID,
        MOVE_LOW_STRIKE => STRIKE_DAMAGE_LOW,
        _ => 0,
    }
}

#[cfg(feature = "combat")]
fn fallback_move_code(rumble_id: u64, turn: u32, fighter: &Pubkey, meter: u8) -> u8 {
    let rumble_id_bytes = rumble_id.to_le_bytes();
    let turn_bytes = turn.to_le_bytes();
    let roll = hash_u64(&[
        b"fallback-move",
        rumble_id_bytes.as_ref(),
        turn_bytes.as_ref(),
        fighter.as_ref(),
    ]) % 100;

    if meter >= SPECIAL_METER_COST && roll < 15 {
        return MOVE_SPECIAL;
    }

    if roll < 67 {
        let strike_idx = hash_u64(&[
            b"fallback-strike",
            rumble_id_bytes.as_ref(),
            turn_bytes.as_ref(),
            fighter.as_ref(),
        ]) % 3;
        match strike_idx {
            0 => MOVE_HIGH_STRIKE,
            1 => MOVE_MID_STRIKE,
            _ => MOVE_LOW_STRIKE,
        }
    } else if roll < 87 {
        let guard_idx = hash_u64(&[
            b"fallback-guard",
            rumble_id_bytes.as_ref(),
            turn_bytes.as_ref(),
            fighter.as_ref(),
        ]) % 3;
        match guard_idx {
            0 => MOVE_GUARD_HIGH,
            1 => MOVE_GUARD_MID,
            _ => MOVE_GUARD_LOW,
        }
    } else if roll < 95 {
        MOVE_DODGE
    } else {
        MOVE_CATCH
    }
}

#[cfg(feature = "combat")]
fn resolve_duel(
    move_a: u8,
    move_b: u8,
    meter_a: u8,
    meter_b: u8,
) -> (u16, u16, u8, u8) {
    let mut damage_to_a: u16 = 0;
    let mut damage_to_b: u16 = 0;
    let mut meter_used_a: u8 = 0;
    let mut meter_used_b: u8 = 0;

    let a_special = move_a == MOVE_SPECIAL && meter_a >= SPECIAL_METER_COST;
    let b_special = move_b == MOVE_SPECIAL && meter_b >= SPECIAL_METER_COST;
    if a_special {
        meter_used_a = SPECIAL_METER_COST;
    }
    if b_special {
        meter_used_b = SPECIAL_METER_COST;
    }

    let effective_a = if move_a == MOVE_SPECIAL && !a_special {
        u8::MAX
    } else {
        move_a
    };
    let effective_b = if move_b == MOVE_SPECIAL && !b_special {
        u8::MAX
    } else {
        move_b
    };

    // A attacks B
    if effective_a == MOVE_SPECIAL {
        if effective_b != MOVE_DODGE {
            damage_to_b = SPECIAL_DAMAGE;
        }
    } else if effective_a == MOVE_CATCH {
        if effective_b == MOVE_DODGE {
            damage_to_b = CATCH_DAMAGE;
        }
    } else if is_strike(effective_a) {
        if effective_b == MOVE_DODGE {
            // dodged
        } else if guard_for_strike(effective_a) == Some(effective_b) {
            damage_to_a = COUNTER_DAMAGE;
        } else {
            damage_to_b = strike_damage(effective_a);
        }
    }

    // B attacks A
    if effective_b == MOVE_SPECIAL {
        if effective_a != MOVE_DODGE {
            damage_to_a = SPECIAL_DAMAGE;
        }
    } else if effective_b == MOVE_CATCH {
        if effective_a == MOVE_DODGE {
            damage_to_a = CATCH_DAMAGE;
        }
    } else if is_strike(effective_b) {
        if effective_a == MOVE_DODGE {
            // dodged
        } else if guard_for_strike(effective_b) == Some(effective_a) {
            damage_to_b = COUNTER_DAMAGE;
        } else {
            damage_to_a = strike_damage(effective_b);
        }
    }

    (damage_to_a, damage_to_b, meter_used_a, meter_used_b)
}

#[cfg(feature = "combat")]
fn expected_move_commitment_pda(rumble_id: u64, fighter: &Pubkey, turn: u32) -> Pubkey {
    let rumble_id_bytes = rumble_id.to_le_bytes();
    let turn_bytes = turn.to_le_bytes();
    let (pda, _bump) = Pubkey::find_program_address(
        &[
            MOVE_COMMIT_SEED,
            rumble_id_bytes.as_ref(),
            fighter.as_ref(),
            turn_bytes.as_ref(),
        ],
        &crate::ID,
    );
    pda
}

#[cfg(feature = "combat")]
fn read_revealed_move_from_remaining_accounts(
    remaining_accounts: &[AccountInfo<'_>],
    rumble_id: u64,
    turn: u32,
    fighter: &Pubkey,
) -> Option<u8> {
    let expected_pda = expected_move_commitment_pda(rumble_id, fighter, turn);
    let info = remaining_accounts.iter().find(|acc| *acc.key == expected_pda)?;
    if *info.owner != crate::ID || info.data_is_empty() {
        return None;
    }

    let data = info.try_borrow_data().ok()?;
    if data.len() < 8 || data.get(..8) != Some(MoveCommitment::DISCRIMINATOR.as_ref()) {
        return None;
    }
    let mut slice: &[u8] = &data;
    let parsed = MoveCommitment::try_deserialize(&mut slice).ok()?;
    if parsed.rumble_id != rumble_id || parsed.turn != turn || parsed.fighter != *fighter {
        return None;
    }
    if !parsed.revealed {
        return None;
    }
    Some(parsed.revealed_move)
}

#[cfg(feature = "combat")]
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct DuelResult {
    pub fighter_a_idx: u8,
    pub fighter_b_idx: u8,
    pub move_a: u8,
    pub move_b: u8,
    pub damage_to_a: u16,
    pub damage_to_b: u16,
}

#[program]
pub mod rumble_engine {
    use super::*;

    /// Initialize the rumble engine configuration.
    /// Sets the admin key and treasury address.
    pub fn initialize(ctx: Context<InitializeConfig>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.treasury = ctx.accounts.treasury.key();
        config.total_rumbles = 0;
        config.bump = ctx.bumps.config;

        msg!("Rumble engine initialized. Admin: {}", config.admin);
        Ok(())
    }

    /// Create a new rumble with a list of fighters and an on-chain betting close slot.
    /// `betting_deadline` is interpreted as a slot number for backward compatibility.
    pub fn create_rumble(
        ctx: Context<CreateRumble>,
        rumble_id: u64,
        fighters: Vec<Pubkey>,
        betting_deadline: i64,
    ) -> Result<()> {
        require!(
            fighters.len() >= 2 && fighters.len() <= MAX_FIGHTERS,
            RumbleError::InvalidFighterCount
        );

        // Check for duplicate fighters
        let mut seen = std::collections::BTreeSet::new();
        for f in fighters.iter() {
            require!(seen.insert(f), RumbleError::DuplicateFighter);
        }

        // NOTE: Fighter registry validation removed — fighters are registered
        // in Supabase, not all have on-chain fighter_registry PDAs yet.
        // TODO: Re-add once all fighters are registered on-chain.

        let clock = Clock::get()?;
        require!(betting_deadline > 0, RumbleError::DeadlineInPast);
        let betting_close_slot =
            u64::try_from(betting_deadline).map_err(|_| error!(RumbleError::DeadlineInPast))?;
        require!(betting_close_slot > clock.slot, RumbleError::DeadlineInPast);

        let rumble = &mut ctx.accounts.rumble;
        rumble.id = rumble_id;
        rumble.state = RumbleState::Betting;

        // Copy fighters into fixed-size array
        let mut fighter_arr = [Pubkey::default(); MAX_FIGHTERS];
        for (i, f) in fighters.iter().enumerate() {
            fighter_arr[i] = *f;
        }
        rumble.fighters = fighter_arr;
        rumble.fighter_count = fighters.len() as u8;

        rumble.betting_pools = [0u64; MAX_FIGHTERS];
        rumble.total_deployed = 0;
        rumble.admin_fee_collected = 0;
        rumble.sponsorship_paid = 0;
        rumble.placements = [0u8; MAX_FIGHTERS];
        rumble.winner_index = 0;
        rumble.betting_deadline = betting_deadline;
        rumble.combat_started_at = 0;
        rumble.completed_at = 0;
        rumble.bump = ctx.bumps.rumble;

        msg!(
            "Rumble {} created with {} fighters",
            rumble_id,
            fighters.len()
        );
        Ok(())
    }

    /// Place a bet on a fighter in a rumble.
    /// Transfers SOL from bettor to vault, deducting admin fee and sponsorship.
    pub fn place_bet(
        ctx: Context<PlaceBet>,
        rumble_id: u64,
        fighter_index: u8,
        amount: u64,
    ) -> Result<()> {
        let rumble = &mut ctx.accounts.rumble;

        // Validate state
        require!(
            rumble.state == RumbleState::Betting,
            RumbleError::BettingClosed
        );

        // Validate on-chain slot deadline
        let clock = Clock::get()?;
        let betting_close_slot = u64::try_from(rumble.betting_deadline)
            .map_err(|_| error!(RumbleError::BettingClosed))?;
        require!(clock.slot < betting_close_slot, RumbleError::BettingClosed);

        // Validate fighter index
        require!(
            (fighter_index as usize) < rumble.fighter_count as usize,
            RumbleError::InvalidFighterIndex
        );

        // Validate amount
        require!(amount > 0, RumbleError::ZeroBetAmount);

        // Calculate fees
        let admin_fee = amount
            .checked_mul(ADMIN_FEE_BPS)
            .ok_or(RumbleError::MathOverflow)?
            .checked_div(10_000)
            .ok_or(RumbleError::MathOverflow)?;

        let sponsorship_fee = amount
            .checked_mul(SPONSORSHIP_FEE_BPS)
            .ok_or(RumbleError::MathOverflow)?
            .checked_div(10_000)
            .ok_or(RumbleError::MathOverflow)?;

        let net_bet = amount
            .checked_sub(admin_fee)
            .ok_or(RumbleError::MathOverflow)?
            .checked_sub(sponsorship_fee)
            .ok_or(RumbleError::MathOverflow)?;

        // Transfer admin fee to treasury
        if admin_fee > 0 {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.bettor.to_account_info(),
                        to: ctx.accounts.treasury.to_account_info(),
                    },
                ),
                admin_fee,
            )?;
        }

        // Transfer sponsorship fee to fighter owner's sponsorship account
        if sponsorship_fee > 0 {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.bettor.to_account_info(),
                        to: ctx.accounts.sponsorship_account.to_account_info(),
                    },
                ),
                sponsorship_fee,
            )?;
        }

        // Transfer net bet to vault PDA
        if net_bet > 0 {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.bettor.to_account_info(),
                        to: ctx.accounts.vault.to_account_info(),
                    },
                ),
                net_bet,
            )?;
        }

        // Update rumble state
        rumble.betting_pools[fighter_index as usize] = rumble.betting_pools[fighter_index as usize]
            .checked_add(net_bet)
            .ok_or(RumbleError::MathOverflow)?;
        rumble.total_deployed = rumble
            .total_deployed
            .checked_add(net_bet)
            .ok_or(RumbleError::MathOverflow)?;
        rumble.admin_fee_collected = rumble
            .admin_fee_collected
            .checked_add(admin_fee)
            .ok_or(RumbleError::MathOverflow)?;
        rumble.sponsorship_paid = rumble
            .sponsorship_paid
            .checked_add(sponsorship_fee)
            .ok_or(RumbleError::MathOverflow)?;

        // Initialize or accumulate bettor account
        let bettor_account = &mut ctx.accounts.bettor_account;
        if bettor_account.authority == Pubkey::default() {
            // First bet: initialize the account
            bettor_account.authority = ctx.accounts.bettor.key();
            bettor_account.rumble_id = rumble_id;
            bettor_account.fighter_index = fighter_index;
            bettor_account.sol_deployed = net_bet;
            let mut deployments = [0u64; MAX_FIGHTERS];
            deployments[fighter_index as usize] = net_bet;
            bettor_account.fighter_deployments = deployments;
            bettor_account.claimable_lamports = 0;
            bettor_account.total_claimed_lamports = 0;
            bettor_account.last_claim_ts = 0;
            bettor_account.claimed = false;
            bettor_account.bump = ctx.bumps.bettor_account;
        } else {
            require!(
                bettor_account.authority == ctx.accounts.bettor.key(),
                RumbleError::Unauthorized
            );

            // Legacy migration path:
            // Older bettor accounts tracked only a single fighter_index + sol_deployed.
            // If fighter_deployments is empty but sol_deployed exists, backfill once.
            if bettor_account.fighter_deployments.iter().all(|x| *x == 0)
                && bettor_account.sol_deployed > 0
            {
                let legacy_idx = bettor_account.fighter_index as usize;
                if legacy_idx < MAX_FIGHTERS {
                    bettor_account.fighter_deployments[legacy_idx] = bettor_account.sol_deployed;
                }
            }

            // Additional bet on any fighter: accumulate per-fighter and total deployed.
            bettor_account.fighter_deployments[fighter_index as usize] = bettor_account
                .fighter_deployments[fighter_index as usize]
                .checked_add(net_bet)
                .ok_or(RumbleError::MathOverflow)?;
            bettor_account.sol_deployed = bettor_account
                .sol_deployed
                .checked_add(net_bet)
                .ok_or(RumbleError::MathOverflow)?;
        }

        msg!(
            "Bet placed: {} lamports on fighter #{} in rumble {}. Net: {}, fee: {}, sponsor: {}",
            amount,
            fighter_index,
            rumble_id,
            net_bet,
            admin_fee,
            sponsorship_fee
        );

        emit!(BetPlacedEvent {
            rumble_id,
            bettor: ctx.accounts.bettor.key(),
            fighter_index,
            amount,
            net_amount: net_bet,
        });

        Ok(())
    }

    /// Transition rumble from Betting to Combat and initialize on-chain combat state.
    /// Callable by admin after betting deadline.
    #[cfg(feature = "combat")]
    pub fn start_combat(ctx: Context<StartCombat>) -> Result<()> {
        let rumble = &mut ctx.accounts.rumble;

        require!(
            rumble.state == RumbleState::Betting,
            RumbleError::InvalidStateTransition
        );

        let clock = Clock::get()?;
        let betting_close_slot = u64::try_from(rumble.betting_deadline)
            .map_err(|_| error!(RumbleError::BettingNotEnded))?;
        require!(
            clock.slot >= betting_close_slot,
            RumbleError::BettingNotEnded
        );

        rumble.state = RumbleState::Combat;
        rumble.combat_started_at = clock.unix_timestamp;

        let combat = &mut ctx.accounts.combat_state;
        if combat.rumble_id != 0 {
            require!(combat.rumble_id == rumble.id, RumbleError::InvalidRumble);
        }
        combat.rumble_id = rumble.id;
        combat.fighter_count = rumble.fighter_count;
        combat.current_turn = 0;
        combat.turn_open_slot = clock.slot;
        combat.commit_close_slot = clock.slot;
        combat.reveal_close_slot = clock.slot;
        combat.turn_resolved = true;
        combat.remaining_fighters = rumble.fighter_count;
        combat.winner_index = u8::MAX;
        combat.hp = [0u16; MAX_FIGHTERS];
        combat.meter = [0u8; MAX_FIGHTERS];
        combat.elimination_rank = [0u8; MAX_FIGHTERS];
        combat.total_damage_dealt = [0u64; MAX_FIGHTERS];
        combat.total_damage_taken = [0u64; MAX_FIGHTERS];
        for i in 0..rumble.fighter_count as usize {
            combat.hp[i] = START_HP;
        }
        combat.bump = ctx.bumps.combat_state;

        msg!(
            "Rumble {} combat started at {}",
            rumble.id,
            clock.unix_timestamp
        );

        emit!(CombatStartedEvent {
            rumble_id: rumble.id,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Fighter commits a move hash for the active rumble turn.
    /// Hash format: sha256("rumble:v1", rumble_id, turn, fighter_pubkey, move_code, salt)
    #[cfg(feature = "combat")]
    pub fn commit_move(
        ctx: Context<CommitMove>,
        rumble_id: u64,
        turn: u32,
        move_hash: [u8; 32],
    ) -> Result<()> {
        let clock = Clock::get()?;
        let rumble = &ctx.accounts.rumble;
        let combat = &ctx.accounts.combat_state;

        require!(
            rumble.state == RumbleState::Combat,
            RumbleError::InvalidStateTransition
        );
        require!(turn > 0, RumbleError::InvalidTurn);
        let fighter_idx = fighter_in_rumble(rumble, &ctx.accounts.fighter.key())
            .ok_or(error!(RumbleError::Unauthorized))?;
        // Check fighter is still alive
        require!(combat.hp[fighter_idx] > 0, RumbleError::FighterEliminated);
        require!(turn == combat.current_turn, RumbleError::InvalidTurn);
        require!(!combat.turn_resolved, RumbleError::TurnAlreadyResolved);
        require!(
            clock.slot >= combat.turn_open_slot && clock.slot <= combat.commit_close_slot,
            RumbleError::CommitWindowClosed
        );
        require!(move_hash != [0u8; 32], RumbleError::InvalidMoveCommitment);

        let move_commitment = &mut ctx.accounts.move_commitment;
        move_commitment.rumble_id = rumble_id;
        move_commitment.fighter = ctx.accounts.fighter.key();
        move_commitment.turn = turn;
        move_commitment.move_hash = move_hash;
        move_commitment.revealed_move = 255;
        move_commitment.revealed = false;
        move_commitment.committed_slot = clock.slot;
        move_commitment.revealed_slot = 0;
        move_commitment.bump = ctx.bumps.move_commitment;

        emit!(MoveCommittedEvent {
            rumble_id,
            fighter: ctx.accounts.fighter.key(),
            turn,
            committed_slot: clock.slot,
        });

        Ok(())
    }

    /// Fighter reveals move + salt for a previously committed move hash.
    #[cfg(feature = "combat")]
    pub fn reveal_move(
        ctx: Context<RevealMove>,
        rumble_id: u64,
        turn: u32,
        move_code: u8,
        salt: [u8; 32],
    ) -> Result<()> {
        let clock = Clock::get()?;
        let rumble = &ctx.accounts.rumble;
        let combat = &ctx.accounts.combat_state;

        require!(
            rumble.state == RumbleState::Combat,
            RumbleError::InvalidStateTransition
        );
        require!(turn > 0, RumbleError::InvalidTurn);
        require!(
            fighter_in_rumble(rumble, &ctx.accounts.fighter.key()).is_some(),
            RumbleError::Unauthorized
        );
        require!(turn == combat.current_turn, RumbleError::InvalidTurn);
        require!(!combat.turn_resolved, RumbleError::TurnAlreadyResolved);
        require!(
            clock.slot > combat.commit_close_slot && clock.slot <= combat.reveal_close_slot,
            RumbleError::RevealWindowClosed
        );
        require!(is_valid_move_code(move_code), RumbleError::InvalidMoveCode);

        let move_commitment = &mut ctx.accounts.move_commitment;
        require!(!move_commitment.revealed, RumbleError::AlreadyRevealedMove);

        let computed_hash = compute_move_commitment_hash(
            rumble_id,
            turn,
            &ctx.accounts.fighter.key(),
            move_code,
            &salt,
        );
        require!(
            computed_hash == move_commitment.move_hash,
            RumbleError::InvalidMoveCommitment
        );

        move_commitment.revealed = true;
        move_commitment.revealed_move = move_code;
        move_commitment.revealed_slot = clock.slot;

        emit!(MoveRevealedEvent {
            rumble_id,
            fighter: ctx.accounts.fighter.key(),
            turn,
            move_code,
            revealed_slot: clock.slot,
        });

        Ok(())
    }

    /// Open the first turn window after combat starts.
    /// Permissionless keeper call; correctness is slot-gated on-chain.
    #[cfg(feature = "combat")]
    pub fn open_turn(ctx: Context<CombatAction>) -> Result<()> {
        let clock = Clock::get()?;
        let rumble = &ctx.accounts.rumble;
        let combat = &mut ctx.accounts.combat_state;

        require!(
            rumble.state == RumbleState::Combat,
            RumbleError::InvalidStateTransition
        );
        require!(combat.current_turn == 0, RumbleError::TurnAlreadyOpen);
        require!(combat.turn_resolved, RumbleError::TurnNotResolved);
        require!(combat.remaining_fighters > 1, RumbleError::CombatAlreadyFinished);

        combat.current_turn = 1;
        combat.turn_open_slot = clock.slot;
        combat.commit_close_slot = clock
            .slot
            .checked_add(COMMIT_WINDOW_SLOTS)
            .ok_or(RumbleError::MathOverflow)?;
        combat.reveal_close_slot = combat
            .commit_close_slot
            .checked_add(REVEAL_WINDOW_SLOTS)
            .ok_or(RumbleError::MathOverflow)?;
        combat.turn_resolved = false;

        emit!(TurnOpenedEvent {
            rumble_id: rumble.id,
            turn: combat.current_turn,
            turn_open_slot: combat.turn_open_slot,
            commit_close_slot: combat.commit_close_slot,
            reveal_close_slot: combat.reveal_close_slot,
        });

        Ok(())
    }

    /// Resolve the active turn from revealed move commitments.
    /// If a fighter didn't reveal, deterministic fallback move is used.
    #[cfg(feature = "combat")]
    pub fn resolve_turn(ctx: Context<CombatAction>) -> Result<()> {
        let clock = Clock::get()?;
        let rumble = &ctx.accounts.rumble;
        let combat = &mut ctx.accounts.combat_state;

        require!(
            rumble.state == RumbleState::Combat,
            RumbleError::InvalidStateTransition
        );
        require!(combat.current_turn > 0, RumbleError::TurnNotOpen);
        require!(!combat.turn_resolved, RumbleError::TurnAlreadyResolved);
        require!(
            clock.slot >= combat.reveal_close_slot,
            RumbleError::RevealWindowActive
        );

        let fighter_count = combat.fighter_count as usize;
        let turn = combat.current_turn;

        let mut alive_indices: Vec<usize> = (0..fighter_count)
            .filter(|i| combat.hp[*i] > 0 && combat.elimination_rank[*i] == 0)
            .collect();

        if alive_indices.len() <= 1 {
            combat.turn_resolved = true;
            if let Some(idx) = alive_indices.first() {
                combat.winner_index = *idx as u8;
            }
            emit!(TurnResolvedEvent {
                rumble_id: rumble.id,
                turn,
                remaining_fighters: combat.remaining_fighters,
            });
            return Ok(());
        }

        let rumble_id_bytes = rumble.id.to_le_bytes();
        let turn_bytes = turn.to_le_bytes();
        alive_indices.sort_by(|a, b| {
            let key_a = hash_u64(&[
                b"pair-order",
                rumble_id_bytes.as_ref(),
                turn_bytes.as_ref(),
                rumble.fighters[*a].as_ref(),
            ]);
            let key_b = hash_u64(&[
                b"pair-order",
                rumble_id_bytes.as_ref(),
                turn_bytes.as_ref(),
                rumble.fighters[*b].as_ref(),
            ]);
            key_a
                .cmp(&key_b)
                .then_with(|| rumble.fighters[*a].to_bytes().cmp(&rumble.fighters[*b].to_bytes()))
        });

        let mut paired_indices: Vec<usize> = Vec::with_capacity(alive_indices.len());
        let mut eliminated_this_turn: Vec<usize> = Vec::new();

        for chunk in alive_indices.chunks(2) {
            if chunk.len() < 2 {
                // bye
                continue;
            }

            let idx_a = chunk[0];
            let idx_b = chunk[1];
            let fighter_a = rumble.fighters[idx_a];
            let fighter_b = rumble.fighters[idx_b];

            let move_a = read_revealed_move_from_remaining_accounts(
                ctx.remaining_accounts,
                rumble.id,
                turn,
                &fighter_a,
            )
            .filter(|m| is_valid_move_code(*m))
            .unwrap_or_else(|| fallback_move_code(rumble.id, turn, &fighter_a, combat.meter[idx_a]));
            let move_b = read_revealed_move_from_remaining_accounts(
                ctx.remaining_accounts,
                rumble.id,
                turn,
                &fighter_b,
            )
            .filter(|m| is_valid_move_code(*m))
            .unwrap_or_else(|| fallback_move_code(rumble.id, turn, &fighter_b, combat.meter[idx_b]));

            let (damage_to_a, damage_to_b, meter_used_a, meter_used_b) =
                resolve_duel(move_a, move_b, combat.meter[idx_a], combat.meter[idx_b]);

            combat.meter[idx_a] = combat.meter[idx_a].saturating_sub(meter_used_a);
            combat.meter[idx_b] = combat.meter[idx_b].saturating_sub(meter_used_b);

            combat.hp[idx_a] = combat.hp[idx_a].saturating_sub(damage_to_a);
            combat.hp[idx_b] = combat.hp[idx_b].saturating_sub(damage_to_b);

            combat.total_damage_dealt[idx_a] = combat.total_damage_dealt[idx_a]
                .checked_add(damage_to_b as u64)
                .ok_or(RumbleError::MathOverflow)?;
            combat.total_damage_dealt[idx_b] = combat.total_damage_dealt[idx_b]
                .checked_add(damage_to_a as u64)
                .ok_or(RumbleError::MathOverflow)?;
            combat.total_damage_taken[idx_a] = combat.total_damage_taken[idx_a]
                .checked_add(damage_to_a as u64)
                .ok_or(RumbleError::MathOverflow)?;
            combat.total_damage_taken[idx_b] = combat.total_damage_taken[idx_b]
                .checked_add(damage_to_b as u64)
                .ok_or(RumbleError::MathOverflow)?;

            paired_indices.push(idx_a);
            paired_indices.push(idx_b);

            emit!(TurnPairResolvedEvent {
                rumble_id: rumble.id,
                turn,
                fighter_a: fighter_a,
                fighter_b: fighter_b,
                move_a,
                move_b,
                damage_to_a,
                damage_to_b,
            });

            if combat.hp[idx_a] == 0 && combat.elimination_rank[idx_a] == 0 {
                eliminated_this_turn.push(idx_a);
            }
            if combat.hp[idx_b] == 0 && combat.elimination_rank[idx_b] == 0 {
                eliminated_this_turn.push(idx_b);
            }
        }

        for idx in paired_indices {
            if combat.hp[idx] > 0 {
                let next_meter = combat.meter[idx].saturating_add(METER_PER_TURN);
                combat.meter[idx] = next_meter.min(SPECIAL_METER_COST);
            }
        }

        // Give bye fighter meter if odd count
        if alive_indices.len() % 2 == 1 {
            let bye_idx = alive_indices[alive_indices.len() - 1];
            let next_meter = combat.meter[bye_idx].saturating_add(METER_PER_TURN);
            combat.meter[bye_idx] = next_meter.min(SPECIAL_METER_COST);
        }

        // Deterministic elimination ordering: sort by damage dealt descending,
        // then by fighter index ascending as tiebreaker.
        eliminated_this_turn.sort_by(|a, b| {
            combat.total_damage_dealt[*b]
                .cmp(&combat.total_damage_dealt[*a])
                .then_with(|| a.cmp(b))
        });

        for idx in eliminated_this_turn {
            if combat.elimination_rank[idx] > 0 {
                continue;
            }
            let eliminated_so_far = combat
                .fighter_count
                .checked_sub(combat.remaining_fighters)
                .ok_or(RumbleError::MathOverflow)?;
            combat.elimination_rank[idx] = eliminated_so_far
                .checked_add(1)
                .ok_or(RumbleError::MathOverflow)?;
            combat.remaining_fighters = combat
                .remaining_fighters
                .checked_sub(1)
                .ok_or(RumbleError::MathOverflow)?;
        }

        if combat.remaining_fighters == 1 {
            if let Some((idx, _)) = (0..fighter_count)
                .filter(|i| combat.hp[*i] > 0 && combat.elimination_rank[*i] == 0)
                .map(|i| (i, combat.hp[i]))
                .next()
            {
                combat.winner_index = idx as u8;
            }
        }

        combat.turn_resolved = true;

        emit!(TurnResolvedEvent {
            rumble_id: rumble.id,
            turn,
            remaining_fighters: combat.remaining_fighters,
        });

        Ok(())
    }

    /// Accept pre-computed turn results from the admin/keeper.
    /// Validates damage by re-running resolve_duel internally.
    /// This is the "Option D hybrid" path — combat math runs off-chain,
    /// but on-chain program validates correctness.
    #[cfg(feature = "combat")]
    pub fn post_turn_result(
        ctx: Context<AdminCombatAction>,
        duel_results: Vec<DuelResult>,
        bye_fighter_idx: Option<u8>,
    ) -> Result<()> {
        let clock = Clock::get()?;
        let rumble = &ctx.accounts.rumble;
        let combat = &mut ctx.accounts.combat_state;

        require!(
            rumble.state == RumbleState::Combat,
            RumbleError::InvalidStateTransition
        );
        require!(combat.current_turn > 0, RumbleError::TurnNotOpen);
        require!(!combat.turn_resolved, RumbleError::TurnAlreadyResolved);
        require!(
            clock.slot >= combat.reveal_close_slot,
            RumbleError::RevealWindowActive
        );

        let fighter_count = combat.fighter_count as usize;
        let turn = combat.current_turn;

        // Track which fighters were paired to give them meter later
        let mut paired_indices: Vec<usize> = Vec::new();
        let mut eliminated_this_turn: Vec<usize> = Vec::new();

        // M2 fix: track seen indices to prevent duplicate pairing
        let mut seen = vec![false; fighter_count];

        // M3 fix: count alive fighters to verify all are accounted for
        let alive_count = (0..fighter_count)
            .filter(|&i| combat.hp[i] > 0 && combat.elimination_rank[i] == 0)
            .count();
        let expected_duels = alive_count / 2;
        let expected_bye = if alive_count % 2 == 1 { 1usize } else { 0usize };
        require!(
            duel_results.len() == expected_duels,
            RumbleError::InvalidFighterCount
        );

        for dr in duel_results.iter() {
            let idx_a = dr.fighter_a_idx as usize;
            let idx_b = dr.fighter_b_idx as usize;

            // Validate indices
            require!(idx_a < fighter_count && idx_b < fighter_count, RumbleError::InvalidFighterCount);
            require!(idx_a != idx_b, RumbleError::DuplicateFighter);
            // M2 fix: ensure no fighter appears in multiple duels
            require!(!seen[idx_a] && !seen[idx_b], RumbleError::DuplicateFighter);
            seen[idx_a] = true;
            seen[idx_b] = true;
            // Fighters must be alive
            require!(
                combat.hp[idx_a] > 0 && combat.elimination_rank[idx_a] == 0,
                RumbleError::FighterEliminated
            );
            require!(
                combat.hp[idx_b] > 0 && combat.elimination_rank[idx_b] == 0,
                RumbleError::FighterEliminated
            );
            // Validate moves
            require!(is_valid_move_code(dr.move_a), RumbleError::InvalidState);
            require!(is_valid_move_code(dr.move_b), RumbleError::InvalidState);

            // RE-VALIDATE damage by running resolve_duel
            let (expected_dmg_a, expected_dmg_b, expected_meter_a, expected_meter_b) =
                resolve_duel(dr.move_a, dr.move_b, combat.meter[idx_a], combat.meter[idx_b]);
            require!(
                dr.damage_to_a == expected_dmg_a && dr.damage_to_b == expected_dmg_b,
                RumbleError::DamageMismatch
            );

            // Apply damage
            combat.meter[idx_a] = combat.meter[idx_a].saturating_sub(expected_meter_a);
            combat.meter[idx_b] = combat.meter[idx_b].saturating_sub(expected_meter_b);

            combat.hp[idx_a] = combat.hp[idx_a].saturating_sub(dr.damage_to_a);
            combat.hp[idx_b] = combat.hp[idx_b].saturating_sub(dr.damage_to_b);

            combat.total_damage_dealt[idx_a] = combat.total_damage_dealt[idx_a]
                .checked_add(dr.damage_to_b as u64)
                .ok_or(RumbleError::MathOverflow)?;
            combat.total_damage_dealt[idx_b] = combat.total_damage_dealt[idx_b]
                .checked_add(dr.damage_to_a as u64)
                .ok_or(RumbleError::MathOverflow)?;
            combat.total_damage_taken[idx_a] = combat.total_damage_taken[idx_a]
                .checked_add(dr.damage_to_a as u64)
                .ok_or(RumbleError::MathOverflow)?;
            combat.total_damage_taken[idx_b] = combat.total_damage_taken[idx_b]
                .checked_add(dr.damage_to_b as u64)
                .ok_or(RumbleError::MathOverflow)?;

            paired_indices.push(idx_a);
            paired_indices.push(idx_b);

            emit!(TurnPairResolvedEvent {
                rumble_id: rumble.id,
                turn,
                fighter_a: rumble.fighters[idx_a],
                fighter_b: rumble.fighters[idx_b],
                move_a: dr.move_a,
                move_b: dr.move_b,
                damage_to_a: dr.damage_to_a,
                damage_to_b: dr.damage_to_b,
            });

            if combat.hp[idx_a] == 0 && combat.elimination_rank[idx_a] == 0 {
                eliminated_this_turn.push(idx_a);
            }
            if combat.hp[idx_b] == 0 && combat.elimination_rank[idx_b] == 0 {
                eliminated_this_turn.push(idx_b);
            }
        }

        // Give meter to paired survivors
        for idx in paired_indices {
            if combat.hp[idx] > 0 {
                let next_meter = combat.meter[idx].saturating_add(METER_PER_TURN);
                combat.meter[idx] = next_meter.min(SPECIAL_METER_COST);
            }
        }

        // M3 fix: verify bye fighter matches expected parity
        if expected_bye == 1 {
            require!(bye_fighter_idx.is_some(), RumbleError::InvalidFighterCount);
        } else {
            require!(bye_fighter_idx.is_none(), RumbleError::InvalidFighterCount);
        }

        // Bye fighter gets meter
        if let Some(bye_idx) = bye_fighter_idx {
            let bye = bye_idx as usize;
            require!(bye < fighter_count, RumbleError::InvalidFighterCount);
            require!(
                combat.hp[bye] > 0 && combat.elimination_rank[bye] == 0,
                RumbleError::FighterEliminated
            );
            // M2 fix: bye fighter must not also appear in a duel
            require!(!seen[bye], RumbleError::DuplicateFighter);
            let next_meter = combat.meter[bye].saturating_add(METER_PER_TURN);
            combat.meter[bye] = next_meter.min(SPECIAL_METER_COST);
        }

        // Deterministic elimination ordering: sort by damage dealt descending,
        // then by fighter index ascending as tiebreaker.
        eliminated_this_turn.sort_by(|a, b| {
            combat.total_damage_dealt[*b]
                .cmp(&combat.total_damage_dealt[*a])
                .then_with(|| a.cmp(b))
        });

        // Handle eliminations (same logic as resolve_turn)
        for idx in eliminated_this_turn {
            if combat.elimination_rank[idx] > 0 {
                continue;
            }
            let eliminated_so_far = combat
                .fighter_count
                .checked_sub(combat.remaining_fighters)
                .ok_or(RumbleError::MathOverflow)?;
            combat.elimination_rank[idx] = eliminated_so_far
                .checked_add(1)
                .ok_or(RumbleError::MathOverflow)?;
            combat.remaining_fighters = combat
                .remaining_fighters
                .checked_sub(1)
                .ok_or(RumbleError::MathOverflow)?;
        }

        // Check for winner
        if combat.remaining_fighters == 1 {
            if let Some((idx, _)) = (0..fighter_count)
                .filter(|i| combat.hp[*i] > 0 && combat.elimination_rank[*i] == 0)
                .map(|i| (i, combat.hp[i]))
                .next()
            {
                combat.winner_index = idx as u8;
            }
        }

        combat.turn_resolved = true;

        emit!(TurnResolvedEvent {
            rumble_id: rumble.id,
            turn,
            remaining_fighters: combat.remaining_fighters,
        });

        Ok(())
    }

    /// Advance to next turn after a resolved turn.
    /// Permissionless keeper call.
    #[cfg(feature = "combat")]
    pub fn advance_turn(ctx: Context<CombatAction>) -> Result<()> {
        let clock = Clock::get()?;
        let rumble = &ctx.accounts.rumble;
        let combat = &mut ctx.accounts.combat_state;

        require!(
            rumble.state == RumbleState::Combat,
            RumbleError::InvalidStateTransition
        );
        require!(combat.current_turn > 0, RumbleError::TurnNotOpen);
        require!(combat.turn_resolved, RumbleError::TurnNotResolved);
        require!(combat.remaining_fighters > 1, RumbleError::CombatAlreadyFinished);
        require!(
            combat.current_turn < MAX_ONCHAIN_COMBAT_TURNS,
            RumbleError::MaxTurnsReached
        );
        require!(
            clock.slot >= combat.reveal_close_slot,
            RumbleError::RevealWindowActive
        );

        combat.current_turn = combat
            .current_turn
            .checked_add(1)
            .ok_or(RumbleError::MathOverflow)?;
        combat.turn_open_slot = clock.slot;
        combat.commit_close_slot = clock
            .slot
            .checked_add(COMMIT_WINDOW_SLOTS)
            .ok_or(RumbleError::MathOverflow)?;
        combat.reveal_close_slot = combat
            .commit_close_slot
            .checked_add(REVEAL_WINDOW_SLOTS)
            .ok_or(RumbleError::MathOverflow)?;
        combat.turn_resolved = false;

        emit!(TurnOpenedEvent {
            rumble_id: rumble.id,
            turn: combat.current_turn,
            turn_open_slot: combat.turn_open_slot,
            commit_close_slot: combat.commit_close_slot,
            reveal_close_slot: combat.reveal_close_slot,
        });

        Ok(())
    }

    /// Permissionless deterministic finalization from on-chain combat state.
    #[cfg(feature = "combat")]
    pub fn finalize_rumble(ctx: Context<FinalizeRumble>) -> Result<()> {
        let clock = Clock::get()?;
        let rumble = &mut ctx.accounts.rumble;
        let combat = &mut ctx.accounts.combat_state;

        require!(
            rumble.state == RumbleState::Combat,
            RumbleError::InvalidStateTransition
        );
        require!(combat.current_turn > 0, RumbleError::TurnNotOpen);

        // Check for combat timeout: if current slot is >5000 past the turn_open_slot,
        // allow finalization even if combat hasn't naturally ended (prevents stuck rumbles).
        let timed_out = clock.slot > combat.turn_open_slot
            .checked_add(COMBAT_TIMEOUT_SLOTS)
            .ok_or(RumbleError::MathOverflow)?;

        if !timed_out {
            require!(combat.turn_resolved, RumbleError::TurnNotResolved);
        }

        if combat.remaining_fighters > 1 {
            require!(
                combat.current_turn >= MAX_ONCHAIN_COMBAT_TURNS || timed_out,
                RumbleError::CombatStillActive
            );
        }

        let fighter_count = rumble.fighter_count as usize;
        let mut winner_idx: usize = if combat.winner_index != u8::MAX {
            combat.winner_index as usize
        } else {
            0
        };

        if combat.winner_index == u8::MAX {
            let mut candidates: Vec<usize> = (0..fighter_count)
                .filter(|i| combat.hp[*i] > 0 && combat.elimination_rank[*i] == 0)
                .collect();
            if candidates.is_empty() {
                candidates = (0..fighter_count).collect();
            }
            candidates.sort_by(|a, b| {
                combat.hp[*b]
                    .cmp(&combat.hp[*a])
                    .then_with(|| combat.total_damage_dealt[*b].cmp(&combat.total_damage_dealt[*a]))
                    .then_with(|| rumble.fighters[*a].to_bytes().cmp(&rumble.fighters[*b].to_bytes()))
            });
            winner_idx = *candidates.first().ok_or(RumbleError::CombatStillActive)?;
            combat.winner_index = winner_idx as u8;
        }

        let mut placements = [0u8; MAX_FIGHTERS];
        placements[winner_idx] = 1;

        let mut survivors: Vec<usize> = (0..fighter_count)
            .filter(|i| *i != winner_idx && combat.hp[*i] > 0 && combat.elimination_rank[*i] == 0)
            .collect();
        survivors.sort_by(|a, b| {
            combat.hp[*b]
                .cmp(&combat.hp[*a])
                .then_with(|| combat.total_damage_dealt[*b].cmp(&combat.total_damage_dealt[*a]))
                .then_with(|| rumble.fighters[*a].to_bytes().cmp(&rumble.fighters[*b].to_bytes()))
        });
        let mut next_place: u8 = 2;
        for idx in survivors {
            placements[idx] = next_place;
            next_place = next_place.checked_add(1).ok_or(RumbleError::MathOverflow)?;
        }

        // Assign eliminated fighters by reverse elimination_rank (last eliminated = best rank).
        // Using sequential next_place instead of formula to avoid duplicate placements
        // when elimination_rank == fighter_count (which would produce placement 1, colliding
        // with the winner).
        let mut eliminated: Vec<(usize, u8)> = (0..fighter_count)
            .filter(|i| placements[*i] == 0 && combat.elimination_rank[*i] > 0)
            .map(|i| (i, combat.elimination_rank[i]))
            .collect();
        // Sort by rank descending: highest rank = last eliminated = best placement
        eliminated.sort_by(|a, b| b.1.cmp(&a.1));
        for (idx, _rank) in eliminated {
            placements[idx] = next_place;
            next_place = next_place.checked_add(1).ok_or(RumbleError::MathOverflow)?;
        }

        // Any remaining unplaced fighters (should not happen, but safety net)
        for i in 0..fighter_count {
            if placements[i] == 0 {
                placements[i] = next_place;
                next_place = next_place.checked_add(1).ok_or(RumbleError::MathOverflow)?;
            }
        }

        rumble.placements = placements;
        rumble.winner_index = winner_idx as u8;
        rumble.state = RumbleState::Payout;
        rumble.completed_at = clock.unix_timestamp;

        emit!(OnchainResultFinalizedEvent {
            rumble_id: rumble.id,
            winner_index: rumble.winner_index,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Deprecated: result is now finalized permissionlessly from on-chain combat state.
    #[cfg(feature = "combat")]
    pub fn report_result(
        _ctx: Context<AdminAction>,
        _placements: Vec<u8>,
        _winner_index: u8,
    ) -> Result<()> {
        err!(RumbleError::DeprecatedInstruction)
    }

    /// Admin override to set rumble result directly.
    /// Bypasses combat state machine for off-chain resolution (mainnet betting).
    pub fn admin_set_result(
        ctx: Context<AdminAction>,
        placements: Vec<u8>,
        winner_index: u8,
    ) -> Result<()> {
        let rumble = &mut ctx.accounts.rumble;

        require!(
            rumble.state == RumbleState::Betting || rumble.state == RumbleState::Combat,
            RumbleError::InvalidStateTransition
        );
        require!(
            placements.len() == rumble.fighter_count as usize,
            RumbleError::InvalidPlacement
        );
        require!(
            winner_index < rumble.fighter_count,
            RumbleError::InvalidFighterIndex
        );
        require!(
            placements[winner_index as usize] == 1,
            RumbleError::InvalidPlacement
        );

        let mut placement_arr = [0u8; MAX_FIGHTERS];
        for (i, &p) in placements.iter().enumerate() {
            placement_arr[i] = p;
        }

        let clock = Clock::get()?;
        rumble.placements = placement_arr;
        rumble.winner_index = winner_index;
        rumble.state = RumbleState::Payout;
        rumble.completed_at = clock.unix_timestamp;

        msg!(
            "Admin set result for rumble {}: winner_index={}",
            rumble.id,
            winner_index
        );

        Ok(())
    }

    /// Bettor claims their payout if their fighter placed 1st (winner-takes-all).
    ///
    /// Payout logic:
    /// 1. Sum all pools for fighters that did NOT place 1st = losers_pool
    /// 2. Treasury cut = 10% of losers_pool
    /// 3. Distributable = losers_pool - treasury_cut
    /// 4. 1st place bettors split 100% of distributable (winner-takes-all)
    /// 5. Each winning bettor gets their original bet back + proportional share
    pub fn claim_payout(ctx: Context<ClaimPayout>) -> Result<()> {
        let rumble = &ctx.accounts.rumble;
        let clock = Clock::get()?;
        let mut bettor_account = {
            let data = ctx.accounts.bettor_account.try_borrow_data()?;
            parse_bettor_account_data(&data)?
        };

        require!(
            rumble.state == RumbleState::Payout || rumble.state == RumbleState::Complete,
            RumbleError::PayoutNotReady
        );

        require!(!bettor_account.claimed, RumbleError::AlreadyClaimed);

        require!(
            bettor_account.authority == ctx.accounts.bettor.key(),
            RumbleError::Unauthorized
        );
        require!(
            bettor_account.rumble_id == rumble.id,
            RumbleError::InvalidRumble
        );

        let winner_idx = rumble.winner_index as usize;
        require!(
            winner_idx < rumble.fighter_count as usize,
            RumbleError::InvalidFighterIndex
        );
        let placement = rumble.placements[winner_idx];

        // Lazy accrual model:
        // If claimable is empty, compute and store this bettor's payout once.
        if bettor_account.claimable_lamports == 0 {
            // Winner-takes-all: only 1st place gets a payout
            require!(placement == 1, RumbleError::NotInPayoutRange);

            // Account can hold stakes across multiple fighters.
            // Only stake deployed on the winning fighter is eligible for payout.
            let mut winning_deployed = bettor_account.fighter_deployments[winner_idx];

            // Legacy fallback: older accounts only tracked one fighter_index + sol_deployed.
            if winning_deployed == 0 && bettor_account.fighter_index as usize == winner_idx {
                winning_deployed = bettor_account.sol_deployed;
            }
            require!(winning_deployed > 0, RumbleError::NotInPayoutRange);

            // Calculate losers' pool (sum of pools for all fighters except 1st place)
            let mut losers_pool: u64 = 0;
            let mut first_pool: u64 = 0;

            for i in 0..rumble.fighter_count as usize {
                let p = rumble.placements[i];
                let pool = rumble.betting_pools[i];
                if p == 1 {
                    first_pool = first_pool
                        .checked_add(pool)
                        .ok_or(RumbleError::MathOverflow)?;
                } else {
                    losers_pool = losers_pool
                        .checked_add(pool)
                        .ok_or(RumbleError::MathOverflow)?;
                }
            }

            // Treasury cut from losers' pool
            let treasury_cut = losers_pool
                .checked_mul(TREASURY_CUT_BPS)
                .ok_or(RumbleError::MathOverflow)?
                .checked_div(10_000)
                .ok_or(RumbleError::MathOverflow)?;

            let distributable = losers_pool
                .checked_sub(treasury_cut)
                .ok_or(RumbleError::MathOverflow)?;

            // Winner-takes-all: 100% of distributable goes to 1st place bettors
            let place_allocation = distributable;

            // Bettor's proportional share of the allocation
            // share = (bettor_winning_deployed / first_pool) * place_allocation
            // Use u128 intermediate math to prevent overflow when pools exceed ~4 SOL
            // (u64 overflows at ~1.8×10^19, but lamport products easily reach that)
            let winnings = if first_pool > 0 {
                (place_allocation as u128)
                    .checked_mul(winning_deployed as u128)
                    .ok_or(RumbleError::MathOverflow)?
                    .checked_div(first_pool as u128)
                    .ok_or(RumbleError::MathOverflow)? as u64
            } else {
                0
            };

            // Total payout = original winning stake + winnings from losers' pool
            let total_payout = winning_deployed
                .checked_add(winnings)
                .ok_or(RumbleError::MathOverflow)?;

            bettor_account.claimable_lamports = total_payout;
        }

        let claimable = bettor_account.claimable_lamports;
        require!(claimable > 0, RumbleError::NothingToClaim);

        // State update BEFORE CPI transfer (checks-effects-interactions pattern)
        bettor_account.claimable_lamports = 0;
        bettor_account.total_claimed_lamports = bettor_account
            .total_claimed_lamports
            .checked_add(claimable)
            .ok_or(RumbleError::MathOverflow)?;
        bettor_account.last_claim_ts = clock.unix_timestamp;
        bettor_account.claimed = true;

        {
            let mut data = ctx.accounts.bettor_account.try_borrow_mut_data()?;
            write_bettor_account_data(&mut data, &bettor_account)?;
        }

        // Transfer SOL from vault PDA to bettor via System Program CPI signed
        // by the vault PDA seeds.
        let vault_info = ctx.accounts.vault.to_account_info();
        let bettor_info = ctx.accounts.bettor.to_account_info();
        // Vault PDAs are ephemeral wager buckets; claims must be able to drain
        // the full balance, otherwise exact-match pools fail due rent reserve.
        let available = vault_info.lamports();
        require!(available >= claimable, RumbleError::InsufficientVaultFunds);

        let rumble_id_bytes = rumble.id.to_le_bytes();
        let vault_seeds: &[&[u8]] = &[VAULT_SEED, rumble_id_bytes.as_ref(), &[ctx.bumps.vault]];
        let signer_seeds: &[&[&[u8]]] = &[vault_seeds];

        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: vault_info,
                    to: bettor_info,
                },
                signer_seeds,
            ),
            claimable,
        )?;

        msg!(
            "Payout claimed: {} lamports (deployed: {}) for rumble {}",
            claimable,
            bettor_account.sol_deployed,
            rumble.id
        );

        emit!(PayoutClaimedEvent {
            rumble_id: rumble.id,
            bettor: ctx.accounts.bettor.key(),
            fighter_index: rumble.winner_index,
            placement,
            amount: claimable,
        });

        Ok(())
    }

    /// Fighter owner claims accumulated sponsorship revenue.
    /// Drains the sponsorship PDA balance to the fighter owner.
    pub fn claim_sponsorship_revenue(ctx: Context<ClaimSponsorship>) -> Result<()> {
        // Verify that fighter_owner is the authority of the fighter account.
        // The authority pubkey is stored at bytes 8..40 (after Anchor's 8-byte discriminator).
        {
            let fighter_data = ctx.accounts.fighter.try_borrow_data()?;
            // NOTE: This discriminator is tied to the fighter_registry program's FighterAccount struct.
            // If that program is upgraded and changes its account layout, this must be updated.
            require!(fighter_data.len() >= 40, RumbleError::InvalidFighterAccount);
            require!(
                fighter_data[..8] == FIGHTER_ACCOUNT_DISCRIMINATOR,
                RumbleError::InvalidFighterAccount
            );
            let authority_bytes: [u8; 32] = fighter_data[8..40]
                .try_into()
                .map_err(|_| error!(RumbleError::InvalidFighterAccount))?;
            let fighter_authority = Pubkey::new_from_array(authority_bytes);
            require!(
                fighter_authority == ctx.accounts.fighter_owner.key(),
                RumbleError::Unauthorized
            );
        }

        let sponsorship_info = ctx.accounts.sponsorship_account.to_account_info();
        let owner_info = ctx.accounts.fighter_owner.to_account_info();

        // Keep rent-exempt minimum in the sponsorship account
        let rent = Rent::get()?;
        let min_balance = rent.minimum_balance(0);
        let available = sponsorship_info
            .lamports()
            .checked_sub(min_balance)
            .ok_or(RumbleError::InsufficientVaultFunds)?;

        require!(available > 0, RumbleError::NothingToClaim);

        let fighter_key = ctx.accounts.fighter.key();
        let sponsorship_seeds: &[&[u8]] = &[
            SPONSORSHIP_SEED,
            fighter_key.as_ref(),
            &[ctx.bumps.sponsorship_account],
        ];
        let signer_seeds: &[&[&[u8]]] = &[sponsorship_seeds];

        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: sponsorship_info,
                    to: owner_info,
                },
                signer_seeds,
            ),
            available,
        )?;

        msg!(
            "Sponsorship claimed: {} lamports by {}",
            available,
            ctx.accounts.fighter_owner.key()
        );

        emit!(SponsorshipClaimedEvent {
            fighter_owner: ctx.accounts.fighter_owner.key(),
            fighter: ctx.accounts.fighter.key(),
            amount: available,
        });

        Ok(())
    }

    /// Admin transitions rumble to Complete state after all payouts processed.
    pub fn complete_rumble(ctx: Context<AdminAction>) -> Result<()> {
        let rumble = &mut ctx.accounts.rumble;

        require!(
            rumble.state == RumbleState::Payout,
            RumbleError::InvalidStateTransition
        );

        let clock = Clock::get()?;
        let claim_window_end = rumble
            .completed_at
            .checked_add(PAYOUT_CLAIM_WINDOW_SECONDS)
            .ok_or(RumbleError::MathOverflow)?;
        require!(
            clock.unix_timestamp >= claim_window_end,
            RumbleError::ClaimWindowActive
        );

        rumble.state = RumbleState::Complete;

        let config = &mut ctx.accounts.config;
        config.total_rumbles = config
            .total_rumbles
            .checked_add(1)
            .ok_or(RumbleError::MathOverflow)?;

        msg!("Rumble {} completed", rumble.id);
        Ok(())
    }

    /// Sweep remaining SOL from a completed Rumble's vault to the treasury.
    /// Called by admin after all claims are processed.
    pub fn sweep_treasury(ctx: Context<SweepTreasury>) -> Result<()> {
        let rumble = &ctx.accounts.rumble;

        require!(
            rumble.state == RumbleState::Complete,
            RumbleError::InvalidStateTransition
        );

        let clock = Clock::get()?;
        let claim_window_end = rumble
            .completed_at
            .checked_add(PAYOUT_CLAIM_WINDOW_SECONDS)
            .ok_or(RumbleError::MathOverflow)?;
        require!(
            clock.unix_timestamp >= claim_window_end,
            RumbleError::ClaimWindowActive
        );

        let vault_info = ctx.accounts.vault.to_account_info();
        let treasury_info = ctx.accounts.treasury.to_account_info();

        // Keep rent-exempt minimum in the vault
        let rent = Rent::get()?;
        let min_balance = rent.minimum_balance(0);
        let available = vault_info
            .lamports()
            .checked_sub(min_balance)
            .ok_or(RumbleError::InsufficientVaultFunds)?;

        require!(available > 0, RumbleError::NothingToClaim);

        let rumble_id_bytes = rumble.id.to_le_bytes();
        let vault_seeds: &[&[u8]] = &[VAULT_SEED, rumble_id_bytes.as_ref(), &[ctx.bumps.vault]];
        let signer_seeds: &[&[&[u8]]] = &[vault_seeds];

        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: vault_info,
                    to: treasury_info,
                },
                signer_seeds,
            ),
            available,
        )?;

        msg!(
            "Treasury sweep: {} lamports from rumble {} vault to treasury",
            available,
            rumble.id
        );

        Ok(())
    }

    /// Close a MoveCommitment PDA and return rent to a destination.
    /// Admin-only. Only allowed when rumble is in Payout or Complete state.
    #[cfg(feature = "combat")]
    pub fn close_move_commitment(_ctx: Context<CloseMoveCommitment>, _rumble_id: u64, _turn: u32) -> Result<()> {
        // Anchor's `close = destination` handles the lamport transfer
        Ok(())
    }

    /// Propose a new admin (two-step transfer).
    /// Creates/overwrites PendingAdminRE PDA. New admin must call accept_admin.
    pub fn transfer_admin(ctx: Context<TransferAdmin>, new_admin: Pubkey) -> Result<()> {
        require!(new_admin != Pubkey::default(), RumbleError::InvalidNewAdmin);
        require!(
            new_admin != ctx.accounts.config.admin,
            RumbleError::InvalidNewAdmin
        );

        let pending = &mut ctx.accounts.pending_admin;
        pending.proposed_admin = new_admin;
        pending.proposed_at = Clock::get()?.slot;
        pending.bump = ctx.bumps.pending_admin;

        msg!(
            "Admin transfer proposed: {} -> {}",
            ctx.accounts.config.admin,
            new_admin
        );
        Ok(())
    }

    /// Accept a pending admin transfer. Must be signed by the proposed admin.
    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        let pending = &ctx.accounts.pending_admin;
        let new_admin = ctx.accounts.new_admin.key();

        require!(
            new_admin == pending.proposed_admin,
            RumbleError::Unauthorized
        );

        let old_admin = config.admin;
        config.admin = new_admin;

        msg!("Admin transferred: {} -> {}", old_admin, new_admin);
        Ok(())
    }

    /// Update the treasury address. Admin-only, immediate (lower risk than admin transfer).
    pub fn update_treasury(ctx: Context<UpdateTreasury>, new_treasury: Pubkey) -> Result<()> {
        ctx.accounts.config.treasury = new_treasury;
        msg!("Treasury updated to {}", new_treasury);
        Ok(())
    }

    /// Close a completed Rumble PDA to reclaim rent. Admin-only.
    /// Requires Complete state and claim window expired.
    pub fn close_rumble(ctx: Context<CloseRumble>) -> Result<()> {
        let rumble = &ctx.accounts.rumble;
        require!(
            rumble.state == RumbleState::Complete,
            RumbleError::InvalidStateTransition
        );

        let clock = Clock::get()?;
        let claim_window_end = rumble
            .completed_at
            .checked_add(PAYOUT_CLAIM_WINDOW_SECONDS)
            .ok_or(RumbleError::MathOverflow)?;
        require!(
            clock.unix_timestamp >= claim_window_end,
            RumbleError::ClaimWindowActive
        );

        msg!("Rumble {} account closed, rent reclaimed", rumble.id);
        Ok(())
    }

    /// Close a RumbleCombatState PDA to reclaim rent. Admin-only.
    /// Requires the associated rumble is Complete.
    #[cfg(feature = "combat")]
    pub fn close_combat_state(ctx: Context<CloseCombatState>) -> Result<()> {
        let rumble = &ctx.accounts.rumble;
        require!(
            rumble.state == RumbleState::Complete,
            RumbleError::InvalidStateTransition
        );

        msg!(
            "Combat state for rumble {} closed, rent reclaimed",
            rumble.id
        );
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = 8 + RumbleConfig::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, RumbleConfig>,

    /// CHECK: Treasury wallet address, validated by admin at init time.
    pub treasury: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(rumble_id: u64, fighters: Vec<Pubkey>, betting_deadline: i64)]
pub struct CreateRumble<'info> {
    #[account(
        mut,
        constraint = admin.key() == config.admin @ RumbleError::Unauthorized,
    )]
    pub admin: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, RumbleConfig>,

    #[account(
        init,
        payer = admin,
        space = 8 + Rumble::INIT_SPACE,
        seeds = [RUMBLE_SEED, rumble_id.to_le_bytes().as_ref()],
        bump
    )]
    pub rumble: Account<'info, Rumble>,

    pub system_program: Program<'info, System>,
}

#[cfg(feature = "combat")]
#[derive(Accounts)]
#[instruction(rumble_id: u64, turn: u32)]
pub struct CommitMove<'info> {
    #[account(mut)]
    pub fighter: Signer<'info>,

    #[account(
        seeds = [RUMBLE_SEED, rumble_id.to_le_bytes().as_ref()],
        bump = rumble.bump,
    )]
    pub rumble: Account<'info, Rumble>,

    #[account(
        seeds = [COMBAT_STATE_SEED, rumble_id.to_le_bytes().as_ref()],
        bump = combat_state.bump,
        constraint = combat_state.rumble_id == rumble_id @ RumbleError::InvalidRumble,
    )]
    pub combat_state: Account<'info, RumbleCombatState>,

    #[account(
        init,
        payer = fighter,
        space = 8 + MoveCommitment::INIT_SPACE,
        seeds = [
            MOVE_COMMIT_SEED,
            rumble_id.to_le_bytes().as_ref(),
            fighter.key().as_ref(),
            turn.to_le_bytes().as_ref(),
        ],
        bump
    )]
    pub move_commitment: Account<'info, MoveCommitment>,

    pub system_program: Program<'info, System>,
}

#[cfg(feature = "combat")]
#[derive(Accounts)]
#[instruction(rumble_id: u64, turn: u32)]
pub struct RevealMove<'info> {
    #[account(mut)]
    pub fighter: Signer<'info>,

    #[account(
        seeds = [RUMBLE_SEED, rumble_id.to_le_bytes().as_ref()],
        bump = rumble.bump,
    )]
    pub rumble: Account<'info, Rumble>,

    #[account(
        seeds = [COMBAT_STATE_SEED, rumble_id.to_le_bytes().as_ref()],
        bump = combat_state.bump,
        constraint = combat_state.rumble_id == rumble_id @ RumbleError::InvalidRumble,
    )]
    pub combat_state: Account<'info, RumbleCombatState>,

    #[account(
        mut,
        seeds = [
            MOVE_COMMIT_SEED,
            rumble_id.to_le_bytes().as_ref(),
            fighter.key().as_ref(),
            turn.to_le_bytes().as_ref(),
        ],
        bump = move_commitment.bump,
        constraint = move_commitment.fighter == fighter.key() @ RumbleError::Unauthorized,
        constraint = move_commitment.rumble_id == rumble_id @ RumbleError::InvalidRumble,
        constraint = move_commitment.turn == turn @ RumbleError::InvalidTurn,
    )]
    pub move_commitment: Account<'info, MoveCommitment>,
}

#[cfg(feature = "combat")]
#[derive(Accounts)]
pub struct StartCombat<'info> {
    #[account(
        mut,
        constraint = admin.key() == config.admin @ RumbleError::Unauthorized,
    )]
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, RumbleConfig>,

    #[account(
        mut,
        seeds = [RUMBLE_SEED, rumble.id.to_le_bytes().as_ref()],
        bump = rumble.bump,
    )]
    pub rumble: Account<'info, Rumble>,

    #[account(
        init_if_needed,
        payer = admin,
        space = 8 + RumbleCombatState::INIT_SPACE,
        seeds = [COMBAT_STATE_SEED, rumble.id.to_le_bytes().as_ref()],
        bump
    )]
    pub combat_state: Account<'info, RumbleCombatState>,

    pub system_program: Program<'info, System>,
}

/// Permissionless combat action — open_turn, resolve_turn, advance_turn.
/// Anyone can call these; correctness is enforced by on-chain state machine.
#[cfg(feature = "combat")]
#[derive(Accounts)]
pub struct CombatAction<'info> {
    #[account(mut)]
    pub keeper: Signer<'info>,

    #[account(
        mut,
        seeds = [RUMBLE_SEED, rumble.id.to_le_bytes().as_ref()],
        bump = rumble.bump,
    )]
    pub rumble: Account<'info, Rumble>,

    #[account(
        mut,
        seeds = [COMBAT_STATE_SEED, rumble.id.to_le_bytes().as_ref()],
        bump = combat_state.bump,
        constraint = combat_state.rumble_id == rumble.id @ RumbleError::InvalidRumble,
    )]
    pub combat_state: Account<'info, RumbleCombatState>,
}

/// Admin-gated combat action — post_turn_result (hybrid mode).
/// Admin posts move results; damage is validated on-chain.
#[cfg(feature = "combat")]
#[derive(Accounts)]
pub struct AdminCombatAction<'info> {
    #[account(mut)]
    pub keeper: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = keeper.key() == config.admin @ RumbleError::Unauthorized,
    )]
    pub config: Account<'info, RumbleConfig>,

    #[account(
        mut,
        seeds = [RUMBLE_SEED, rumble.id.to_le_bytes().as_ref()],
        bump = rumble.bump,
    )]
    pub rumble: Account<'info, Rumble>,

    #[account(
        mut,
        seeds = [COMBAT_STATE_SEED, rumble.id.to_le_bytes().as_ref()],
        bump = combat_state.bump,
        constraint = combat_state.rumble_id == rumble.id @ RumbleError::InvalidRumble,
    )]
    pub combat_state: Account<'info, RumbleCombatState>,
}

/// Permissionless finalization — anyone can finalize when state machine allows it.
/// Correctness is enforced by on-chain combat state (winner, placements, timeouts).
#[cfg(feature = "combat")]
#[derive(Accounts)]
pub struct FinalizeRumble<'info> {
    #[account(mut)]
    pub keeper: Signer<'info>,

    #[account(
        mut,
        seeds = [RUMBLE_SEED, rumble.id.to_le_bytes().as_ref()],
        bump = rumble.bump,
    )]
    pub rumble: Account<'info, Rumble>,

    #[account(
        mut,
        seeds = [COMBAT_STATE_SEED, rumble.id.to_le_bytes().as_ref()],
        bump = combat_state.bump,
        constraint = combat_state.rumble_id == rumble.id @ RumbleError::InvalidRumble,
    )]
    pub combat_state: Account<'info, RumbleCombatState>,
}

#[derive(Accounts)]
#[instruction(rumble_id: u64, fighter_index: u8, amount: u64)]
pub struct PlaceBet<'info> {
    #[account(mut)]
    pub bettor: Signer<'info>,

    #[account(
        mut,
        seeds = [RUMBLE_SEED, rumble_id.to_le_bytes().as_ref()],
        bump = rumble.bump,
    )]
    pub rumble: Account<'info, Rumble>,

    /// Vault PDA that holds all bet SOL for this rumble.
    /// CHECK: PDA derived from vault seed + rumble_id. Just holds lamports.
    #[account(
        mut,
        seeds = [VAULT_SEED, rumble_id.to_le_bytes().as_ref()],
        bump
    )]
    pub vault: SystemAccount<'info>,

    /// CHECK: Treasury address, must match config.
    #[account(
        mut,
        constraint = treasury.key() == config.treasury @ RumbleError::InvalidTreasury,
    )]
    pub treasury: AccountInfo<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, RumbleConfig>,

    /// Sponsorship account PDA for the fighter being bet on.
    /// CHECK: PDA derived from sponsorship seed + fighter pubkey. Holds lamports.
    #[account(
        mut,
        seeds = [SPONSORSHIP_SEED, rumble.fighters[fighter_index as usize].as_ref()],
        bump
    )]
    pub sponsorship_account: SystemAccount<'info>,

    #[account(
        init_if_needed,
        payer = bettor,
        space = 8 + BettorAccount::INIT_SPACE,
        seeds = [BETTOR_SEED, rumble_id.to_le_bytes().as_ref(), bettor.key().as_ref()],
        bump
    )]
    pub bettor_account: Account<'info, BettorAccount>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminAction<'info> {
    #[account(
        mut,
        constraint = admin.key() == config.admin @ RumbleError::Unauthorized,
    )]
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, RumbleConfig>,

    #[account(
        mut,
        seeds = [RUMBLE_SEED, rumble.id.to_le_bytes().as_ref()],
        bump = rumble.bump,
    )]
    pub rumble: Account<'info, Rumble>,
}

#[derive(Accounts)]
pub struct ClaimPayout<'info> {
    #[account(mut)]
    pub bettor: Signer<'info>,

    #[account(
        seeds = [RUMBLE_SEED, rumble.id.to_le_bytes().as_ref()],
        bump = rumble.bump,
    )]
    pub rumble: Account<'info, Rumble>,

    /// CHECK: Vault PDA holding SOL for this rumble.
    #[account(
        mut,
        seeds = [VAULT_SEED, rumble.id.to_le_bytes().as_ref()],
        bump
    )]
    pub vault: SystemAccount<'info>,

    #[account(
        mut,
        seeds = [BETTOR_SEED, rumble.id.to_le_bytes().as_ref(), bettor.key().as_ref()],
        bump,
        owner = crate::ID,
    )]
    /// CHECK: Parsed manually to support legacy bettor layouts.
    pub bettor_account: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimSponsorship<'info> {
    #[account(mut)]
    pub fighter_owner: Signer<'info>,

    /// CHECK: The fighter account. Authority is verified in the instruction handler
    /// by reading bytes 8..40 (the authority pubkey after Anchor's 8-byte discriminator).
    #[account(
        constraint = fighter.owner == &FIGHTER_REGISTRY_PROGRAM_ID @ RumbleError::InvalidFighterAccount,
    )]
    pub fighter: AccountInfo<'info>,

    /// CHECK: Sponsorship PDA holding accumulated SOL.
    #[account(
        mut,
        seeds = [SPONSORSHIP_SEED, fighter.key().as_ref()],
        bump
    )]
    pub sponsorship_account: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SweepTreasury<'info> {
    #[account(
        mut,
        constraint = admin.key() == config.admin @ RumbleError::Unauthorized,
    )]
    pub admin: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, RumbleConfig>,

    #[account(
        seeds = [RUMBLE_SEED, rumble.id.to_le_bytes().as_ref()],
        bump = rumble.bump,
    )]
    pub rumble: Account<'info, Rumble>,

    /// CHECK: Vault PDA holding remaining SOL for this rumble.
    #[account(
        mut,
        seeds = [VAULT_SEED, rumble.id.to_le_bytes().as_ref()],
        bump
    )]
    pub vault: SystemAccount<'info>,

    /// CHECK: Treasury address, must match config.
    #[account(
        mut,
        constraint = treasury.key() == config.treasury @ RumbleError::InvalidTreasury,
    )]
    pub treasury: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[cfg(feature = "combat")]
#[derive(Accounts)]
#[instruction(rumble_id: u64, turn: u32)]
pub struct CloseMoveCommitment<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = admin.key() == config.admin @ RumbleError::Unauthorized,
    )]
    pub config: Account<'info, RumbleConfig>,

    #[account(
        seeds = [RUMBLE_SEED, rumble_id.to_le_bytes().as_ref()],
        bump = rumble.bump,
        constraint = (rumble.state == RumbleState::Combat || rumble.state == RumbleState::Payout || rumble.state == RumbleState::Complete) @ RumbleError::InvalidState,
    )]
    pub rumble: Account<'info, Rumble>,

    #[account(
        mut,
        close = destination,
        seeds = [
            MOVE_COMMIT_SEED,
            rumble_id.to_le_bytes().as_ref(),
            fighter.key().as_ref(),
            turn.to_le_bytes().as_ref(),
        ],
        bump = move_commitment.bump,
    )]
    pub move_commitment: Account<'info, MoveCommitment>,

    /// CHECK: Fighter pubkey used for PDA derivation.
    pub fighter: UncheckedAccount<'info>,

    /// CHECK: Destination for rent refund.
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct TransferAdmin<'info> {
    #[account(
        mut,
        constraint = admin.key() == config.admin @ RumbleError::Unauthorized,
    )]
    pub admin: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, RumbleConfig>,

    #[account(
        init_if_needed,
        payer = admin,
        space = 8 + PendingAdminRE::INIT_SPACE,
        seeds = [PENDING_ADMIN_SEED],
        bump
    )]
    pub pending_admin: Account<'info, PendingAdminRE>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    /// The proposed new admin must sign this transaction.
    #[account(mut)]
    pub new_admin: Signer<'info>,

    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, RumbleConfig>,

    #[account(
        seeds = [PENDING_ADMIN_SEED],
        bump = pending_admin.bump,
        constraint = pending_admin.proposed_admin == new_admin.key() @ RumbleError::Unauthorized,
    )]
    pub pending_admin: Account<'info, PendingAdminRE>,
}

#[derive(Accounts)]
pub struct UpdateTreasury<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = admin.key() == config.admin @ RumbleError::Unauthorized,
    )]
    pub config: Account<'info, RumbleConfig>,
}

#[derive(Accounts)]
pub struct CloseRumble<'info> {
    #[account(
        mut,
        constraint = admin.key() == config.admin @ RumbleError::Unauthorized,
    )]
    pub admin: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, RumbleConfig>,

    #[account(
        mut,
        close = admin,
        seeds = [RUMBLE_SEED, rumble.id.to_le_bytes().as_ref()],
        bump = rumble.bump,
    )]
    pub rumble: Account<'info, Rumble>,
}

#[cfg(feature = "combat")]
#[derive(Accounts)]
pub struct CloseCombatState<'info> {
    #[account(
        mut,
        constraint = admin.key() == config.admin @ RumbleError::Unauthorized,
    )]
    pub admin: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, RumbleConfig>,

    #[account(
        seeds = [RUMBLE_SEED, rumble.id.to_le_bytes().as_ref()],
        bump = rumble.bump,
    )]
    pub rumble: Account<'info, Rumble>,

    #[account(
        mut,
        close = admin,
        seeds = [COMBAT_STATE_SEED, rumble.id.to_le_bytes().as_ref()],
        bump = combat_state.bump,
        constraint = combat_state.rumble_id == rumble.id @ RumbleError::InvalidRumble,
    )]
    pub combat_state: Account<'info, RumbleCombatState>,
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct RumbleConfig {
    pub admin: Pubkey,      // 32
    pub treasury: Pubkey,   // 32
    pub total_rumbles: u64, // 8
    pub bump: u8,           // 1
}

#[account]
#[derive(InitSpace)]
pub struct Rumble {
    pub id: u64,                  // 8
    pub state: RumbleState,       // 1
    pub fighters: [Pubkey; 16],   // 32 * 16 = 512
    pub fighter_count: u8,        // 1
    pub betting_pools: [u64; 16], // 8 * 16 = 128
    pub total_deployed: u64,      // 8
    pub admin_fee_collected: u64, // 8
    pub sponsorship_paid: u64,    // 8
    pub placements: [u8; 16],     // 16
    pub winner_index: u8,         // 1
    pub betting_deadline: i64,    // 8
    pub combat_started_at: i64,   // 8
    pub completed_at: i64,        // 8
    pub bump: u8,                 // 1
}

#[account]
#[derive(InitSpace)]
pub struct BettorAccount {
    pub authority: Pubkey,                        // 32
    pub rumble_id: u64,                           // 8
    pub fighter_index: u8,                        // 1 (legacy compatibility)
    pub sol_deployed: u64,                        // 8 (total deployed across all fighters)
    pub claimable_lamports: u64,                  // 8
    pub total_claimed_lamports: u64,              // 8
    pub last_claim_ts: i64,                       // 8
    pub claimed: bool,                            // 1
    pub bump: u8,                                 // 1
    pub fighter_deployments: [u64; MAX_FIGHTERS], // 128
}

#[cfg(feature = "combat")]
#[account]
#[derive(InitSpace)]
pub struct MoveCommitment {
    pub rumble_id: u64,      // 8
    pub fighter: Pubkey,     // 32
    pub turn: u32,           // 4
    pub move_hash: [u8; 32], // 32
    pub revealed_move: u8,   // 1
    pub revealed: bool,      // 1
    pub committed_slot: u64, // 8
    pub revealed_slot: u64,  // 8
    pub bump: u8,            // 1
}

#[account]
#[derive(InitSpace)]
pub struct PendingAdminRE {
    pub proposed_admin: Pubkey, // 32
    pub proposed_at: u64,       // 8
    pub bump: u8,               // 1
}

#[cfg(feature = "combat")]
#[account]
#[derive(InitSpace)]
pub struct RumbleCombatState {
    pub rumble_id: u64,                         // 8
    pub fighter_count: u8,                      // 1
    pub current_turn: u32,                      // 4
    pub turn_open_slot: u64,                    // 8
    pub commit_close_slot: u64,                 // 8
    pub reveal_close_slot: u64,                 // 8
    pub turn_resolved: bool,                    // 1
    pub remaining_fighters: u8,                 // 1
    pub winner_index: u8,                       // 1 (255 until known)
    pub hp: [u16; MAX_FIGHTERS],                // 32
    pub meter: [u8; MAX_FIGHTERS],              // 16
    pub elimination_rank: [u8; MAX_FIGHTERS],   // 16
    pub total_damage_dealt: [u64; MAX_FIGHTERS], // 128
    pub total_damage_taken: [u64; MAX_FIGHTERS], // 128
    pub bump: u8,                               // 1
}

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum RumbleState {
    Betting,
    Combat,
    Payout,
    Complete,
}

impl Default for RumbleState {
    fn default() -> Self {
        RumbleState::Betting
    }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[event]
pub struct BetPlacedEvent {
    pub rumble_id: u64,
    pub bettor: Pubkey,
    pub fighter_index: u8,
    pub amount: u64,
    pub net_amount: u64,
}

#[cfg(feature = "combat")]
#[event]
pub struct CombatStartedEvent {
    pub rumble_id: u64,
    pub timestamp: i64,
}

#[cfg(feature = "combat")]
#[event]
pub struct ResultReportedEvent {
    pub rumble_id: u64,
    pub winner_index: u8,
    pub timestamp: i64,
}

#[event]
pub struct PayoutClaimedEvent {
    pub rumble_id: u64,
    pub bettor: Pubkey,
    pub fighter_index: u8,
    pub placement: u8,
    pub amount: u64,
}

#[cfg(feature = "combat")]
#[event]
pub struct MoveCommittedEvent {
    pub rumble_id: u64,
    pub fighter: Pubkey,
    pub turn: u32,
    pub committed_slot: u64,
}

#[cfg(feature = "combat")]
#[event]
pub struct MoveRevealedEvent {
    pub rumble_id: u64,
    pub fighter: Pubkey,
    pub turn: u32,
    pub move_code: u8,
    pub revealed_slot: u64,
}

#[cfg(feature = "combat")]
#[event]
pub struct TurnOpenedEvent {
    pub rumble_id: u64,
    pub turn: u32,
    pub turn_open_slot: u64,
    pub commit_close_slot: u64,
    pub reveal_close_slot: u64,
}

#[cfg(feature = "combat")]
#[event]
pub struct TurnPairResolvedEvent {
    pub rumble_id: u64,
    pub turn: u32,
    pub fighter_a: Pubkey,
    pub fighter_b: Pubkey,
    pub move_a: u8,
    pub move_b: u8,
    pub damage_to_a: u16,
    pub damage_to_b: u16,
}

#[cfg(feature = "combat")]
#[event]
pub struct TurnResolvedEvent {
    pub rumble_id: u64,
    pub turn: u32,
    pub remaining_fighters: u8,
}

#[cfg(feature = "combat")]
#[event]
pub struct OnchainResultFinalizedEvent {
    pub rumble_id: u64,
    pub winner_index: u8,
    pub timestamp: i64,
}

#[event]
pub struct SponsorshipClaimedEvent {
    pub fighter_owner: Pubkey,
    pub fighter: Pubkey,
    pub amount: u64,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum RumbleError {
    #[msg("Unauthorized: only admin can perform this action")]
    Unauthorized,

    #[msg("Betting is closed for this rumble")]
    BettingClosed,

    #[msg("Betting period has not ended yet")]
    BettingNotEnded,

    #[msg("Invalid state transition")]
    InvalidStateTransition,

    #[msg("Invalid fighter index")]
    InvalidFighterIndex,

    #[msg("Invalid fighter count: must be between 2 and 16")]
    InvalidFighterCount,

    #[msg("Invalid placement data")]
    InvalidPlacement,

    #[msg("Bet amount must be greater than zero")]
    ZeroBetAmount,

    #[msg("Payout already claimed")]
    AlreadyClaimed,

    #[msg("Payout is not ready yet")]
    PayoutNotReady,

    #[msg("Fighter did not win (winner-takes-all)")]
    NotInPayoutRange,

    #[msg("Math overflow")]
    MathOverflow,

    #[msg("Insufficient funds in vault")]
    InsufficientVaultFunds,

    #[msg("Invalid treasury address")]
    InvalidTreasury,

    #[msg("Invalid rumble ID mismatch")]
    InvalidRumble,

    #[msg("Nothing to claim")]
    NothingToClaim,

    #[msg("Betting deadline must be in the future")]
    DeadlineInPast,

    #[msg("Invalid fighter account data")]
    InvalidFighterAccount,

    #[msg("Payout claim window is still active")]
    ClaimWindowActive,

    #[msg("Invalid bettor account data")]
    InvalidBettorAccount,

    #[msg("Invalid turn index")]
    InvalidTurn,

    #[msg("Invalid move commitment")]
    InvalidMoveCommitment,

    #[msg("Invalid move code")]
    InvalidMoveCode,

    #[msg("Move already revealed")]
    AlreadyRevealedMove,

    #[msg("Turn is already open")]
    TurnAlreadyOpen,

    #[msg("Turn is not open")]
    TurnNotOpen,

    #[msg("Turn already resolved")]
    TurnAlreadyResolved,

    #[msg("Turn is not resolved yet")]
    TurnNotResolved,

    #[msg("Commit window is closed")]
    CommitWindowClosed,

    #[msg("Reveal window is closed")]
    RevealWindowClosed,

    #[msg("Reveal window is still active")]
    RevealWindowActive,

    #[msg("Combat already finished")]
    CombatAlreadyFinished,

    #[msg("Combat is still active")]
    CombatStillActive,

    #[msg("Max combat turns reached")]
    MaxTurnsReached,

    #[msg("Instruction is deprecated")]
    DeprecatedInstruction,

    #[msg("Duplicate fighter in rumble")]
    DuplicateFighter,

    #[msg("Invalid rumble state for this operation")]
    InvalidState,

    #[msg("Fighter has been eliminated")]
    FighterEliminated,

    #[msg("Invalid fighter accounts provided")]
    InvalidFighterAccounts,

    #[msg("Posted damage does not match resolve_duel computation")]
    DamageMismatch,

    #[msg("Invalid new admin address")]
    InvalidNewAdmin,
}
