use anchor_lang::prelude::*;
use anchor_lang::system_program;

declare_id!("11111111111111111111111111111111");

/// Maximum fighters per rumble
const MAX_FIGHTERS: usize = 16;

/// PDA seeds
const RUMBLE_SEED: &[u8] = b"rumble";
const VAULT_SEED: &[u8] = b"vault";
const BETTOR_SEED: &[u8] = b"bettor";
const CONFIG_SEED: &[u8] = b"rumble_config";
const SPONSORSHIP_SEED: &[u8] = b"sponsorship";

/// Fee basis points (out of 10_000)
const ADMIN_FEE_BPS: u64 = 100; // 1%
const SPONSORSHIP_FEE_BPS: u64 = 500; // 5%

/// Payout splits for placing bettors (out of losers' pool after treasury cut)
const FIRST_PLACE_BPS: u64 = 7_000; // 70%
const SECOND_PLACE_BPS: u64 = 2_000; // 20%
const THIRD_PLACE_BPS: u64 = 1_000; // 10%

/// Treasury cut from losers' pool before payout distribution
const TREASURY_CUT_BPS: u64 = 1_000; // 10%

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

        msg!("Rumble {} created with {} fighters", rumble_id, fighters.len());
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

        // Initialize bettor account
        let bettor_account = &mut ctx.accounts.bettor_account;
        bettor_account.authority = ctx.accounts.bettor.key();
        bettor_account.rumble_id = rumble_id;
        bettor_account.fighter_index = fighter_index;
        bettor_account.sol_deployed = net_bet;
        bettor_account.claimed = false;
        bettor_account.bump = ctx.bumps.bettor_account;

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

    /// Transition rumble from Betting to Active (combat).
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

        rumble.state = RumbleState::Active;
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
            rumble.state == RumbleState::Active,
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
        for (i, p) in placements.iter().enumerate() {
            require!(*p >= 1 && *p <= rumble.fighter_count, RumbleError::InvalidPlacement);
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

    /// Bettor claims their payout if their fighter placed 1st, 2nd, or 3rd.
    ///
    /// Payout logic:
    /// 1. Sum all pools for fighters that did NOT place 1st, 2nd, or 3rd = losers_pool
    /// 2. Treasury cut = 10% of losers_pool
    /// 3. Distributable = losers_pool - treasury_cut
    /// 4. 1st place bettors split 70% of distributable
    /// 5. 2nd place bettors split 20% of distributable
    /// 6. 3rd place bettors split 10% of distributable
    /// 7. Each bettor gets their original bet back + proportional share of their place's split
    pub fn claim_payout(ctx: Context<ClaimPayout>) -> Result<()> {
        let bettor_account = &mut ctx.accounts.bettor_account;
        let rumble = &ctx.accounts.rumble;

        require!(
            rumble.state == RumbleState::Payout || rumble.state == RumbleState::Complete,
            RumbleError::PayoutNotReady
        );

        require!(!bettor_account.claimed, RumbleError::AlreadyClaimed);

        require!(
            bettor_account.authority == ctx.accounts.bettor.key(),
            RumbleError::Unauthorized
        );

        let fighter_idx = bettor_account.fighter_index as usize;
        let placement = rumble.placements[fighter_idx];

        // Only 1st, 2nd, 3rd place get payouts (plus their original bet back)
        // Losers can still claim if they want, but get 0 (we refund nothing for losers)
        require!(
            placement >= 1 && placement <= 3,
            RumbleError::NotInPayoutRange
        );

        // Calculate losers' pool (sum of pools for fighters not in top 3)
        let mut losers_pool: u64 = 0;
        let mut first_pool: u64 = 0;
        let mut second_pool: u64 = 0;
        let mut third_pool: u64 = 0;

        for i in 0..rumble.fighter_count as usize {
            let p = rumble.placements[i];
            let pool = rumble.betting_pools[i];
            match p {
                1 => first_pool = first_pool.checked_add(pool).ok_or(RumbleError::MathOverflow)?,
                2 => second_pool = second_pool.checked_add(pool).ok_or(RumbleError::MathOverflow)?,
                3 => third_pool = third_pool.checked_add(pool).ok_or(RumbleError::MathOverflow)?,
                _ => losers_pool = losers_pool.checked_add(pool).ok_or(RumbleError::MathOverflow)?,
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

        // Determine this bettor's share
        let (place_share_bps, place_total_pool) = match placement {
            1 => (FIRST_PLACE_BPS, first_pool),
            2 => (SECOND_PLACE_BPS, second_pool),
            3 => (THIRD_PLACE_BPS, third_pool),
            _ => return err!(RumbleError::NotInPayoutRange),
        };

        // This place's total allocation from distributable
        let place_allocation = distributable
            .checked_mul(place_share_bps)
            .ok_or(RumbleError::MathOverflow)?
            .checked_div(10_000)
            .ok_or(RumbleError::MathOverflow)?;

        // Bettor's proportional share of their place's allocation
        // share = (bettor_deployed / place_total_pool) * place_allocation
        let winnings = if place_total_pool > 0 {
            place_allocation
                .checked_mul(bettor_account.sol_deployed)
                .ok_or(RumbleError::MathOverflow)?
                .checked_div(place_total_pool)
                .ok_or(RumbleError::MathOverflow)?
        } else {
            0
        };

        // Total payout = original bet + winnings from losers' pool
        let total_payout = bettor_account
            .sol_deployed
            .checked_add(winnings)
            .ok_or(RumbleError::MathOverflow)?;

        // Transfer SOL from vault PDA to bettor.
        // Since vault is a PDA that holds SOL (not a token account),
        // we transfer lamports directly by mutating account balances.
        if total_payout > 0 {
            let vault_info = ctx.accounts.vault.to_account_info();
            let bettor_info = ctx.accounts.bettor.to_account_info();

            **vault_info.try_borrow_mut_lamports()? = vault_info
                .lamports()
                .checked_sub(total_payout)
                .ok_or(RumbleError::InsufficientVaultFunds)?;
            **bettor_info.try_borrow_mut_lamports()? = bettor_info
                .lamports()
                .checked_add(total_payout)
                .ok_or(RumbleError::MathOverflow)?;
        }

        bettor_account.claimed = true;

        msg!(
            "Payout claimed: {} lamports (bet: {}, winnings: {}) for rumble {}",
            total_payout,
            bettor_account.sol_deployed,
            winnings,
            rumble.id
        );

        emit!(PayoutClaimedEvent {
            rumble_id: rumble.id,
            bettor: ctx.accounts.bettor.key(),
            fighter_index: bettor_account.fighter_index,
            placement,
            amount: total_payout,
        });

        Ok(())
    }

    /// Fighter owner claims accumulated sponsorship revenue.
    /// Drains the sponsorship PDA balance to the fighter owner.
    pub fn claim_sponsorship_revenue(ctx: Context<ClaimSponsorship>) -> Result<()> {
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

        **sponsorship_info.try_borrow_mut_lamports()? = min_balance;
        **owner_info.try_borrow_mut_lamports()? = owner_info
            .lamports()
            .checked_add(available)
            .ok_or(RumbleError::MathOverflow)?;

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

        rumble.state = RumbleState::Complete;

        let config = &mut ctx.accounts.config;
        config.total_rumbles = config
            .total_rumbles
            .checked_add(1)
            .ok_or(RumbleError::MathOverflow)?;

        msg!("Rumble {} completed", rumble.id);
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
        init,
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
        bump = bettor_account.bump,
        constraint = bettor_account.authority == bettor.key() @ RumbleError::Unauthorized,
        constraint = bettor_account.rumble_id == rumble.id @ RumbleError::InvalidRumble,
    )]
    pub bettor_account: Account<'info, BettorAccount>,
}

#[derive(Accounts)]
pub struct ClaimSponsorship<'info> {
    #[account(mut)]
    pub fighter_owner: Signer<'info>,

    /// CHECK: The fighter pubkey, used to derive the sponsorship PDA.
    pub fighter: AccountInfo<'info>,

    /// CHECK: Sponsorship PDA holding accumulated SOL.
    #[account(
        mut,
        seeds = [SPONSORSHIP_SEED, fighter.key().as_ref()],
        bump
    )]
    pub sponsorship_account: SystemAccount<'info>,
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct RumbleConfig {
    pub admin: Pubkey,       // 32
    pub treasury: Pubkey,    // 32
    pub total_rumbles: u64,  // 8
    pub bump: u8,            // 1
}

#[account]
#[derive(InitSpace)]
pub struct Rumble {
    pub id: u64,                         // 8
    pub state: RumbleState,              // 1
    pub fighters: [Pubkey; 16],          // 32 * 16 = 512
    pub fighter_count: u8,               // 1
    pub betting_pools: [u64; 16],        // 8 * 16 = 128
    pub total_deployed: u64,             // 8
    pub admin_fee_collected: u64,        // 8
    pub sponsorship_paid: u64,           // 8
    pub placements: [u8; 16],            // 16
    pub winner_index: u8,                // 1
    pub betting_deadline: i64,                // 8
    pub combat_started_at: i64,               // 8
    pub completed_at: i64,                    // 8
    pub bump: u8,                             // 1
}

#[account]
#[derive(InitSpace)]
pub struct BettorAccount {
    pub authority: Pubkey,    // 32
    pub rumble_id: u64,       // 8
    pub fighter_index: u8,    // 1
    pub sol_deployed: u64,    // 8
    pub claimed: bool,        // 1
    pub bump: u8,             // 1
}

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum RumbleState {
    Betting,
    Active,
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

    #[msg("Fighter did not place in top 3")]
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
}
