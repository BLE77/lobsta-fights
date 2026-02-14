import { Connection, clusterApiUrl } from "@solana/web3.js";
import {
  migrateArenaConfigV2,
  readArenaConfig,
  updateSeasonReward,
} from "../lib/solana-programs";

const ONE_ICHOR = 1_000_000_000n;
const TARGET_SEASON_REWARD = 2_500n * ONE_ICHOR;

function resolveRpcEndpoint(): string {
  const network = String(process.env.NEXT_PUBLIC_SOLANA_NETWORK ?? "devnet");
  if (network === "mainnet-beta") return clusterApiUrl("mainnet-beta");
  return clusterApiUrl("devnet");
}

async function main() {
  const endpoint = resolveRpcEndpoint();
  const connection = new Connection(endpoint, "confirmed");
  console.log(`[SeasonSync] RPC endpoint: ${endpoint}`);

  const before = await readArenaConfig(connection);
  if (!before) throw new Error("ArenaConfig PDA not found.");

  console.log("[SeasonSync] Before:", {
    accountDataLen: before.accountDataLen,
    baseReward: before.baseReward.toString(),
    seasonReward: before.seasonReward.toString(),
    effectiveReward: before.effectiveReward.toString(),
  });

  // Legacy accounts (len 145) cannot deserialize in newer handlers until migrated.
  if (before.accountDataLen < 153) {
    console.log("[SeasonSync] Legacy ArenaConfig detected. Migrating...");
    const migrateSig = await migrateArenaConfigV2(TARGET_SEASON_REWARD, connection);
    console.log("[SeasonSync] migrateArenaConfigV2 sig:", migrateSig);
  }

  const updateSig = await updateSeasonReward(TARGET_SEASON_REWARD, connection);
  console.log("[SeasonSync] updateSeasonReward sig:", updateSig);

  const after = await readArenaConfig(connection);
  if (!after) throw new Error("ArenaConfig missing after update.");

  console.log("[SeasonSync] After:", {
    accountDataLen: after.accountDataLen,
    baseReward: after.baseReward.toString(),
    seasonReward: after.seasonReward.toString(),
    effectiveReward: after.effectiveReward.toString(),
  });

  if (after.effectiveReward !== TARGET_SEASON_REWARD) {
    throw new Error(
      `Season reward mismatch: expected ${TARGET_SEASON_REWARD}, got ${after.effectiveReward}`,
    );
  }

  console.log("[SeasonSync] OK: on-chain season reward is 2500 ICHOR.");
}

main().catch(err => {
  console.error("[SeasonSync] FAILED:", err);
  process.exit(1);
});

