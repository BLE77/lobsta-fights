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
/// Shower request PDA seed
const SHOWER_REQUEST_SEED: &[u8] = b"shower_request";
/// Entropy config PDA seed
const ENTROPY_CONFIG_SEED: &[u8] = b"entropy_config";
/// Pending admin transfer PDA seed
const PENDING_ADMIN_SEED: &[u8] = b"pending_admin";

/// Delayed-slot entropy schedule (must settle before slot hash eviction window).
const SHOWER_DELAY_SLOT_A: u64 = 8;
const SHOWER_DELAY_SLOT_B: u64 = 24;

/// entropy_api::state::Var payload size (without account discriminator).
const ENTROPY_VAR_LEN: usize = 232;

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
        let arena_info = ctx.accounts.arena_config.to_account_info();
        let arena = &mut ctx.accounts.arena_config;

        // Calculate reward based on halving schedule
        let reward = calculate_reward(arena.base_reward, arena.total_rumbles_completed);

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
        // Gracefully degrade at deep halvings: if reward < SHOWER_POOL_CUT, entire
        // reward goes to pool and winner gets zero (prevents underflow DOS -- C-1 fix).
        let pool_cut = reward.min(SHOWER_POOL_CUT);
        let winner_amount = reward
            .checked_sub(pool_cut)
            .ok_or(IchorError::MathOverflow)?;

        // Shower pool gets: cut from reward + bonus emission
        let shower_addition = pool_cut
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
                        authority: arena_info.clone(),
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
                        authority: arena_info.clone(),
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

    /// Progress the Ichor Shower state machine.
    ///
    /// Phase 1 (no active request): create a delayed-slot shower request.
    /// Phase 2 (active request and mature): settle using two fixed future slot hashes.
    ///
    /// This removes same-slot leader bias: settlement entropy comes from slots chosen
    /// at request time, not from the slot that includes the settlement transaction.
    pub fn check_ichor_shower(ctx: Context<CheckIchorShower>) -> Result<()> {
        let arena_info = ctx.accounts.arena_config.to_account_info();
        let arena = &mut ctx.accounts.arena_config;
        let request = &mut ctx.accounts.shower_request;
        let clock = Clock::get()?;
        let slot = clock.slot;
        let is_admin = ctx.accounts.authority.key() == arena.admin;

        // Initialize request metadata once.
        if !request.initialized {
            request.initialized = true;
            request.bump = ctx.bumps.shower_request;
            request.active = false;
            request.request_nonce = 0;
        } else {
            require!(
                request.bump == ctx.bumps.shower_request,
                IchorError::InvalidShowerRequestPda
            );
        }

        // No active request -> create one using delayed fixed future slots.
        if !request.active {
            // Only admin can open a new request/recipient pair.
            require!(is_admin, IchorError::Unauthorized);
            require!(arena.ichor_shower_pool > 0, IchorError::EmptyShowerPool);

            request.request_nonce = request
                .request_nonce
                .checked_add(1)
                .ok_or(IchorError::MathOverflow)?;
            request.active = true;
            request.recipient_token_account = ctx.accounts.recipient_token_account.key();
            request.requested_slot = slot;
            request.target_slot_a = slot
                .checked_add(SHOWER_DELAY_SLOT_A)
                .ok_or(IchorError::MathOverflow)?;
            request.target_slot_b = slot
                .checked_add(SHOWER_DELAY_SLOT_B)
                .ok_or(IchorError::MathOverflow)?;

            msg!(
                "ICHOR shower requested. nonce={}, recipient={}, target_a={}, target_b={}",
                request.request_nonce,
                request.recipient_token_account,
                request.target_slot_a,
                request.target_slot_b
            );

            emit!(IchorShowerRequestedEvent {
                request_nonce: request.request_nonce,
                recipient: request.recipient_token_account,
                requested_slot: request.requested_slot,
                target_slot_a: request.target_slot_a,
                target_slot_b: request.target_slot_b,
            });

            return Ok(());
        }

        // Active request: caller must pass the exact pending recipient account.
        require!(
            ctx.accounts.recipient_token_account.key() == request.recipient_token_account,
            IchorError::PendingRecipientMismatch
        );

        // Not ready yet -> no-op (keeps automation idempotent).
        if slot < request.target_slot_b {
            msg!(
                "ICHOR shower pending. current_slot={}, target_slot_b={}",
                slot,
                request.target_slot_b
            );
            return Ok(());
        }

        // Validate entropy_config PDA if provided (L-4 defense-in-depth fix).
        if let Some(ref cfg) = ctx.accounts.entropy_config {
            let (expected_key, _) = Pubkey::find_program_address(
                &[ENTROPY_CONFIG_SEED],
                ctx.program_id,
            );
            require!(cfg.key() == expected_key, IchorError::InvalidEntropyConfig);
        }

        // Auto-reset expired requests whose slot hashes have evicted (M-3 fix).
        // SlotHashes retains ~512 entries; past that, legacy settlement is impossible.
        const SLOT_HASH_EVICTION_WINDOW: u64 = 512;
        if slot > request.target_slot_b.saturating_add(SLOT_HASH_EVICTION_WINDOW) {
            let is_entropy = ctx
                .accounts
                .entropy_config
                .as_ref()
                .map(|cfg| cfg.enabled)
                .unwrap_or(false);
            if !is_entropy {
                reset_shower_request(request);
                msg!(
                    "Shower request expired (slot hash window passed at slot {}). Auto-reset.",
                    slot
                );
                return Ok(());
            }
        }

        let entropy_mode = ctx
            .accounts
            .entropy_config
            .as_ref()
            .map(|cfg| cfg.enabled)
            .unwrap_or(false);

        let rng_value = if entropy_mode {
            let entropy_config = ctx
                .accounts
                .entropy_config
                .as_ref()
                .ok_or(IchorError::MissingEntropyConfig)?;
            let entropy_program = ctx
                .accounts
                .entropy_program
                .as_ref()
                .ok_or(IchorError::MissingEntropyAccounts)?;
            let entropy_var = ctx
                .accounts
                .entropy_var
                .as_ref()
                .ok_or(IchorError::MissingEntropyAccounts)?;

            require!(
                entropy_program.key() == entropy_config.entropy_program_id,
                IchorError::InvalidEntropyProgram
            );
            require!(
                entropy_var.key() == entropy_config.entropy_var,
                IchorError::InvalidEntropyVar
            );
            require!(
                entropy_var.owner == &entropy_config.entropy_program_id,
                IchorError::InvalidEntropyVar
            );

            let entropy_data = entropy_var.data.borrow();
            let parsed = parse_entropy_var(
                &entropy_data,
                &entropy_config.var_authority,
                &entropy_config.provider,
            )
            .ok_or(IchorError::InvalidEntropyVar)?;

            require!(
                parsed.seed != [0u8; 32]
                    && parsed.slot_hash != [0u8; 32]
                    && parsed.value != [0u8; 32],
                IchorError::EntropyVarNotReady
            );
            require!(
                parsed.end_at >= request.target_slot_a,
                IchorError::EntropyVarWindowMismatch
            );
            require!(slot >= parsed.end_at, IchorError::EntropyVarNotReady);

            derive_rng_from_entropy_value(
                &parsed.value,
                request.request_nonce,
                &request.recipient_token_account,
            )
        } else {
            // Legacy fallback: delayed SlotHashes entropy.
            let slot_hashes_info = ctx.accounts.slot_hashes.to_account_info();
            let slot_hashes_data = slot_hashes_info.data.borrow();
            let hash_a = match load_slot_hash_by_slot(&slot_hashes_data, request.target_slot_a) {
                Ok(hash) => hash,
                Err(_) => {
                    // Prevent non-admin callers from force-resetting pending requests.
                    if is_admin {
                        reset_shower_request(request);
                    }
                    return err!(IchorError::SlotHashNotFound);
                }
            };
            let hash_b = match load_slot_hash_by_slot(&slot_hashes_data, request.target_slot_b) {
                Ok(hash) => hash,
                Err(_) => {
                    // Prevent non-admin callers from force-resetting pending requests.
                    if is_admin {
                        reset_shower_request(request);
                    }
                    return err!(IchorError::SlotHashNotFound);
                }
            };

            derive_rng_from_two_slot_hashes(
                &hash_a,
                &hash_b,
                request.request_nonce,
                &request.recipient_token_account,
            )
        };
        let triggered = rng_value % SHOWER_CHANCE == 0;

        if triggered {
            // Use the smaller of the bookkeeping counter and actual vault balance
            // to prevent desync from causing a revert (H-2 fix).
            let vault_balance = ctx.accounts.shower_vault.amount;
            let pool_amount = arena.ichor_shower_pool.min(vault_balance);

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
                            authority: arena_info.clone(),
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
                            authority: arena_info.clone(),
                        },
                        signer_seeds,
                    ),
                    burn_amount,
                )?;
            }

            // Reset pool tracking
            arena.ichor_shower_pool = 0;

            msg!(
                "ICHOR SHOWER TRIGGERED! settle_slot={}, rng={}, recipient={}, payout={}, burned={}",
                slot,
                rng_value,
                request.recipient_token_account,
                recipient_amount,
                burn_amount
            );

            emit!(IchorShowerEvent {
                slot,
                amount: pool_amount,
                recipient: request.recipient_token_account,
            });
        } else {
            msg!(
                "No shower this time. settle_slot={}, rng={}, recipient={}",
                slot,
                rng_value,
                request.recipient_token_account
            );
        }

        reset_shower_request(request);
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
    /// Bounded: must be >= SHOWER_POOL_CUT (to avoid C-1 at era 0) and <= 10 ICHOR.
    pub fn update_base_reward(ctx: Context<AdminOnly>, new_base_reward: u64) -> Result<()> {
        require!(
            new_base_reward >= SHOWER_POOL_CUT,
            IchorError::InvalidBaseReward
        );
        require!(
            new_base_reward <= 10 * ONE_ICHOR,
            IchorError::InvalidBaseReward
        );
        let arena = &mut ctx.accounts.arena_config;
        arena.base_reward = new_base_reward;
        msg!("Base reward updated to {}", new_base_reward);
        Ok(())
    }

    /// Admin: configure external entropy source for shower settlement.
    ///
    /// When enabled, check_ichor_shower settlement uses the entropy var account's
    /// finalized value instead of SlotHashes-derived pseudorandomness.
    pub fn upsert_entropy_config(
        ctx: Context<UpsertEntropyConfig>,
        enabled: bool,
        entropy_program_id: Pubkey,
        entropy_var: Pubkey,
        provider: Pubkey,
        var_authority: Pubkey,
    ) -> Result<()> {
        let entropy_config = &mut ctx.accounts.entropy_config;

        if enabled {
            require!(
                entropy_program_id != Pubkey::default(),
                IchorError::InvalidEntropyConfig
            );
            require!(entropy_var != Pubkey::default(), IchorError::InvalidEntropyConfig);
            require!(provider != Pubkey::default(), IchorError::InvalidEntropyConfig);
            require!(
                var_authority != Pubkey::default(),
                IchorError::InvalidEntropyConfig
            );
        }

        entropy_config.initialized = true;
        entropy_config.enabled = enabled;
        entropy_config.bump = ctx.bumps.entropy_config;
        entropy_config.entropy_program_id = entropy_program_id;
        entropy_config.entropy_var = entropy_var;
        entropy_config.provider = provider;
        entropy_config.var_authority = var_authority;

        msg!(
            "Entropy config updated. enabled={}, program={}, var={}, provider={}, authority={}",
            enabled,
            entropy_program_id,
            entropy_var,
            provider,
            var_authority
        );

        emit!(EntropyConfigUpdatedEvent {
            enabled,
            entropy_program_id,
            entropy_var,
            provider,
            var_authority,
        });

        Ok(())
    }

    /// Admin: propose a new admin (two-step transfer, C-2 fix).
    /// Creates/overwrites PendingAdmin PDA. New admin must call accept_admin.
    pub fn transfer_admin(ctx: Context<TransferAdmin>, new_admin: Pubkey) -> Result<()> {
        require!(new_admin != Pubkey::default(), IchorError::InvalidNewAdmin);
        require!(
            new_admin != ctx.accounts.arena_config.admin,
            IchorError::InvalidNewAdmin
        );

        let pending = &mut ctx.accounts.pending_admin;
        pending.proposed_admin = new_admin;
        pending.proposed_at = Clock::get()?.slot;
        pending.bump = ctx.bumps.pending_admin;

        msg!("Admin transfer proposed: {} -> {}", ctx.accounts.arena_config.admin, new_admin);
        Ok(())
    }

    /// Accept a pending admin transfer. Must be signed by the proposed admin.
    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        let arena = &mut ctx.accounts.arena_config;
        let pending = &ctx.accounts.pending_admin;
        let new_admin = ctx.accounts.new_admin.key();

        require!(
            new_admin == pending.proposed_admin,
            IchorError::Unauthorized
        );

        let old_admin = arena.admin;
        arena.admin = new_admin;

        msg!("Admin transferred: {} -> {}", old_admin, new_admin);
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Calculate the reward for a given rumble number based on the halving schedule.
fn calculate_reward(base_reward: u64, rumbles_completed: u64) -> u64 {
    if rumbles_completed < HALVING_1 {
        base_reward
    } else if rumbles_completed < HALVING_2 {
        base_reward / 2
    } else if rumbles_completed < HALVING_3 {
        base_reward / 4
    } else if rumbles_completed < 21_000_000 {
        base_reward / 8
    } else {
        base_reward / 16
    }
}

/// Load the hash for an exact slot from SlotHashes sysvar bytes.
fn load_slot_hash_by_slot(data: &[u8], target_slot: u64) -> Result<[u8; 32]> {
    let header_size = 8; // u64 count
    let entry_size = 40; // u64 slot + 32-byte hash

    require!(data.len() >= header_size, IchorError::InvalidSlotHashes);

    let mut count_buf = [0u8; 8];
    count_buf.copy_from_slice(&data[..8]);
    let declared_count = u64::from_le_bytes(count_buf) as usize;
    let available_count = (data.len() - header_size) / entry_size;
    let entry_count = declared_count.min(available_count);

    for i in 0..entry_count {
        let offset = header_size + i * entry_size;

        let mut slot_buf = [0u8; 8];
        slot_buf.copy_from_slice(&data[offset..offset + 8]);
        let slot = u64::from_le_bytes(slot_buf);
        if slot != target_slot {
            continue;
        }

        let mut hash = [0u8; 32];
        hash.copy_from_slice(&data[offset + 8..offset + 40]);
        return Ok(hash);
    }

    err!(IchorError::SlotHashNotFound)
}

struct ParsedEntropyVar {
    seed: [u8; 32],
    slot_hash: [u8; 32],
    value: [u8; 32],
    end_at: u64,
}

fn parse_entropy_var(
    data: &[u8],
    expected_authority: &Pubkey,
    expected_provider: &Pubkey,
) -> Option<ParsedEntropyVar> {
    // entropy_api::state::Var may be serialized with or without an 8-byte discriminator.
    for base in [0usize, 8usize] {
        let required = base.checked_add(ENTROPY_VAR_LEN)?;
        if data.len() < required {
            continue;
        }

        let authority = Pubkey::new_from_array(data[base..base + 32].try_into().ok()?);
        if authority != *expected_authority {
            continue;
        }

        let provider_offset = base + 40;
        let provider =
            Pubkey::new_from_array(data[provider_offset..provider_offset + 32].try_into().ok()?);
        if provider != *expected_provider {
            continue;
        }

        let seed_offset = base + 104;
        let slot_hash_offset = base + 136;
        let value_offset = base + 168;
        let end_at_offset = base + 224;

        let mut seed = [0u8; 32];
        seed.copy_from_slice(&data[seed_offset..seed_offset + 32]);
        let mut slot_hash = [0u8; 32];
        slot_hash.copy_from_slice(&data[slot_hash_offset..slot_hash_offset + 32]);
        let mut value = [0u8; 32];
        value.copy_from_slice(&data[value_offset..value_offset + 32]);

        let end_at = u64::from_le_bytes(data[end_at_offset..end_at_offset + 8].try_into().ok()?);

        return Some(ParsedEntropyVar {
            seed,
            slot_hash,
            value,
            end_at,
        });
    }

    None
}

fn derive_rng_from_entropy_value(
    value: &[u8; 32],
    request_nonce: u64,
    recipient_token_account: &Pubkey,
) -> u64 {
    let mut rng = request_nonce
        .wrapping_mul(0x9E37_79B9_7F4A_7C15)
        .wrapping_add(0xD1B5_4A32_D192_ED03);

    for chunk in value.chunks(8) {
        let mut buf = [0u8; 8];
        buf.copy_from_slice(chunk);
        rng ^= u64::from_le_bytes(buf).rotate_left(21);
        rng = rng.wrapping_mul(0xBF58_476D_1CE4_E5B9);
    }
    for chunk in recipient_token_account.as_ref().chunks(8) {
        let mut buf = [0u8; 8];
        buf.copy_from_slice(chunk);
        rng ^= u64::from_le_bytes(buf);
        rng = rng.rotate_left(17).wrapping_add(0x9E37_79B9_7F4A_7C15);
    }

    rng ^ (rng >> 33)
}

/// Derive pseudorandomness from two fixed future slot hashes + request salt.
fn derive_rng_from_two_slot_hashes(
    hash_a: &[u8; 32],
    hash_b: &[u8; 32],
    request_nonce: u64,
    recipient_token_account: &Pubkey,
) -> u64 {
    let mut rng = request_nonce
        .wrapping_mul(0x9E37_79B9_7F4A_7C15)
        .wrapping_add(0xD1B5_4A32_D192_ED03);

    for chunk in hash_a.chunks(8) {
        let mut buf = [0u8; 8];
        buf.copy_from_slice(chunk);
        rng ^= u64::from_le_bytes(buf).rotate_left(13);
        rng = rng.wrapping_mul(0xBF58_476D_1CE4_E5B9);
    }
    for chunk in hash_b.chunks(8) {
        let mut buf = [0u8; 8];
        buf.copy_from_slice(chunk);
        rng ^= u64::from_le_bytes(buf).rotate_left(29);
        rng = rng.wrapping_mul(0x94D0_49BB_1331_11EB);
    }
    for chunk in recipient_token_account.as_ref().chunks(8) {
        let mut buf = [0u8; 8];
        buf.copy_from_slice(chunk);
        rng ^= u64::from_le_bytes(buf);
        rng = rng.rotate_left(17).wrapping_add(0x9E37_79B9_7F4A_7C15);
    }

    rng ^ (rng >> 33)
}

fn reset_shower_request(request: &mut ShowerRequest) {
    request.active = false;
    request.recipient_token_account = Pubkey::default();
    request.requested_slot = 0;
    request.target_slot_a = 0;
    request.target_slot_b = 0;
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
        token::authority = arena_config,
    )]
    pub shower_vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CheckIchorShower<'info> {
    /// Request creation is admin-gated in handler logic; settlement is permissionless.
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [ARENA_SEED],
        bump = arena_config.bump,
    )]
    pub arena_config: Account<'info, ArenaConfig>,

    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + ShowerRequest::INIT_SPACE,
        seeds = [SHOWER_REQUEST_SEED],
        bump
    )]
    pub shower_request: Account<'info, ShowerRequest>,

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

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,

    /// Optional entropy config PDA (required only when entropy mode is enabled).
    pub entropy_config: Option<Account<'info, EntropyConfig>>,

    /// CHECK: Optional entropy var account.
    pub entropy_var: Option<AccountInfo<'info>>,

    /// CHECK: Optional entropy program account.
    pub entropy_program: Option<AccountInfo<'info>>,
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

#[derive(Accounts)]
pub struct UpsertEntropyConfig<'info> {
    #[account(
        mut,
        constraint = authority.key() == arena_config.admin @ IchorError::Unauthorized,
    )]
    pub authority: Signer<'info>,

    #[account(
        seeds = [ARENA_SEED],
        bump = arena_config.bump,
    )]
    pub arena_config: Account<'info, ArenaConfig>,

    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + EntropyConfig::INIT_SPACE,
        seeds = [ENTROPY_CONFIG_SEED],
        bump
    )]
    pub entropy_config: Account<'info, EntropyConfig>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct TransferAdmin<'info> {
    #[account(
        mut,
        constraint = authority.key() == arena_config.admin @ IchorError::Unauthorized,
    )]
    pub authority: Signer<'info>,

    #[account(
        seeds = [ARENA_SEED],
        bump = arena_config.bump,
    )]
    pub arena_config: Account<'info, ArenaConfig>,

    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + PendingAdmin::INIT_SPACE,
        seeds = [PENDING_ADMIN_SEED],
        bump
    )]
    pub pending_admin: Account<'info, PendingAdmin>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    /// The proposed new admin must sign this transaction.
    #[account(mut)]
    pub new_admin: Signer<'info>,

    #[account(
        mut,
        seeds = [ARENA_SEED],
        bump = arena_config.bump,
    )]
    pub arena_config: Account<'info, ArenaConfig>,

    #[account(
        seeds = [PENDING_ADMIN_SEED],
        bump = pending_admin.bump,
        constraint = pending_admin.proposed_admin == new_admin.key() @ IchorError::Unauthorized,
    )]
    pub pending_admin: Account<'info, PendingAdmin>,
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

#[account]
#[derive(InitSpace)]
pub struct EntropyConfig {
    pub initialized: bool,        // 1
    pub enabled: bool,            // 1
    pub bump: u8,                 // 1
    pub entropy_program_id: Pubkey, // 32
    pub entropy_var: Pubkey,      // 32
    pub provider: Pubkey,         // 32
    pub var_authority: Pubkey,    // 32
}

#[account]
#[derive(InitSpace)]
pub struct ShowerRequest {
    pub initialized: bool,            // 1
    pub active: bool,                 // 1
    pub bump: u8,                     // 1
    pub request_nonce: u64,           // 8
    pub requested_slot: u64,          // 8
    pub target_slot_a: u64,           // 8
    pub target_slot_b: u64,           // 8
    pub recipient_token_account: Pubkey, // 32
}

#[account]
#[derive(InitSpace)]
pub struct PendingAdmin {
    pub proposed_admin: Pubkey,       // 32
    pub proposed_at: u64,             // 8
    pub bump: u8,                     // 1
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

#[event]
pub struct IchorShowerRequestedEvent {
    pub request_nonce: u64,
    pub recipient: Pubkey,
    pub requested_slot: u64,
    pub target_slot_a: u64,
    pub target_slot_b: u64,
}

#[event]
pub struct EntropyConfigUpdatedEvent {
    pub enabled: bool,
    pub entropy_program_id: Pubkey,
    pub entropy_var: Pubkey,
    pub provider: Pubkey,
    pub var_authority: Pubkey,
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

    #[msg("Required slot hash not found in SlotHashes sysvar")]
    SlotHashNotFound,

    #[msg("Recipient token account does not match active shower request")]
    PendingRecipientMismatch,

    #[msg("Invalid shower request PDA state")]
    InvalidShowerRequestPda,

    #[msg("Invalid entropy configuration")]
    InvalidEntropyConfig,

    #[msg("Missing entropy configuration account")]
    MissingEntropyConfig,

    #[msg("Missing entropy var/program accounts")]
    MissingEntropyAccounts,

    #[msg("Invalid entropy program account")]
    InvalidEntropyProgram,

    #[msg("Invalid entropy var account")]
    InvalidEntropyVar,

    #[msg("Entropy var is not finalized/ready yet")]
    EntropyVarNotReady,

    #[msg("Entropy var timing window does not match the pending shower request")]
    EntropyVarWindowMismatch,

    #[msg("Invalid base reward: must be >= 0.1 ICHOR and <= 10 ICHOR")]
    InvalidBaseReward,

    #[msg("Invalid new admin address")]
    InvalidNewAdmin,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_pubkey(buf: &mut [u8], offset: usize, key: &Pubkey) {
        buf[offset..offset + 32].copy_from_slice(key.as_ref());
    }

    fn write_u64(buf: &mut [u8], offset: usize, value: u64) {
        buf[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
    }

    fn build_entropy_var_bytes(base: usize, authority: &Pubkey, provider: &Pubkey) -> Vec<u8> {
        let mut data = vec![0u8; base + ENTROPY_VAR_LEN];

        write_pubkey(&mut data, base, authority);
        write_pubkey(&mut data, base + 40, provider);

        // seed / slot_hash / value
        data[base + 104..base + 136].copy_from_slice(&[1u8; 32]);
        data[base + 136..base + 168].copy_from_slice(&[2u8; 32]);
        data[base + 168..base + 200].copy_from_slice(&[3u8; 32]);

        // start_at / end_at
        write_u64(&mut data, base + 216, 100);
        write_u64(&mut data, base + 224, 120);

        data
    }

    #[test]
    fn parses_entropy_var_without_discriminator() {
        let authority = Pubkey::new_unique();
        let provider = Pubkey::new_unique();
        let data = build_entropy_var_bytes(0, &authority, &provider);

        let parsed = parse_entropy_var(&data, &authority, &provider)
            .expect("expected entropy var parse");

        assert_eq!(parsed.seed, [1u8; 32]);
        assert_eq!(parsed.slot_hash, [2u8; 32]);
        assert_eq!(parsed.value, [3u8; 32]);
        assert_eq!(parsed.end_at, 120);
    }

    #[test]
    fn parses_entropy_var_with_8_byte_discriminator_prefix() {
        let authority = Pubkey::new_unique();
        let provider = Pubkey::new_unique();
        let mut data = build_entropy_var_bytes(8, &authority, &provider);
        data[..8].copy_from_slice(&[9u8; 8]);

        let parsed = parse_entropy_var(&data, &authority, &provider)
            .expect("expected entropy var parse at +8 offset");

        assert_eq!(parsed.seed, [1u8; 32]);
        assert_eq!(parsed.slot_hash, [2u8; 32]);
        assert_eq!(parsed.value, [3u8; 32]);
    }

    #[test]
    fn rejects_entropy_var_when_authority_or_provider_mismatch() {
        let authority = Pubkey::new_unique();
        let provider = Pubkey::new_unique();
        let data = build_entropy_var_bytes(0, &authority, &provider);

        assert!(parse_entropy_var(&data, &Pubkey::new_unique(), &provider).is_none());
        assert!(parse_entropy_var(&data, &authority, &Pubkey::new_unique()).is_none());
    }

    #[test]
    fn derives_distinct_rng_for_distinct_inputs() {
        let recipient_a = Pubkey::new_unique();
        let recipient_b = Pubkey::new_unique();
        let value = [7u8; 32];

        let rng_a = derive_rng_from_entropy_value(&value, 1, &recipient_a);
        let rng_b = derive_rng_from_entropy_value(&value, 2, &recipient_a);
        let rng_c = derive_rng_from_entropy_value(&value, 1, &recipient_b);

        assert_ne!(rng_a, rng_b);
        assert_ne!(rng_a, rng_c);
    }

    #[test]
    fn calculate_reward_never_underflows_pool_cut() {
        // C-1 regression: at deep halvings the reward can be smaller than SHOWER_POOL_CUT.
        // Verify that pool_cut = reward.min(SHOWER_POOL_CUT) prevents underflow.
        let small_base = 50_000_000u64; // 0.05 ICHOR -- much smaller than SHOWER_POOL_CUT
        let reward = calculate_reward(small_base, 0);
        assert_eq!(reward, small_base);
        // This is the fix: pool_cut = min(reward, SHOWER_POOL_CUT) = min(50M, 100M) = 50M
        let pool_cut = reward.min(SHOWER_POOL_CUT);
        let winner_amount = reward.checked_sub(pool_cut).expect("should not underflow");
        assert_eq!(winner_amount, 0); // entire reward goes to pool
        assert_eq!(pool_cut, small_base);

        // At era 4 (21M+ rumbles), base=1 ICHOR halved to 1/16 = 62.5M < SHOWER_POOL_CUT
        let reward_era4 = calculate_reward(ONE_ICHOR, 21_000_001);
        assert_eq!(reward_era4, ONE_ICHOR / 16); // 62_500_000
        let pool_cut_era4 = reward_era4.min(SHOWER_POOL_CUT);
        let winner_era4 = reward_era4.checked_sub(pool_cut_era4).expect("no underflow");
        assert_eq!(winner_era4, 0);
        assert_eq!(pool_cut_era4, reward_era4);
    }

    #[test]
    fn loads_slot_hash_by_exact_slot() {
        let mut data = Vec::new();
        data.extend_from_slice(&(2u64).to_le_bytes());

        let hash_a = [11u8; 32];
        let hash_b = [22u8; 32];

        data.extend_from_slice(&(41u64).to_le_bytes());
        data.extend_from_slice(&hash_a);
        data.extend_from_slice(&(42u64).to_le_bytes());
        data.extend_from_slice(&hash_b);

        let found = load_slot_hash_by_slot(&data, 42).expect("slot hash should exist");
        assert_eq!(found, hash_b);

        assert!(load_slot_hash_by_slot(&data, 43).is_err());
    }
}
