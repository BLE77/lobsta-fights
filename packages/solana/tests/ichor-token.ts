import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  SYSVAR_SLOT_HASHES_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  getAccount,
} from "@solana/spl-token";
import { assert, expect } from "chai";
import { IchorToken } from "../target/types/ichor_token";

describe("ichor-token", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.IchorToken as Program<IchorToken>;
  const admin = provider.wallet;

  // PDAs and accounts
  let arenaConfigPda: PublicKey;
  let distributionVaultPda: PublicKey;
  const ichorMint = Keypair.generate();
  let winnerKeypair: Keypair;
  let winnerTokenAccount: PublicKey;
  let showerVaultTokenAccount: PublicKey;

  const ONE_ICHOR = new anchor.BN(1_000_000_000);
  const WINNER_REWARD_AMOUNT = "800000000000";
  const SHOWER_REWARD_AMOUNT = "250200000000";
  const TOTAL_DISTRIBUTED_AMOUNT = "1050200000000";
  const WINNER_BALANCE_AFTER_BURN = "799900000000";

  before(async () => {
    // Derive arena config PDA
    [arenaConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("arena_config")],
      program.programId
    );
    [distributionVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("distribution_vault")],
      program.programId
    );

    winnerKeypair = Keypair.generate();
  });

  it("Initializes the arena", async () => {
    const tx = await program.methods
      .initialize(ONE_ICHOR)
      .accounts({
        admin: admin.publicKey,
        arenaConfig: arenaConfigPda,
        ichorMint: ichorMint.publicKey,
        distributionVault: distributionVaultPda,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      } as any)
      .signers([ichorMint])
      .rpc();

    console.log("Initialize tx:", tx);

    const arenaConfig = await program.account.arenaConfig.fetch(arenaConfigPda);
    assert.ok(arenaConfig.admin.equals(admin.publicKey));
    assert.ok(arenaConfig.ichorMint.equals(ichorMint.publicKey));
    assert.ok(arenaConfig.distributionVault.equals(distributionVaultPda));
    assert.equal(arenaConfig.totalDistributed.toNumber(), 0);
    assert.equal(arenaConfig.totalRumblesCompleted.toNumber(), 0);
    assert.equal(arenaConfig.baseReward.toNumber(), ONE_ICHOR.toNumber());
    assert.equal(arenaConfig.seasonReward.toNumber(), 2_500 * ONE_ICHOR.toNumber());
    assert.equal(arenaConfig.ichorShowerPool.toNumber(), 0);
  });

  it("Distributes a rumble reward", async () => {
    // Create winner's associated token account
    winnerTokenAccount = await getAssociatedTokenAddress(
      ichorMint.publicKey,
      winnerKeypair.publicKey
    );

    // Create shower vault ATA owned by the arena PDA
    showerVaultTokenAccount = await getAssociatedTokenAddress(
      ichorMint.publicKey,
      arenaConfigPda,
      true
    );

    // Create ATAs
    const createWinnerAta = createAssociatedTokenAccountInstruction(
      admin.publicKey,
      winnerTokenAccount,
      winnerKeypair.publicKey,
      ichorMint.publicKey
    );
    const createShowerAta = createAssociatedTokenAccountInstruction(
      admin.publicKey,
      showerVaultTokenAccount,
      arenaConfigPda,
      ichorMint.publicKey
    );

    const setupTx = new anchor.web3.Transaction()
      .add(createWinnerAta)
      .add(createShowerAta);
    await provider.sendAndConfirm(setupTx);

    // Distribute the on-chain reward from the seeded distribution vault
    const tx = await program.methods
      .distributeReward()
      .accounts({
        authority: admin.publicKey,
        arenaConfig: arenaConfigPda,
        distributionVault: distributionVaultPda,
        ichorMint: ichorMint.publicKey,
        winnerTokenAccount: winnerTokenAccount,
        showerVault: showerVaultTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .rpc();

    console.log("DistributeReward tx:", tx);

    // Winner receives 32% of the 2,500 ICHOR season reward = 800 ICHOR.
    const winnerAccount = await getAccount(
      provider.connection,
      winnerTokenAccount
    );
    assert.equal(
      winnerAccount.amount.toString(),
      WINNER_REWARD_AMOUNT
    );

    // Shower vault receives 10% of season reward + 0.2 ICHOR bonus = 250.2 ICHOR.
    const showerAccount = await getAccount(
      provider.connection,
      showerVaultTokenAccount
    );
    assert.equal(
      showerAccount.amount.toString(),
      SHOWER_REWARD_AMOUNT
    );

    // Check arena state
    const arenaConfig = await program.account.arenaConfig.fetch(arenaConfigPda);
    assert.equal(arenaConfig.totalRumblesCompleted.toNumber(), 1);
    assert.equal(
      arenaConfig.totalDistributed.toString(),
      TOTAL_DISTRIBUTED_AMOUNT
    );
  });

  it("Burns ICHOR tokens", async () => {
    // Winner burns some tokens
    // First airdrop SOL to winner for tx fees
    const airdropSig = await provider.connection.requestAirdrop(
      winnerKeypair.publicKey,
      anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropSig);

    const burnAmount = new anchor.BN(100_000_000); // 0.1 ICHOR

    const tx = await program.methods
      .burn(burnAmount)
      .accounts({
        owner: winnerKeypair.publicKey,
        ichorMint: ichorMint.publicKey,
        tokenAccount: winnerTokenAccount,
        arenaConfig: arenaConfigPda,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .signers([winnerKeypair])
      .rpc();

    console.log("Burn tx:", tx);

    // Winner should now have 799.9 ICHOR
    const winnerAccount = await getAccount(
      provider.connection,
      winnerTokenAccount
    );
    assert.equal(
      winnerAccount.amount.toString(),
      WINNER_BALANCE_AFTER_BURN
    );
  });

  it("Rejects burn of zero amount", async () => {
    try {
      await program.methods
        .burn(new anchor.BN(0))
        .accounts({
          owner: winnerKeypair.publicKey,
          ichorMint: ichorMint.publicKey,
          tokenAccount: winnerTokenAccount,
          arenaConfig: arenaConfigPda,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .signers([winnerKeypair])
        .rpc();
      assert.fail("Should have thrown");
    } catch (err) {
      expect(err.toString()).to.include("ZeroBurnAmount");
    }
  });

  it("Rejects unauthorized rumble reward distribution", async () => {
    const randomUser = Keypair.generate();
    const airdropSig = await provider.connection.requestAirdrop(
      randomUser.publicKey,
      anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropSig);

    try {
      await program.methods
        .distributeReward()
        .accounts({
          authority: randomUser.publicKey,
          arenaConfig: arenaConfigPda,
          distributionVault: distributionVaultPda,
          ichorMint: ichorMint.publicKey,
          winnerTokenAccount: winnerTokenAccount,
          showerVault: showerVaultTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .signers([randomUser])
        .rpc();
      assert.fail("Should have thrown");
    } catch (err) {
      // Expected: constraint violation
      expect(err.toString()).to.include("Error");
    }
  });

  it("Updates base reward (admin only)", async () => {
    const newReward = new anchor.BN(2_000_000_000); // 2 ICHOR

    await program.methods
      .updateBaseReward(newReward)
      .accounts({
        authority: admin.publicKey,
        arenaConfig: arenaConfigPda,
      } as any)
      .rpc();

    const arenaConfig = await program.account.arenaConfig.fetch(arenaConfigPda);
    assert.equal(arenaConfig.baseReward.toNumber(), 2_000_000_000);
  });
});
