import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { utils as anchorUtils } from "@coral-xyz/anchor";
import { createHash } from "node:crypto";

const RUMBLE_ENGINE_ID = new PublicKey("2TvW4EfbmMe566ZQWZWd8kX34iFR2DM3oBUpjwpRJcqC");
const BETTOR_SEED = Buffer.from("bettor");
const BETTOR_DISCRIMINATOR = createHash("sha256")
  .update("account:BettorAccount")
  .digest()
  .subarray(0, 8);

const wallet = new PublicKey("4gfVi6MUPC2cG4gg4uarp9EAAqDeBtosvUVX1iGNT1Va");
if (!process.env.HELIUS_API_KEY) {
  throw new Error("HELIUS_API_KEY environment variable is required");
}
const conn = new Connection(
  `https://devnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`,
  "confirmed",
);

function readU64LE(data: Uint8Array, offset: number): bigint {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return view.getBigUint64(offset, true);
}

async function main() {
  console.log("=== Step 1: getProgramAccounts (listing bettor accounts for wallet) ===");
  const start = Date.now();

  const accounts = await conn.getProgramAccounts(RUMBLE_ENGINE_ID, {
    commitment: "confirmed",
    filters: [
      {
        memcmp: {
          offset: 0,
          bytes: anchorUtils.bytes.bs58.encode(BETTOR_DISCRIMINATOR),
        },
      },
      {
        memcmp: {
          offset: 8,
          bytes: wallet.toBase58(),
        },
      },
    ],
  });

  console.log(`  Found ${accounts.length} bettor accounts (${Date.now() - start}ms)`);

  for (const account of accounts) {
    const data = account.account.data as Buffer;
    let offset = 8; // discriminator
    const authority = new PublicKey(data.subarray(offset, offset + 32));
    offset += 32;
    const rumbleId = readU64LE(data, offset);
    offset += 8;
    const fighterIndex = data[offset]!;
    offset += 1;
    const solDeployed = readU64LE(data, offset);
    offset += 8;
    const claimable = readU64LE(data, offset);
    offset += 8;
    const totalClaimed = readU64LE(data, offset);
    offset += 8;
    offset += 8; // last_claim_ts
    const claimed = data[offset] === 1;

    console.log(`  PDA: ${account.pubkey.toBase58()}`);
    console.log(`    Rumble ID: ${rumbleId} (safe: ${Number.isSafeInteger(Number(rumbleId))})`);
    console.log(`    Authority: ${authority.toBase58()}`);
    console.log(`    SOL deployed: ${(Number(solDeployed) / LAMPORTS_PER_SOL).toFixed(6)}`);
    console.log(`    Claimable: ${(Number(claimable) / LAMPORTS_PER_SOL).toFixed(6)}`);
    console.log(`    Total claimed: ${(Number(totalClaimed) / LAMPORTS_PER_SOL).toFixed(6)}`);
    console.log(`    Claimed: ${claimed}`);

    // Check rumble state
    console.log("\n=== Step 2: readRumbleAccountState ===");
    const rumbleIdNum = Number(rumbleId);
    const RUMBLE_SEED = Buffer.from("rumble");
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(rumbleId);
    const [rumblePda] = PublicKey.findProgramAddressSync([RUMBLE_SEED, buf], RUMBLE_ENGINE_ID);
    const rumbleInfo = await conn.getAccountInfo(rumblePda, "processed");
    if (rumbleInfo) {
      const rData = rumbleInfo.data;
      const state = ["betting", "combat", "payout", "complete"][rData[16]!] ?? "unknown";
      const fighterCountOffset = 8 + 8 + 1 + 32 * 16;
      const fighterCount = rData[fighterCountOffset]!;
      const poolsOffset = fighterCountOffset + 1;
      const totalDeployedOffset = poolsOffset + 8 * 16;
      const adminFeeOffset = totalDeployedOffset + 8;
      const sponsorOffset = adminFeeOffset + 8;
      const placementsOffset = sponsorOffset + 8;
      const winnerIndexOffset = placementsOffset + 16;
      const winnerIndex = rData[winnerIndexOffset]!;

      console.log(`  State: ${state}`);
      console.log(`  Fighter count: ${fighterCount}`);
      console.log(`  Winner index: ${winnerIndex}`);
      console.log(`  Placement of winner: ${rData[placementsOffset + winnerIndex]}`);
      console.log(`  Payout ready: ${state === "payout" || state === "complete"}`);

      // Check winner deployment
      const wOffset = 83; // in bettor data: skip 8+32+8+1+8+8+8+8+1+1 = 83
      const fighterDeployments: bigint[] = [];
      for (let i = 0; i < 16; i++) {
        if (wOffset + i * 8 + 8 <= data.length) {
          const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
          fighterDeployments.push(view.getBigUint64(wOffset + i * 8, true));
        }
      }
      const winnerDeployment = fighterDeployments[winnerIndex] ?? 0n;
      console.log(`  Winner deployment from bettor: ${(Number(winnerDeployment) / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
      console.log(`  Would pass claimable check: ${winnerDeployment > 0n || claimable > 0n}`);
    } else {
      console.log("  Rumble account NOT FOUND!");
    }

    // Derive timestamp for session filter
    const raw = String(rumbleIdNum);
    const ts = raw.length >= 13 ? Number(raw.slice(0, 13)) : null;
    console.log(`\n=== Step 3: Session timestamp filter ===`);
    console.log(`  Derived timestamp: ${ts} (${ts ? new Date(ts).toISOString() : "null"})`);
  }

  // Now simulate what the balance API does
  console.log("\n=== Step 4: Simulate balance API call via HTTP ===");
  try {
    const balanceUrl = `https://clawfights.xyz/api/rumble/balance?wallet=${wallet.toBase58()}&_t=${Date.now()}`;
    console.log(`  Calling: ${balanceUrl}`);
    const res = await fetch(balanceUrl, {
      headers: { "Accept": "application/json" },
    });
    const data = await res.json();
    console.log(`  Status: ${res.status}`);
    console.log(`  Response:`, JSON.stringify(data, null, 2));
  } catch (e: any) {
    console.log(`  Error:`, e.message);
  }
}

main().catch(console.error);
