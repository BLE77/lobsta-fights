use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount, Transfer};

declare_id!("8CHYSuh1Y3F83PyK95E3F1Uya6pgPk4m3vM3MF3mP5hg");

/// ICHOR token decimals
const ICHOR_DECIMALS: u8 = 9;

/// 1 ICHOR in smallest unit (lamports of ICHOR)
const ONE_ICHOR: u64 = 1_000_000_000;

/// Maximum supply: 21,000,000 ICHOR
const MAX_SUPPLY: u64 = 21_000_000 * ONE_ICHOR;

/// Ichor Shower bonus emission per rumble: 0.2 ICHOR
const SHOWER_BONUS_EMISSION: u64 = 200_000_000;

/// Ichor Shower pool contribution from reward: 0.1 ICHOR
const SHOWER_POOL_CUT: u64 = 100_000_000;

/// Ichor Shower trigger chance: 1 in 500
const SHOWER_CHANCE: u64 = 500;

/// Halving schedule boundaries (by rumble count)
const HALVING_1: u64 = 2_100_000;
const HALVING_2: u64 = 6_300_000;
const HALVING_3: u64 = 12_600_000;

/// Arena config PDA seed
const ARENA_SEED: &[u8] = b"arena_config";

#[program]
pub mod ichor_token {
    use super::*;

    /// Initialize the ICHOR mint and arena configuration.
    /// The mint authority is the arena_config PDA so only the program can mint.
    pub fn initialize(ctx: Context<Initialize>, base_reward: u64) -> Result<()> {
        let arena = &mut ctx.accounts.arena_config;
        arena.admin = ctx.accounts.admin.key();
        arena.ichor_mint = ctx.accounts.ichor_mint.key();
        arena.total_minted = 0;
        arena.total_rumbles_completed = 0;
        arena.base_reward = base_reward;
        arena.ichor_shower_pool = 0;
        arena.treasury_vault = 0;
        arena.bump = ctx.bumps.arena_config;

        msg!("ICHOR Arena initialized. Mint: {}", arena.ichor_mint);
        Ok(())
    }

    /// Mint rewards after a completed Rumble.
    /// Distributes ICHOR to the winner, contributes to the Ichor Shower pool,
    /// and adds bonus shower emissions.
    pub fn mint_rumble_reward(ctx: Context<MintRumbleReward>) -> Result<()> {
        let arena = &mut ctx.accounts.arena_config;

        // Calculate reward based on halving schedule
        let reward = calculate_reward(arena.total_rumbles_completed);

        // Total emission = reward + shower bonus
        let total_emission = reward
            .checked_add(SHOWER_BONUS_EMISSION)
            .ok_or(IchorError::MathOverflow)?;

        // Check supply cap
        let new_total = arena
            .total_minted
            .checked_add(total_emission)
            .ok_or(IchorError::MathOverflow)?;
        require!(new_total <= MAX_SUPPLY, IchorError::MaxSupplyExceeded);

        // Amount going to winner = reward - shower pool cut
        let winner_amount = reward
            .checked_sub(SHOWER_POOL_CUT)
            .ok_or(IchorError::MathOverflow)?;

        // Shower pool gets: cut from reward (0.1) + bonus emission (0.2) = 0.3 per rumble
        let shower_addition = SHOWER_POOL_CUT
            .checked_add(SHOWER_BONUS_EMISSION)
            .ok_or(IchorError::MathOverflow)?;

        // Build PDA signer seeds
        let bump = &[arena.bump];
        let seeds: &[&[u8]] = &[ARENA_SEED, bump];
        let signer_seeds = &[seeds];

        // Mint winner's share to their token account
        if winner_amount > 0 {
            token::mint_to(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    MintTo {
                        mint: ctx.accounts.ichor_mint.to_account_info(),
                        to: ctx.accounts.winner_token_account.to_account_info(),
                        authority: ctx.accounts.arena_config.to_account_info(),
                    },
                    signer_seeds,
                ),
                winner_amount,
            )?;
        }

        // Mint shower pool portion to the shower vault
        if shower_addition > 0 {
            token::mint_to(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    MintTo {
                        mint: ctx.accounts.ichor_mint.to_account_info(),
                        to: ctx.accounts.shower_vault.to_account_info(),
                        authority: ctx.accounts.arena_config.to_account_info(),
                    },
                    signer_seeds,
                ),
                shower_addition,
            )?;
        }

        // Update state
        arena.total_minted = new_total;
        arena.total_rumbles_completed = arena
            .total_rumbles_completed
            .checked_add(1)
            .ok_or(IchorError::MathOverflow)?;
        arena.ichor_shower_pool = arena
            .ichor_shower_pool
            .checked_add(shower_addition)
            .ok_or(IchorError::MathOverflow)?;

        msg!(
            "Rumble #{} reward: {} to winner, {} to shower pool. Total minted: {}",
            arena.total_rumbles_completed,
            winner_amount,
            shower_addition,
            arena.total_minted
        );

        Ok(())
    }

    /// Check if an Ichor Shower should trigger (1/500 chance).
    /// Uses the recent slot hash for pseudorandomness.
    /// If triggered, transfers the entire shower pool to the lucky recipient.
    pub fn check_ichor_shower(ctx: Context<CheckIchorShower>) -> Result<()> {
        let arena = &mut ctx.accounts.arena_config;

        require!(arena.ichor_shower_pool > 0, IchorError::EmptyShowerPool);

        // Derive pseudorandom number from slot hashes
        let clock = Clock::get()?;
        let slot = clock.slot;
        // Use slot hash sysvar for randomness
        let slot_hashes_info = ctx.accounts.slot_hashes.to_account_info();
        let slot_hashes_data = slot_hashes_info.data.borrow();

        // Extract bytes from slot hashes data for RNG
        // SlotHashes sysvar stores recent slot hashes; use first available hash bytes
        let rng_value = derive_rng_from_slot_hashes(&slot_hashes_data, slot)?;

        let triggered = rng_value % SHOWER_CHANCE == 0;

        if triggered {
            let pool_amount = arena.ichor_shower_pool;

            // 90% to recipient, 10% burned
            let recipient_amount = pool_amount
                .checked_mul(90)
                .ok_or(IchorError::MathOverflow)?
                .checked_div(100)
                .ok_or(IchorError::MathOverflow)?;
            let burn_amount = pool_amount
                .checked_sub(recipient_amount)
                .ok_or(IchorError::MathOverflow)?;

            // The shower vault's authority is the arena_config PDA.
            let bump = &[arena.bump];
            let seeds: &[&[u8]] = &[ARENA_SEED, bump];
            let signer_seeds = &[seeds];

            // Transfer 90% to recipient
            if recipient_amount > 0 {
                token::transfer(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.to_account_info(),
                        Transfer {
                            from: ctx.accounts.shower_vault.to_account_info(),
                            to: ctx.accounts.recipient_token_account.to_account_info(),
                            authority: ctx.accounts.arena_config.to_account_info(),
                        },
                        signer_seeds,
                    ),
                    recipient_amount,
                )?;
            }

            // Burn 10%
            if burn_amount > 0 {
                token::burn(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.to_account_info(),
                        Burn {
                            mint: ctx.accounts.ichor_mint.to_account_info(),
                            from: ctx.accounts.shower_vault.to_account_info(),
                            authority: ctx.accounts.arena_config.to_account_info(),
                        },
                        signer_seeds,
                    ),
                    burn_amount,
                )?;
            }

            // Reset pool tracking
            arena.ichor_shower_pool = 0;

            msg!(
                "ICHOR SHOWER TRIGGERED! Slot {} -> {} ICHOR to recipient, {} ICHOR burned!",
                slot,
                recipient_amount,
                burn_amount
            );

            emit!(IchorShowerEvent {
                slot,
                amount: pool_amount,
                recipient: ctx.accounts.recipient_token_account.key(),
            });
        } else {
            msg!("No shower this time. Slot: {}, RNG: {}", slot, rng_value);
        }

        Ok(())
    }

    /// Burn ICHOR tokens (deflationary mechanism).
    pub fn burn(ctx: Context<BurnIchor>, amount: u64) -> Result<()> {
        require!(amount > 0, IchorError::ZeroBurnAmount);

        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.ichor_mint.to_account_info(),
                    from: ctx.accounts.token_account.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            amount,
        )?;

        msg!("Burned {} ICHOR", amount);
        Ok(())
    }

    /// Admin: update the base reward amount.
    pub fn update_base_reward(ctx: Context<AdminOnly>, new_base_reward: u64) -> Result<()> {
        let arena = &mut ctx.accounts.arena_config;
        arena.base_reward = new_base_reward;
        msg!("Base reward updated to {}", new_base_reward);
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Calculate the reward for a given rumble number based on the halving schedule.
fn calculate_reward(rumbles_completed: u64) -> u64 {
    if rumbles_completed < HALVING_1 {
        ONE_ICHOR // 1.0 ICHOR
    } else if rumbles_completed < HALVING_2 {
        ONE_ICHOR / 2 // 0.5 ICHOR
    } else if rumbles_completed < HALVING_3 {
        ONE_ICHOR / 4 // 0.25 ICHOR
    } else if rumbles_completed < 21_000_000 {
        ONE_ICHOR / 8 // 0.125 ICHOR
    } else {
        ONE_ICHOR / 16 // 0.0625 ICHOR
    }
}

/// Derive a pseudorandom u64 from the SlotHashes sysvar data and current slot.
fn derive_rng_from_slot_hashes(data: &[u8], slot: u64) -> Result<u64> {
    // SlotHashes sysvar: first 8 bytes = count (u64 LE), then entries of (slot: u64, hash: [u8; 32])
    // Each entry is 40 bytes. We grab hash bytes from the first entry.
    let header_size = 8; // u64 count
    let entry_size = 40; // u64 slot + 32-byte hash

    require!(data.len() >= header_size + entry_size, IchorError::InvalidSlotHashes);

    // Grab the first slot hash (most recent)
    let hash_start = header_size + 8; // skip count + first slot
    let hash_bytes = &data[hash_start..hash_start + 32];

    // Combine hash bytes with current slot for added entropy
    let mut result: u64 = slot;
    for chunk in hash_bytes.chunks(8) {
        let mut buf = [0u8; 8];
        let len = chunk.len().min(8);
        buf[..len].copy_from_slice(&chunk[..len]);
        result ^= u64::from_le_bytes(buf);
    }

    Ok(result)
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
        space = 8 + ArenaConfig::INIT_SPACE,
        seeds = [ARENA_SEED],
        bump
    )]
    pub arena_config: Account<'info, ArenaConfig>,

    #[account(
        init,
        payer = admin,
        mint::decimals = ICHOR_DECIMALS,
        mint::authority = arena_config,
    )]
    pub ichor_mint: Account<'info, Mint>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct MintRumbleReward<'info> {
    /// Only admin (backend) can trigger rumble rewards.
    #[account(
        mut,
        constraint = authority.key() == arena_config.admin @ IchorError::Unauthorized,
    )]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [ARENA_SEED],
        bump = arena_config.bump,
    )]
    pub arena_config: Account<'info, ArenaConfig>,

    #[account(
        mut,
        address = arena_config.ichor_mint @ IchorError::InvalidMint,
    )]
    pub ichor_mint: Account<'info, Mint>,

    /// Winner's ICHOR token account.
    #[account(
        mut,
        token::mint = ichor_mint,
    )]
    pub winner_token_account: Account<'info, TokenAccount>,

    /// Shower vault token account (holds the shower pool).
    #[account(
        mut,
        token::mint = ichor_mint,
    )]
    pub shower_vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CheckIchorShower<'info> {
    #[account(
        mut,
        constraint = authority.key() == arena_config.admin @ IchorError::Unauthorized,
    )]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [ARENA_SEED],
        bump = arena_config.bump,
    )]
    pub arena_config: Account<'info, ArenaConfig>,

    #[account(
        mut,
        address = arena_config.ichor_mint @ IchorError::InvalidMint,
    )]
    pub ichor_mint: Account<'info, Mint>,

    /// The lucky recipient's ICHOR token account.
    #[account(
        mut,
        token::mint = ichor_mint,
    )]
    pub recipient_token_account: Account<'info, TokenAccount>,

    /// Shower vault (holds pool tokens). Authority must be the arena_config PDA.
    #[account(
        mut,
        token::mint = ichor_mint,
        token::authority = arena_config,
    )]
    pub shower_vault: Account<'info, TokenAccount>,

    /// CHECK: SlotHashes sysvar for RNG.
    #[account(address = anchor_lang::solana_program::sysvar::slot_hashes::id())]
    pub slot_hashes: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct BurnIchor<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        address = arena_config.ichor_mint @ IchorError::InvalidMint,
    )]
    pub ichor_mint: Account<'info, Mint>,

    #[account(
        mut,
        token::mint = ichor_mint,
        token::authority = owner,
    )]
    pub token_account: Account<'info, TokenAccount>,

    #[account(
        seeds = [ARENA_SEED],
        bump = arena_config.bump,
    )]
    pub arena_config: Account<'info, ArenaConfig>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(
        mut,
        constraint = authority.key() == arena_config.admin @ IchorError::Unauthorized,
    )]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [ARENA_SEED],
        bump = arena_config.bump,
    )]
    pub arena_config: Account<'info, ArenaConfig>,
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct ArenaConfig {
    pub admin: Pubkey,            // 32
    pub ichor_mint: Pubkey,       // 32
    pub total_minted: u64,        // 8
    pub total_rumbles_completed: u64, // 8
    pub base_reward: u64,         // 8
    pub ichor_shower_pool: u64,   // 8
    pub treasury_vault: u64,      // 8
    pub bump: u8,                 // 1
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[event]
pub struct IchorShowerEvent {
    pub slot: u64,
    pub amount: u64,
    pub recipient: Pubkey,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum IchorError {
    #[msg("Maximum ICHOR supply of 21,000,000 exceeded")]
    MaxSupplyExceeded,

    #[msg("Math overflow")]
    MathOverflow,

    #[msg("Unauthorized: only admin can perform this action")]
    Unauthorized,

    #[msg("Invalid ICHOR mint")]
    InvalidMint,

    #[msg("Shower pool is empty")]
    EmptyShowerPool,

    #[msg("Burn amount must be greater than zero")]
    ZeroBurnAmount,

    #[msg("Invalid SlotHashes sysvar data")]
    InvalidSlotHashes,
}
