const { Connection, PublicKey } = require("@solana/web3.js");

const PROGRAM_ID = new PublicKey("2TvW4EfbmMe566ZQWZWd8kX34iFR2DM3oBUpjwpRJcqC");
const SEED = Buffer.from("rumble_config");
const [configPda] = PublicKey.findProgramAddressSync([SEED], PROGRAM_ID);
console.log("Mainnet RumbleConfig PDA:", configPda.toBase58());

const rpc = process.env.NEXT_PUBLIC_BETTING_RPC_URL || "https://api.mainnet-beta.solana.com";
const conn = new Connection(rpc, "confirmed");

async function main() {
  const info = await conn.getAccountInfo(configPda);
  if (!info) {
    console.log("Config account not found on mainnet");
    return;
  }
  console.log("Config account data length:", info.data.length);
  const adminKey = new PublicKey(info.data.slice(8, 40));
  console.log("Admin pubkey:", adminKey.toBase58());
  const bal = await conn.getBalance(adminKey);
  console.log("Admin balance:", bal / 1e9, "SOL (" + bal + " lamports)");
  console.log("Needs ~0.006 SOL per rumble PDA creation");
  console.log("Deficit:", Math.max(0, 5929920 - bal), "lamports");
}

main().catch(e => console.error("Error:", e.message));
