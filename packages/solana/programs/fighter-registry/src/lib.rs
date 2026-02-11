use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount};

declare_id!("2hA6Jvj1yjP2Uj3qrJcsBeYA2R9xPM95mDKw1ncKVExa");

/// 1 ICHOR in smallest unit (9 decimals)
const ONE_ICHOR: u64 = 1_000_000_000;

/// Cost to register additional fighters (2nd through 5th): 10 ICHOR
const ADDITIONAL_FIGHTER_COST: u64 = 10 * ONE_ICHOR;

/// Transfer fee: 5% of 1 ICHOR (burned)
const TRANSFER_FEE: u64 = ONE_ICHOR / 20;

/// Maximum fighters per wallet
const MAX_FIGHTERS_PER_WALLET: u8 = 5;

/// PDA seeds
const FIGHTER_SEED: &[u8] = b"fighter";
const WALLET_STATE_SEED: &[u8] = b"wallet_state";
const REGISTRY_SEED: &[u8] = b"registry_config";

#[program]
pub mod fighter_registry {
    use super::*;

    /// Initialize the registry configuration. Called once by admin.
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let config = &mut ctx.accounts.registry_config;
        config.admin = ctx.accounts.admin.key();
        config.total_fighters = 0;
        config.bump = ctx.bumps.registry_config;

        msg!("Fighter registry initialized");
        Ok(())
    }

    /// Register a new fighter for the calling wallet.
    /// First fighter per wallet is free; additional fighters cost 10 ICHOR (burned).
    pub fn register_fighter(
        ctx: Context<RegisterFighter>,
        name: [u8; 32],
    ) -> Result<()> {
        let wallet_state = &mut ctx.accounts.wallet_state;
        let fighter = &mut ctx.accounts.fighter;
        let config = &mut ctx.accounts.registry_config;

        // Initialize wallet_state on first use
        if wallet_state.authority == Pubkey::default() {
            wallet_state.authority = ctx.accounts.authority.key();
            wallet_state.bump = ctx.bumps.wallet_state;
        }

        let fighter_index = wallet_state.fighter_count;
        require!(
            fighter_index < MAX_FIGHTERS_PER_WALLET,
            RegistryError::MaxFightersReached
        );

        // Additional fighters (index >= 1) require burning 10 ICHOR
        if fighter_index > 0 {
            let ichor_token_account = ctx
                .accounts
                .ichor_token_account
                .as_ref()
                .ok_or(RegistryError::IchorAccountRequired)?;
            let ichor_mint = ctx
                .accounts
                .ichor_mint
                .as_ref()
                .ok_or(RegistryError::IchorAccountRequired)?;
            let token_program = ctx
                .accounts
                .token_program
                .as_ref()
                .ok_or(RegistryError::IchorAccountRequired)?;

            require!(
                ichor_token_account.amount >= ADDITIONAL_FIGHTER_COST,
                RegistryError::InsufficientIchor
            );

            token::burn(
                CpiContext::new(
                    token_program.to_account_info(),
                    Burn {
                        mint: ichor_mint.to_account_info(),
                        from: ichor_token_account.to_account_info(),
                        authority: ctx.accounts.authority.to_account_info(),
                    },
                ),
                ADDITIONAL_FIGHTER_COST,
            )?;

            msg!("Burned {} ICHOR for additional fighter", ADDITIONAL_FIGHTER_COST);
        }

        // Initialize fighter account
        let clock = Clock::get()?;
        fighter.authority = ctx.accounts.authority.key();
        fighter.name = name;
        fighter.created_at = clock.unix_timestamp;
        fighter.wins = 0;
        fighter.losses = 0;
        fighter.total_damage_dealt = 0;
        fighter.total_damage_taken = 0;
        fighter.total_rumbles = 0;
        fighter.current_streak = 0;
        fighter.best_streak = 0;
        fighter.total_ichor_mined = 0;
        fighter.unclaimed_ichor = 0;
        fighter.sponsorship_earned = 0;
        fighter.queue_position = None;
        fighter.auto_requeue = false;
        fighter.in_rumble = false;
        fighter.fighter_index = fighter_index;
        fighter.bump = ctx.bumps.fighter;

        // Update wallet and global state
        wallet_state.fighter_count = fighter_index
            .checked_add(1)
            .ok_or(RegistryError::MathOverflow)?;
        config.total_fighters = config
            .total_fighters
            .checked_add(1)
            .ok_or(RegistryError::MathOverflow)?;

        msg!(
            "Fighter #{} registered for wallet {}. Total fighters: {}",
            fighter_index,
            ctx.accounts.authority.key(),
            config.total_fighters
        );
        Ok(())
    }

    /// Update a fighter's combat record after a Rumble. Admin/engine only.
    pub fn update_record(
        ctx: Context<UpdateRecord>,
        wins: u64,
        losses: u64,
        damage_dealt: u64,
        damage_taken: u64,
        ichor_mined: u64,
        rumble_id: u64,
    ) -> Result<()> {
        let fighter = &mut ctx.accounts.fighter;
        let clock = Clock::get()?;

        fighter.wins = fighter
            .wins
            .checked_add(wins)
            .ok_or(RegistryError::MathOverflow)?;
        fighter.losses = fighter
            .losses
            .checked_add(losses)
            .ok_or(RegistryError::MathOverflow)?;
        fighter.total_damage_dealt = fighter
            .total_damage_dealt
            .checked_add(damage_dealt)
            .ok_or(RegistryError::MathOverflow)?;
        fighter.total_damage_taken = fighter
            .total_damage_taken
            .checked_add(damage_taken)
            .ok_or(RegistryError::MathOverflow)?;
        fighter.total_rumbles = fighter
            .total_rumbles
            .checked_add(1)
            .ok_or(RegistryError::MathOverflow)?;
        fighter.total_ichor_mined = fighter
            .total_ichor_mined
            .checked_add(ichor_mined)
            .ok_or(RegistryError::MathOverflow)?;

        // Update streak
        if wins > 0 {
            // Won this rumble
            if fighter.current_streak >= 0 {
                fighter.current_streak = fighter
                    .current_streak
                    .checked_add(1)
                    .ok_or(RegistryError::MathOverflow)?;
            } else {
                fighter.current_streak = 1;
            }
            // Update best streak
            let streak_unsigned = fighter.current_streak as u64;
            if streak_unsigned > fighter.best_streak {
                fighter.best_streak = streak_unsigned;
            }
        } else if losses > 0 {
            // Lost this rumble
            if fighter.current_streak <= 0 {
                fighter.current_streak = fighter
                    .current_streak
                    .checked_sub(1)
                    .ok_or(RegistryError::MathOverflow)?;
            } else {
                fighter.current_streak = -1;
            }
        }

        fighter.last_rumble_id = rumble_id;
        fighter.last_rumble_at = clock.unix_timestamp;

        msg!(
            "Fighter record updated: {}W-{}L, streak: {}, rumble #{}",
            fighter.wins,
            fighter.losses,
            fighter.current_streak,
            rumble_id
        );
        Ok(())
    }

    /// Fighter joins the Rumble queue.
    pub fn join_queue(
        ctx: Context<JoinQueue>,
        queue_position: u64,
        auto_requeue: bool,
    ) -> Result<()> {
        let fighter = &mut ctx.accounts.fighter;

        require!(
            fighter.queue_position.is_none(),
            RegistryError::AlreadyQueued
        );
        require!(!fighter.in_rumble, RegistryError::InRumble);

        fighter.queue_position = Some(queue_position);
        fighter.auto_requeue = auto_requeue;

        msg!(
            "Fighter joined queue at position {}. Auto-requeue: {}",
            queue_position,
            auto_requeue
        );
        Ok(())
    }

    /// Fighter leaves the Rumble queue.
    pub fn leave_queue(ctx: Context<LeaveQueue>) -> Result<()> {
        let fighter = &mut ctx.accounts.fighter;

        require!(
            fighter.queue_position.is_some(),
            RegistryError::NotInQueue
        );
        require!(!fighter.in_rumble, RegistryError::InRumble);

        fighter.queue_position = None;
        fighter.auto_requeue = false;

        msg!("Fighter left queue");
        Ok(())
    }

    /// Transfer a fighter's authority to a new wallet. Requires burning a 5% ICHOR fee.
    pub fn transfer_fighter(ctx: Context<TransferFighter>) -> Result<()> {
        let fighter = &mut ctx.accounts.fighter;

        require!(
            fighter.queue_position.is_none(),
            RegistryError::MustLeaveQueueFirst
        );
        require!(!fighter.in_rumble, RegistryError::InRumble);

        // Burn transfer fee
        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.ichor_mint.to_account_info(),
                    from: ctx.accounts.ichor_token_account.to_account_info(),
                    authority: ctx.accounts.old_authority.to_account_info(),
                },
            ),
            TRANSFER_FEE,
        )?;

        // Update wallet states
        let old_wallet = &mut ctx.accounts.old_wallet_state;
        let new_wallet = &mut ctx.accounts.new_wallet_state;

        require!(
            new_wallet.fighter_count < MAX_FIGHTERS_PER_WALLET,
            RegistryError::MaxFightersReached
        );

        old_wallet.fighter_count = old_wallet
            .fighter_count
            .checked_sub(1)
            .ok_or(RegistryError::MathOverflow)?;
        new_wallet.fighter_count = new_wallet
            .fighter_count
            .checked_add(1)
            .ok_or(RegistryError::MathOverflow)?;

        // Transfer authority
        let old_key = fighter.authority;
        fighter.authority = ctx.accounts.new_authority.key();
        fighter.fighter_index = new_wallet
            .fighter_count
            .checked_sub(1)
            .ok_or(RegistryError::MathOverflow)?;

        msg!(
            "Fighter transferred from {} to {}. Fee: {} ICHOR burned",
            old_key,
            fighter.authority,
            TRANSFER_FEE
        );
        Ok(())
    }

    /// Admin: update the admin key in registry config.
    pub fn update_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
        let config = &mut ctx.accounts.registry_config;
        config.admin = new_admin;
        msg!("Admin updated to {}", new_admin);
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = 8 + RegistryConfig::INIT_SPACE,
        seeds = [REGISTRY_SEED],
        bump
    )]
    pub registry_config: Account<'info, RegistryConfig>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RegisterFighter<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + WalletState::INIT_SPACE,
        seeds = [WALLET_STATE_SEED, authority.key().as_ref()],
        bump
    )]
    pub wallet_state: Account<'info, WalletState>,

    #[account(
        init,
        payer = authority,
        space = 8 + Fighter::INIT_SPACE,
        seeds = [FIGHTER_SEED, authority.key().as_ref(), &[wallet_state.fighter_count]],
        bump
    )]
    pub fighter: Account<'info, Fighter>,

    #[account(
        mut,
        seeds = [REGISTRY_SEED],
        bump = registry_config.bump,
    )]
    pub registry_config: Account<'info, RegistryConfig>,

    // Optional: required when registering 2nd+ fighter (for ICHOR burn)
    #[account(
        mut,
        token::authority = authority,
    )]
    pub ichor_token_account: Option<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub ichor_mint: Option<Account<'info, Mint>>,

    pub token_program: Option<Program<'info, Token>>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateRecord<'info> {
    /// Only admin/engine can update records.
    #[account(
        constraint = authority.key() == registry_config.admin @ RegistryError::Unauthorized,
    )]
    pub authority: Signer<'info>,

    #[account(
        seeds = [REGISTRY_SEED],
        bump = registry_config.bump,
    )]
    pub registry_config: Account<'info, RegistryConfig>,

    #[account(mut)]
    pub fighter: Account<'info, Fighter>,
}

#[derive(Accounts)]
pub struct JoinQueue<'info> {
    /// Fighter's current authority must sign.
    #[account(
        constraint = authority.key() == fighter.authority @ RegistryError::Unauthorized,
    )]
    pub authority: Signer<'info>,

    #[account(mut)]
    pub fighter: Account<'info, Fighter>,
}

#[derive(Accounts)]
pub struct LeaveQueue<'info> {
    /// Fighter's current authority must sign.
    #[account(
        constraint = authority.key() == fighter.authority @ RegistryError::Unauthorized,
    )]
    pub authority: Signer<'info>,

    #[account(mut)]
    pub fighter: Account<'info, Fighter>,
}

#[derive(Accounts)]
pub struct TransferFighter<'info> {
    /// Current owner must sign.
    #[account(
        mut,
        constraint = old_authority.key() == fighter.authority @ RegistryError::Unauthorized,
    )]
    pub old_authority: Signer<'info>,

    /// CHECK: New authority; does not need to sign (just a destination pubkey).
    pub new_authority: AccountInfo<'info>,

    #[account(mut)]
    pub fighter: Account<'info, Fighter>,

    #[account(
        mut,
        seeds = [WALLET_STATE_SEED, old_authority.key().as_ref()],
        bump = old_wallet_state.bump,
    )]
    pub old_wallet_state: Account<'info, WalletState>,

    #[account(
        init_if_needed,
        payer = old_authority,
        space = 8 + WalletState::INIT_SPACE,
        seeds = [WALLET_STATE_SEED, new_authority.key().as_ref()],
        bump
    )]
    pub new_wallet_state: Account<'info, WalletState>,

    // ICHOR burn for transfer fee
    #[account(mut)]
    pub ichor_mint: Account<'info, Mint>,

    #[account(
        mut,
        token::mint = ichor_mint,
        token::authority = old_authority,
    )]
    pub ichor_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(
        constraint = authority.key() == registry_config.admin @ RegistryError::Unauthorized,
    )]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [REGISTRY_SEED],
        bump = registry_config.bump,
    )]
    pub registry_config: Account<'info, RegistryConfig>,
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct RegistryConfig {
    pub admin: Pubkey,        // 32
    pub total_fighters: u64,  // 8
    pub bump: u8,             // 1
}

#[account]
#[derive(InitSpace)]
pub struct WalletState {
    pub authority: Pubkey,    // 32
    pub fighter_count: u8,    // 1
    pub bump: u8,             // 1
}

#[account]
#[derive(InitSpace)]
pub struct Fighter {
    pub authority: Pubkey,           // 32
    pub name: [u8; 32],             // 32
    pub created_at: i64,            // 8
    // Combat record
    pub wins: u64,                  // 8
    pub losses: u64,                // 8
    pub total_damage_dealt: u64,    // 8
    pub total_damage_taken: u64,    // 8
    pub total_rumbles: u64,         // 8
    pub current_streak: i64,        // 8 (positive = win streak, negative = loss streak)
    pub best_streak: u64,           // 8
    // Economy
    pub total_ichor_mined: u64,     // 8
    pub unclaimed_ichor: u64,       // 8
    pub sponsorship_earned: u64,    // 8
    // Queue
    pub queue_position: Option<u64>, // 1 + 8 = 9
    pub auto_requeue: bool,         // 1
    pub in_rumble: bool,            // 1
    // Meta
    pub last_rumble_id: u64,        // 8
    pub last_rumble_at: i64,        // 8
    pub fighter_index: u8,          // 1
    pub bump: u8,                   // 1
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[event]
pub struct FighterRegistered {
    pub authority: Pubkey,
    pub fighter_index: u8,
    pub name: [u8; 32],
}

#[event]
pub struct FighterTransferred {
    pub from: Pubkey,
    pub to: Pubkey,
    pub fee_burned: u64,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum RegistryError {
    #[msg("Maximum of 5 fighters per wallet")]
    MaxFightersReached,

    #[msg("Insufficient ICHOR to register additional fighter (10 ICHOR required)")]
    InsufficientIchor,

    #[msg("ICHOR token account required for additional fighter registration")]
    IchorAccountRequired,

    #[msg("Unauthorized: only the fighter's authority or admin can perform this action")]
    Unauthorized,

    #[msg("Fighter is already in the queue")]
    AlreadyQueued,

    #[msg("Fighter is not in the queue")]
    NotInQueue,

    #[msg("Fighter is currently in a rumble")]
    InRumble,

    #[msg("Fighter must leave queue before transfer")]
    MustLeaveQueueFirst,

    #[msg("Math overflow")]
    MathOverflow,
}
