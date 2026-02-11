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
  let arenaConfigBump: number;
  const ichorMint = Keypair.generate();
  let winnerKeypair: Keypair;
  let winnerTokenAccount: PublicKey;
  let showerVaultKeypair: Keypair;
  let showerVaultTokenAccount: PublicKey;

  const ONE_ICHOR = new anchor.BN(1_000_000_000);

  before(async () => {
    // Derive arena config PDA
    [arenaConfigPda, arenaConfigBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("arena_config")],
      program.programId
    );

    winnerKeypair = Keypair.generate();
    showerVaultKeypair = Keypair.generate();
  });

  it("Initializes the arena", async () => {
    const tx = await program.methods
      .initialize(ONE_ICHOR)
      .accounts({
        admin: admin.publicKey,
        arenaConfig: arenaConfigPda,
        ichorMint: ichorMint.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([ichorMint])
      .rpc();

    console.log("Initialize tx:", tx);

    const arenaConfig = await program.account.arenaConfig.fetch(arenaConfigPda);
    assert.ok(arenaConfig.admin.equals(admin.publicKey));
    assert.ok(arenaConfig.ichorMint.equals(ichorMint.publicKey));
    assert.equal(arenaConfig.totalMinted.toNumber(), 0);
    assert.equal(arenaConfig.totalRumblesCompleted.toNumber(), 0);
    assert.equal(arenaConfig.baseReward.toNumber(), ONE_ICHOR.toNumber());
    assert.equal(arenaConfig.ichorShowerPool.toNumber(), 0);
  });

  it("Mints a rumble reward", async () => {
    // Create winner's associated token account
    winnerTokenAccount = await getAssociatedTokenAddress(
      ichorMint.publicKey,
      winnerKeypair.publicKey
    );

    // Create shower vault associated token account
    showerVaultTokenAccount = await getAssociatedTokenAddress(
      ichorMint.publicKey,
      showerVaultKeypair.publicKey
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
      showerVaultKeypair.publicKey,
      ichorMint.publicKey
    );

    const setupTx = new anchor.web3.Transaction()
      .add(createWinnerAta)
      .add(createShowerAta);
    await provider.sendAndConfirm(setupTx);

    // Mint rumble reward
    const tx = await program.methods
      .mintRumbleReward()
      .accounts({
        authority: admin.publicKey,
        arenaConfig: arenaConfigPda,
        ichorMint: ichorMint.publicKey,
        winnerTokenAccount: winnerTokenAccount,
        showerVault: showerVaultTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    console.log("MintRumbleReward tx:", tx);

    // Winner should have received 0.9 ICHOR (1.0 - 0.1 shower cut)
    const winnerAccount = await getAccount(
      provider.connection,
      winnerTokenAccount
    );
    assert.equal(
      winnerAccount.amount.toString(),
      "900000000" // 0.9 ICHOR
    );

    // Shower vault should have received 0.3 ICHOR (0.1 cut + 0.2 bonus)
    const showerAccount = await getAccount(
      provider.connection,
      showerVaultTokenAccount
    );
    assert.equal(
      showerAccount.amount.toString(),
      "300000000" // 0.3 ICHOR
    );

    // Check arena state
    const arenaConfig = await program.account.arenaConfig.fetch(arenaConfigPda);
    assert.equal(arenaConfig.totalRumblesCompleted.toNumber(), 1);
    assert.equal(
      arenaConfig.totalMinted.toNumber(),
      1_200_000_000 // 1.0 reward + 0.2 bonus = 1.2 total
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
      })
      .signers([winnerKeypair])
      .rpc();

    console.log("Burn tx:", tx);

    // Winner should now have 0.8 ICHOR
    const winnerAccount = await getAccount(
      provider.connection,
      winnerTokenAccount
    );
    assert.equal(
      winnerAccount.amount.toString(),
      "800000000" // 0.8 ICHOR
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
        })
        .signers([winnerKeypair])
        .rpc();
      assert.fail("Should have thrown");
    } catch (err) {
      expect(err.toString()).to.include("ZeroBurnAmount");
    }
  });

  it("Rejects unauthorized rumble reward mint", async () => {
    const randomUser = Keypair.generate();
    const airdropSig = await provider.connection.requestAirdrop(
      randomUser.publicKey,
      anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropSig);

    try {
      await program.methods
        .mintRumbleReward()
        .accounts({
          authority: randomUser.publicKey,
          arenaConfig: arenaConfigPda,
          ichorMint: ichorMint.publicKey,
          winnerTokenAccount: winnerTokenAccount,
          showerVault: showerVaultTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
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
      })
      .rpc();

    const arenaConfig = await program.account.arenaConfig.fetch(arenaConfigPda);
    assert.equal(arenaConfig.baseReward.toNumber(), 2_000_000_000);
  });
});
