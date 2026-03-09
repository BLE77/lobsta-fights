import { NextResponse } from "next/server";
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { isAuthorizedAdminRequest } from "~~/lib/request-auth";
import { getCachedBalance } from "~~/lib/solana-connection";

export const dynamic = "force-dynamic";

const LOW_THRESHOLD_SOL = 0.01;

/**
 * GET /api/admin/rumble/wallet-balances
 *
 * Returns SOL balances for deployer + all fighter signer wallets.
 * Used by admin dashboard to monitor wallet health.
 */
export async function GET(request: Request) {
  if (!isAuthorizedAdminRequest(request.headers)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const rpc =
      process.env.SOLANA_RPC_URL ||
      process.env.NEXT_PUBLIC_SOLANA_RPC_URL ||
      "https://api.devnet.solana.com";
    const conn = new Connection(rpc, "confirmed");

    // Deployer
    let deployer: { pubkey: string; balance: number } | null = null;
    const deployerRaw = process.env.SOLANA_DEPLOYER_KEYPAIR?.trim();
    if (deployerRaw) {
      try {
        const arr = JSON.parse(deployerRaw);
        const kp = Keypair.fromSecretKey(new Uint8Array(arr));
        const bal = await getCachedBalance(conn, kp.publicKey, {
          commitment: "confirmed",
          ttlMs: 30_000,
        });
        deployer = {
          pubkey: kp.publicKey.toBase58(),
          balance: bal / LAMPORTS_PER_SOL,
        };
      } catch (e) {
        deployer = { pubkey: "error", balance: 0 };
      }
    }

    // Fighter signers
    const signers: Array<{
      index: number;
      fighterId: string | null;
      pubkey: string;
      balance: number;
      low: boolean;
    }> = [];

    const signersRaw = process.env.RUMBLE_FIGHTER_SIGNER_KEYS_JSON?.trim();
    if (signersRaw) {
      try {
        const entries = JSON.parse(signersRaw);
        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i];
          try {
            const pubkey = new PublicKey(entry.wallet_public_key);
            const bal = await getCachedBalance(conn, pubkey, {
              commitment: "confirmed",
              ttlMs: 30_000,
            });
            const solBal = bal / LAMPORTS_PER_SOL;
            signers.push({
              index: i,
              fighterId: entry.fighter_id ?? null,
              pubkey: pubkey.toBase58(),
              balance: solBal,
              low: solBal < LOW_THRESHOLD_SOL,
            });
          } catch {
            signers.push({
              index: i,
              fighterId: entry.fighter_id ?? null,
              pubkey: "error",
              balance: 0,
              low: true,
            });
          }
        }
      } catch {
        // Invalid JSON
      }
    }

    const lowCount = signers.filter((s) => s.low).length;
    const totalSignerBalance = signers.reduce((sum, s) => sum + s.balance, 0);

    return NextResponse.json({
      deployer,
      signers,
      summary: {
        totalSigners: signers.length,
        lowCount,
        totalSignerBalance: +totalSignerBalance.toFixed(6),
        deployerBalance: deployer?.balance ?? 0,
        healthy: lowCount === 0 && (deployer?.balance ?? 0) > 1,
      },
      threshold: LOW_THRESHOLD_SOL,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("[WalletBalances]", error);
    return NextResponse.json(
      { error: "Failed to check balances" },
      { status: 500 },
    );
  }
}
