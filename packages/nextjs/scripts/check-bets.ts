import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
console.log("Supabase URL:", url ? "SET" : "MISSING");
console.log("Service key:", key ? "SET" : "MISSING");

const sb = createClient(url!, key!);

async function main() {
  // First check if table exists and has rows
  const { count, error: countError } = await sb
    .from("ucf_rumbles")
    .select("*", { count: "exact", head: true });
  console.log("Total rumble count:", count, "Error:", countError?.message ?? "none");

  // Get recent rumbles
  const { data: rumbles, error: rError } = await sb
    .from("ucf_rumbles")
    .select("id, slot_index, fighters, status, payout_result")
    .order("created_at", { ascending: false })
    .limit(10);
  console.log("Query error:", rError?.message ?? "none");

  console.log("Got", rumbles?.length ?? 0, "rumbles");
  console.log("Recent rumbles:");
  for (const r of rumbles ?? []) {
    const hasPayout = r.payout_result != null;
    console.log(
      `  ${r.id}: status=${r.status}, slot=${r.slot_index}, hasPayout=${hasPayout}`,
    );
  }

  // Find rumble with _10 suffix
  const rumble10 = (rumbles ?? []).find((r) => /_10$/.test(r.id));
  if (!rumble10) {
    console.log("No rumble ending in _10 found! Trying first rumble with bets...");
    // Try to find any rumble with bets
    for (const r of rumbles ?? []) {
      const { count } = await sb.from("ucf_bets").select("*", { count: "exact", head: true }).eq("rumble_id", r.id);
      console.log(`  ${r.id}: ${count ?? 0} bets`);
    }
    return;
  }
  console.log("\nRumble 10 ID:", rumble10.id);
  if (rumble10.payout_result) {
    console.log(
      "Payout result:",
      JSON.stringify(rumble10.payout_result).substring(0, 300),
    );
  }

  // Get bets for this rumble
  const { data: bets, error } = await sb
    .from("ucf_bets")
    .select("*")
    .eq("rumble_id", rumble10.id);

  if (error) {
    console.error("Error:", error);
    return;
  }

  console.log(`\nFound ${bets?.length ?? 0} bets:`);
  for (const b of bets ?? []) {
    const wallet = String(b.wallet_address ?? "").substring(0, 12);
    console.log(`  wallet=${wallet}..., fighter=${b.fighter_id}, gross=${b.gross_amount}, net=${b.net_amount}`);
    // Show first bet's full keys to understand schema
    if (bets && bets.indexOf(b) === 0) {
      console.log("  Full first bet keys:", Object.keys(b));
    }
  }
}

main().catch(console.error);
