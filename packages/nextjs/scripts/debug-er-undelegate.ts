#!/usr/bin/env npx tsx

import { Connection, PublicKey } from "@solana/web3.js";
import {
  deriveCombatStatePda,
  getAdminSignerPublicKey,
  undelegateCombatFromEr,
} from "../lib/solana-programs";
import { getConnection, getErRpcEndpoint, getRpcEndpoint } from "../lib/solana-connection";

const DELEGATION_PROGRAM_ID = "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh";
const DEFAULT_CONFIRM_TIMEOUT_MS = 30_000;
const DEFAULT_SETTLE_DELAY_MS = 2_000;

type ParsedArgs = {
  rumbleId: number | null;
  erRpcs: string[];
  skipL1: boolean;
};

type AttemptSummary = {
  target: string;
  endpoint: string;
  signature: string | null;
  sendError: string | null;
  confirmError: string | null;
  ownerBefore: string | null;
  ownerAfter: string | null;
  delegatedBefore: boolean;
  delegatedAfter: boolean;
};

function parseArgs(argv: string[]): ParsedArgs {
  let rumbleId: number | null = null;
  const erRpcs: string[] = [];
  let skipL1 = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--rumble-id" || arg === "-r") {
      const value = argv[i + 1];
      if (!value) throw new Error("Missing value for --rumble-id");
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error(`Invalid rumble id: ${value}`);
      }
      rumbleId = parsed;
      i += 1;
      continue;
    }
    if (arg === "--er-rpc") {
      const value = argv[i + 1];
      if (!value) throw new Error("Missing value for --er-rpc");
      for (const part of value.split(",")) {
        const trimmed = part.trim();
        if (trimmed) erRpcs.push(trimmed);
      }
      i += 1;
      continue;
    }
    if (arg === "--skip-l1") {
      skipL1 = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { rumbleId, erRpcs, skipL1 };
}

function printUsage(): void {
  console.log("Usage:");
  console.log("  npx tsx scripts/debug-er-undelegate.ts --rumble-id <id> [--er-rpc <url[,url]>] [--skip-l1]");
  console.log("");
  console.log("Examples:");
  console.log("  npx tsx scripts/debug-er-undelegate.ts --rumble-id 42");
  console.log("  npx tsx scripts/debug-er-undelegate.ts --rumble-id 42 --er-rpc https://devnet-router.magicblock.app");
  console.log("  npx tsx scripts/debug-er-undelegate.ts --rumble-id 42 --er-rpc https://devnet-as.magicblock.app,https://devnet-router.magicblock.app");
}

function unique(values: string[]): string[] {
  return [...new Set(values.map(v => v.trim()).filter(Boolean))];
}

function formatErr(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message;
  return String(err);
}

function toWs(url: string): string | undefined {
  if (/^https:\/\//i.test(url)) return url.replace(/^https:\/\//i, "wss://");
  if (/^http:\/\//i.test(url)) return url.replace(/^http:\/\//i, "ws://");
  return undefined;
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function readL1Owner(
  l1Connection: Connection,
  combatStatePda: PublicKey,
): Promise<string | null> {
  try {
    const info = await l1Connection.getAccountInfo(combatStatePda, "confirmed");
    if (!info) return null;
    return info.owner.toBase58();
  } catch {
    return null;
  }
}

async function confirmSignature(
  connection: Connection,
  signature: string,
): Promise<string | null> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error(`Timed out after ${DEFAULT_CONFIRM_TIMEOUT_MS}ms`)),
        DEFAULT_CONFIRM_TIMEOUT_MS,
      );
    });
    const confirmation = await Promise.race([
      connection.confirmTransaction(signature, "confirmed"),
      timeout,
    ]);
    if (confirmation.value?.err) {
      return `confirmed_with_error:${JSON.stringify(confirmation.value.err)}`;
    }
    return null;
  } catch (err) {
    return formatErr(err);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function confirmSignatureOnAny(
  signature: string,
  connections: Array<{ label: string; connection: Connection }>,
): Promise<string | null> {
  const failures: string[] = [];
  const seen = new Set<string>();

  for (const { label, connection } of connections) {
    const endpoint = connection.rpcEndpoint;
    if (seen.has(endpoint)) continue;
    seen.add(endpoint);

    const err = await confirmSignature(connection, signature);
    if (!err) return null;
    failures.push(`${label}(${endpoint}): ${err}`);
  }

  return failures.join(" | ");
}

async function runAttempt(params: {
  target: string;
  endpoint: string;
  txConnection: Connection;
  l1Connection: Connection;
  rumbleId: number;
  combatStatePda: PublicKey;
}): Promise<AttemptSummary> {
  const ownerBefore = await readL1Owner(params.l1Connection, params.combatStatePda);
  const delegatedBefore = ownerBefore === DELEGATION_PROGRAM_ID;

  let signature: string | null = null;
  let sendError: string | null = null;
  let confirmError: string | null = null;

  try {
    signature = await undelegateCombatFromEr(params.rumbleId, params.txConnection);
  } catch (err) {
    sendError = formatErr(err);
  }

  if (signature) {
    confirmError = await confirmSignatureOnAny(signature, [
      { label: "er", connection: params.txConnection },
      { label: "l1", connection: params.l1Connection },
    ]);
  }

  await sleep(DEFAULT_SETTLE_DELAY_MS);
  const ownerAfter = await readL1Owner(params.l1Connection, params.combatStatePda);
  const delegatedAfter = ownerAfter === DELEGATION_PROGRAM_ID;

  return {
    target: params.target,
    endpoint: params.endpoint,
    signature,
    sendError,
    confirmError,
    ownerBefore,
    ownerAfter,
    delegatedBefore,
    delegatedAfter,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.rumbleId === null) {
    printUsage();
    throw new Error("Missing required --rumble-id");
  }

  const admin = getAdminSignerPublicKey();
  if (!admin) {
    throw new Error("Admin signer missing. Set SOLANA_DEPLOYER_KEYPAIR or SOLANA_DEPLOYER_KEYPAIR_PATH.");
  }

  const l1Connection = getConnection();
  const [combatStatePda] = deriveCombatStatePda(args.rumbleId);
  const combatStatePdaBase58 = combatStatePda.toBase58();

  const defaultErRpcs = unique([
    process.env.MAGICBLOCK_ER_VALIDATOR_RPC_URL ?? "",
    process.env.MAGICBLOCK_ER_REGION_RPC_URL ?? "",
    getErRpcEndpoint(),
    "https://devnet-router.magicblock.app",
    "https://devnet-as.magicblock.app",
    "https://devnet-us.magicblock.app",
    "https://devnet.magicblock.app",
  ]);
  const erRpcs = unique([...args.erRpcs, ...defaultErRpcs]);

  console.log("== MagicBlock undelegate debug ==");
  console.log(`rumble_id: ${args.rumbleId}`);
  console.log(`admin: ${admin}`);
  console.log(`combat_state_pda: ${combatStatePdaBase58}`);
  console.log(`l1_rpc: ${getRpcEndpoint()}`);
  console.log(`er_rpcs: ${erRpcs.join(", ")}`);
  console.log("");

  const attempts: AttemptSummary[] = [];

  for (const endpoint of erRpcs) {
    const txConnection = new Connection(endpoint, {
      commitment: "confirmed",
      wsEndpoint: toWs(endpoint),
    });
    const target = `ER:${endpoint}`;
    console.log(`-- Attempt: ${target}`);
    const result = await runAttempt({
      target,
      endpoint,
      txConnection,
      l1Connection,
      rumbleId: args.rumbleId,
      combatStatePda,
    });
    attempts.push(result);
    console.log(`   signature: ${result.signature ?? "none"}`);
    if (result.sendError) console.log(`   send_error: ${result.sendError}`);
    if (result.confirmError) console.log(`   confirm_error: ${result.confirmError}`);
    console.log(`   l1_owner_before: ${result.ownerBefore ?? "missing"}`);
    console.log(`   l1_owner_after:  ${result.ownerAfter ?? "missing"}`);
    console.log(`   delegated_before: ${result.delegatedBefore}`);
    console.log(`   delegated_after:  ${result.delegatedAfter}`);
    console.log("");
  }

  if (!args.skipL1) {
    const endpoint = l1Connection.rpcEndpoint;
    const target = `L1:${endpoint}`;
    console.log(`-- Attempt: ${target}`);
    const result = await runAttempt({
      target,
      endpoint,
      txConnection: l1Connection,
      l1Connection,
      rumbleId: args.rumbleId,
      combatStatePda,
    });
    attempts.push(result);
    console.log(`   signature: ${result.signature ?? "none"}`);
    if (result.sendError) console.log(`   send_error: ${result.sendError}`);
    if (result.confirmError) console.log(`   confirm_error: ${result.confirmError}`);
    console.log(`   l1_owner_before: ${result.ownerBefore ?? "missing"}`);
    console.log(`   l1_owner_after:  ${result.ownerAfter ?? "missing"}`);
    console.log(`   delegated_before: ${result.delegatedBefore}`);
    console.log(`   delegated_after:  ${result.delegatedAfter}`);
    console.log("");
  }

  const successful = attempts.find(a =>
    Boolean(a.signature) &&
    !a.sendError &&
    !a.confirmError &&
    a.delegatedBefore &&
    !a.delegatedAfter,
  );

  console.log("== Summary ==");
  if (successful) {
    console.log(`Recovered on ${successful.target} with tx ${successful.signature}`);
  } else {
    console.log("No attempt fully cleared delegation on L1.");
    console.log("Share this output with MagicBlock support, including all signatures/errors.");
  }
}

main().catch((err) => {
  console.error(formatErr(err));
  process.exit(1);
});
