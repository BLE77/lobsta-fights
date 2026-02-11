/**
 * ICHOR Token Client
 *
 * TypeScript helpers for interacting with the ichor_token Solana program.
 * Used by the Next.js backend to mint rewards, check showers, etc.
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  SYSVAR_SLOT_HASHES_PUBKEY,
  Connection,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";

const ARENA_SEED = Buffer.from("arena_config");

export interface IchorClientConfig {
  programId: PublicKey;
  connection: Connection;
  adminKeypair: Keypair;
}

export class IchorClient {
  private program: Program;
  private admin: Keypair;
  private arenaConfigPda: PublicKey;
  private arenaConfigBump: number;

  constructor(program: Program, admin: Keypair) {
    this.program = program;
    this.admin = admin;

    const [pda, bump] = PublicKey.findProgramAddressSync(
      [ARENA_SEED],
      program.programId
    );
    this.arenaConfigPda = pda;
    this.arenaConfigBump = bump;
  }

  get arenaConfig(): PublicKey {
    return this.arenaConfigPda;
  }

  /**
   * Initialize the ICHOR arena and mint.
   */
  async initialize(
    ichorMint: Keypair,
    baseReward: anchor.BN
  ): Promise<string> {
    return this.program.methods
      .initialize(baseReward)
      .accounts({
        admin: this.admin.publicKey,
        arenaConfig: this.arenaConfigPda,
        ichorMint: ichorMint.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([this.admin, ichorMint])
      .rpc();
  }

  /**
   * Mint ICHOR reward after a rumble completes.
   */
  async mintRumbleReward(
    ichorMint: PublicKey,
    winnerTokenAccount: PublicKey,
    showerVault: PublicKey
  ): Promise<string> {
    return this.program.methods
      .mintRumbleReward()
      .accounts({
        authority: this.admin.publicKey,
        arenaConfig: this.arenaConfigPda,
        ichorMint,
        winnerTokenAccount,
        showerVault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([this.admin])
      .rpc();
  }

  /**
   * Check if an Ichor Shower should trigger.
   */
  async checkIchorShower(
    ichorMint: PublicKey,
    recipientTokenAccount: PublicKey,
    showerVault: PublicKey
  ): Promise<string> {
    return this.program.methods
      .checkIchorShower()
      .accounts({
        authority: this.admin.publicKey,
        arenaConfig: this.arenaConfigPda,
        ichorMint,
        recipientTokenAccount,
        showerVault,
        slotHashes: SYSVAR_SLOT_HASHES_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([this.admin])
      .rpc();
  }

  /**
   * Fetch the current arena configuration.
   */
  async fetchArenaConfig(): Promise<any> {
    return this.program.account.arenaConfig.fetch(this.arenaConfigPda);
  }

  /**
   * Get or create an associated token account for the given owner.
   */
  async getOrCreateAta(
    connection: Connection,
    mint: PublicKey,
    owner: PublicKey,
    payer: Keypair
  ): Promise<PublicKey> {
    const ata = await getAssociatedTokenAddress(mint, owner);

    try {
      await connection.getAccountInfo(ata);
    } catch {
      const ix = createAssociatedTokenAccountInstruction(
        payer.publicKey,
        ata,
        owner,
        mint
      );
      const tx = new anchor.web3.Transaction().add(ix);
      const provider = this.program.provider as anchor.AnchorProvider;
      await provider.sendAndConfirm(tx, [payer]);
    }

    return ata;
  }
}
