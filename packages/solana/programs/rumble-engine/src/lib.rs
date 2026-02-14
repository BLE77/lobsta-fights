use anchor_lang::prelude::*;
use anchor_lang::system_program;

declare_id!("2TvW4EfbmMe566ZQWZWd8kX34iFR2DM3oBUpjwpRJcqC");

/// Maximum fighters per rumble
const MAX_FIGHTERS: usize = 16;

/// PDA seeds
const RUMBLE_SEED: &[u8] = b"rumble";
const VAULT_SEED: &[u8] = b"vault";
const BETTOR_SEED: &[u8] = b"bettor";
const CONFIG_SEED: &[u8] = b"rumble_config";
const SPONSORSHIP_SEED: &[u8] = b"sponsorship";
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

/// Claim window after report_result before admin can finalize/sweep.
const PAYOUT_CLAIM_WINDOW_SECONDS: i64 = 30;

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
    // Legacy V1 minimum: discriminator + authority + rumble_id + fighter_index + sol_deployed + claimed + bump
    const LEGACY_V1_LEN: usize = 8 + 32 + 8 + 1 + 8 + 1 + 1; // 59
                                                             // Legacy V2 minimum: discriminator + authority + rumble_id + fighter_index + sol_deployed
                                                             // + claimable + total_claimed + last_claim_ts + claimed + bump
    const LEGACY_V2_LEN: usize = 8 + 32 + 8 + 1 + 8 + 8 + 8 + 8 + 1 + 1; // 83
    const CURRENT_LEN: usize = 8 + BettorAccount::INIT_SPACE; // 211

    require!(
        data.len() >= LEGACY_V1_LEN,
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

    let (claimable_lamports, total_claimed_lamports, last_claim_ts, claimed, bump) =
        if data.len() >= LEGACY_V2_LEN {
            let claimable = read_u64_le(data, &mut offset)?;
            let total_claimed = read_u64_le(data, &mut offset)?;
            let last_claim = read_i64_le(data, &mut offset)?;
            let claimed = *data.get(offset).ok_or(RumbleError::InvalidBettorAccount)? == 1;
            offset += 1;
            let bump = *data.get(offset).ok_or(RumbleError::InvalidBettorAccount)?;
            offset += 1;
            (claimable, total_claimed, last_claim, claimed, bump)
        } else {
            let claimed = *data.get(offset).ok_or(RumbleError::InvalidBettorAccount)? == 1;
            offset += 1;
            let bump = *data.get(offset).ok_or(RumbleError::InvalidBettorAccount)?;
            offset += 1;
            (0u64, 0u64, 0i64, claimed, bump)
        };

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
    const LEGACY_V1_LEN: usize = 8 + 32 + 8 + 1 + 8 + 1 + 1; // 59
    const LEGACY_V2_LEN: usize = 8 + 32 + 8 + 1 + 8 + 8 + 8 + 8 + 1 + 1; // 83
    const CURRENT_LEN: usize = 8 + BettorAccount::INIT_SPACE; // 211

    require!(
        data.len() >= LEGACY_V1_LEN,
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

    if data.len() >= LEGACY_V2_LEN {
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
    } else {
        data[offset] = if bettor.claimed { 1 } else { 0 };
        offset += 1;
        data[offset] = bettor.bump;
    }

    Ok(())
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

    /// Create a new rumble with a list of fighters and a betting deadline.
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

        let clock = Clock::get()?;
        require!(
            betting_deadline > clock.unix_timestamp,
            RumbleError::DeadlineInPast
        );

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

        // Validate deadline
        let clock = Clock::get()?;
        require!(
            clock.unix_timestamp < rumble.betting_deadline,
            RumbleError::BettingClosed
        );

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

    /// Transition rumble from Betting to Combat.
    /// Only callable by admin after the betting deadline.
    pub fn start_combat(ctx: Context<AdminAction>) -> Result<()> {
        let rumble = &mut ctx.accounts.rumble;

        require!(
            rumble.state == RumbleState::Betting,
            RumbleError::InvalidStateTransition
        );

        let clock = Clock::get()?;
        require!(
            clock.unix_timestamp >= rumble.betting_deadline,
            RumbleError::BettingNotEnded
        );

        rumble.state = RumbleState::Combat;
        rumble.combat_started_at = clock.unix_timestamp;

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

    /// Report the final result of a rumble.
    /// Admin submits placements (1st through last). Transitions to Payout state.
    /// placements[i] = the placement (1-indexed) of fighter at index i.
    /// e.g. placements[0] = 1 means fighter 0 came in 1st place.
    pub fn report_result(
        ctx: Context<AdminAction>,
        placements: Vec<u8>,
        winner_index: u8,
    ) -> Result<()> {
        let rumble = &mut ctx.accounts.rumble;

        require!(
            rumble.state == RumbleState::Combat,
            RumbleError::InvalidStateTransition
        );

        require!(
            placements.len() == rumble.fighter_count as usize,
            RumbleError::InvalidPlacement
        );

        require!(
            (winner_index as usize) < rumble.fighter_count as usize,
            RumbleError::InvalidFighterIndex
        );

        // Validate that winner_index has placement == 1
        require!(
            placements[winner_index as usize] == 1,
            RumbleError::InvalidPlacement
        );

        // Copy placements into fixed-size array
        let mut placement_arr = [0u8; MAX_FIGHTERS];
        let mut seen_placements = vec![false; rumble.fighter_count as usize + 1];
        for (i, p) in placements.iter().enumerate() {
            require!(
                *p >= 1 && *p <= rumble.fighter_count,
                RumbleError::InvalidPlacement
            );
            let placement_idx = *p as usize;
            require!(
                !seen_placements[placement_idx],
                RumbleError::InvalidPlacement
            );
            seen_placements[placement_idx] = true;
            placement_arr[i] = *p;
        }

        rumble.placements = placement_arr;
        rumble.winner_index = winner_index;
        rumble.state = RumbleState::Payout;

        let clock = Clock::get()?;
        rumble.completed_at = clock.unix_timestamp;

        msg!(
            "Rumble {} result reported. Winner: fighter #{}",
            rumble.id,
            winner_index
        );

        emit!(ResultReportedEvent {
            rumble_id: rumble.id,
            winner_index,
            timestamp: clock.unix_timestamp,
        });

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
            let winnings = if first_pool > 0 {
                place_allocation
                    .checked_mul(winning_deployed)
                    .ok_or(RumbleError::MathOverflow)?
                    .checked_div(first_pool)
                    .ok_or(RumbleError::MathOverflow)?
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

#[event]
pub struct CombatStartedEvent {
    pub rumble_id: u64,
    pub timestamp: i64,
}

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
}
