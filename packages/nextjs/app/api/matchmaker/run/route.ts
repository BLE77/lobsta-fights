import { NextResponse } from "next/server";
import { freshSupabase } from "../../../../lib/supabase";

export const dynamic = "force-dynamic";

const WEBHOOK_TIMEOUT = 5000; // 5 seconds

/**
 * POST /api/matchmaker/run
 *
 * Auto-matchmaker that:
 * 1. Finds fighters waiting in the lobby
 * 2. Pairs compatible fighters (similar points, matching wager)
 * 3. Creates matches
 * 4. Notifies both fighters via webhook
 *
 * Can be triggered by:
 * - Vercel Cron (every 10 seconds)
 * - External cron service
 * - Manual call
 */
export async function POST(request: Request) {
  const supabase = freshSupabase();
  try {
    // Optional: Verify cron secret for security
    const authHeader = request.headers.get("authorization");
    const cronSecret = process.env.CRON_SECRET;

    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      // Allow without auth if no secret configured (for testing)
      if (cronSecret) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
    }

    // Get all fighters in lobby, ordered by wait time
    const { data: lobby, error: lobbyError } = await supabase
      .from("ucf_lobby")
      .select(`
        id,
        fighter_id,
        points_wager,
        min_opponent_points,
        max_opponent_points,
        created_at,
        fighter:ucf_fighters!inner (
          id,
          name,
          points,
          webhook_url,
          verified
        )
      `)
      .order("created_at", { ascending: true });

    if (lobbyError) {
      return NextResponse.json({ error: lobbyError.message }, { status: 500 });
    }

    if (!lobby || lobby.length < 2) {
      return NextResponse.json({
        success: true,
        matches_created: 0,
        message: "Not enough fighters in lobby",
        waiting: lobby?.length || 0,
      });
    }

    const matchesCreated: any[] = [];
    const matchedFighterIds = new Set<string>();

    // Try to pair fighters
    for (let i = 0; i < lobby.length; i++) {
      const fighter1 = lobby[i];

      // Skip if already matched in this run
      if (matchedFighterIds.has(fighter1.fighter_id)) continue;

      // Skip if not verified
      if (!fighter1.fighter?.verified) continue;

      for (let j = i + 1; j < lobby.length; j++) {
        const fighter2 = lobby[j];

        // Skip if already matched
        if (matchedFighterIds.has(fighter2.fighter_id)) continue;

        // Skip if not verified
        if (!fighter2.fighter?.verified) continue;

        // Check compatibility
        const compatible = isCompatible(fighter1, fighter2);

        if (!compatible) continue;

        // Anti-farming check: prevent same fighters from battling too frequently
        const { data: canMatch } = await supabase
          .rpc("can_fighters_match", {
            p_fighter_a: fighter1.fighter_id,
            p_fighter_b: fighter2.fighter_id,
          });

        if (canMatch && canMatch.can_match === false) {
          console.log(`[Matchmaker] Anti-farming: ${fighter1.fighter_id} vs ${fighter2.fighter_id} blocked - ${canMatch.reason}`);
          continue; // Try next potential opponent
        }

        // Remove both from lobby FIRST to prevent other matchmaker runs
        // from seeing them and creating duplicate matches
        const { data: deletedRows } = await supabase
          .from("ucf_lobby")
          .delete()
          .in("fighter_id", [fighter1.fighter_id, fighter2.fighter_id])
          .select("fighter_id");

        // If we didn't delete both fighters, another matchmaker already claimed them
        const deletedIds = new Set((deletedRows || []).map((r: any) => r.fighter_id));
        if (!deletedIds.has(fighter1.fighter_id) || !deletedIds.has(fighter2.fighter_id)) {
          console.log(`[Matchmaker] Lobby race: could not claim both fighters ${fighter1.fighter_id} & ${fighter2.fighter_id}, skipping`);
          matchedFighterIds.add(fighter1.fighter_id);
          matchedFighterIds.add(fighter2.fighter_id);
          break;
        }

        const match = await createMatch(fighter1, fighter2);

        if (match) {
          matchesCreated.push(match);
          matchedFighterIds.add(fighter1.fighter_id);
          matchedFighterIds.add(fighter2.fighter_id);

          // Notify both fighters via webhook
          await notifyFighters(fighter1, fighter2, match);
        } else {
          // Match creation failed (likely duplicate guard caught it).
          // Fighters are already removed from lobby, which is fine —
          // they can re-join if needed.
          console.log(`[Matchmaker] Match creation failed for ${fighter1.fighter_id} vs ${fighter2.fighter_id}, fighters removed from lobby`);
          matchedFighterIds.add(fighter1.fighter_id);
          matchedFighterIds.add(fighter2.fighter_id);
        }

        break; // Move to next fighter1
      }
    }

    return NextResponse.json({
      success: true,
      matches_created: matchesCreated.length,
      matches: matchesCreated,
      remaining_in_lobby: lobby.length - (matchedFighterIds.size),
    });

  } catch (error: any) {
    console.error("Matchmaker error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// Whitelisted fighters skip wager/point-range checks
const WHITELISTED_FIGHTERS = new Set([
  "56c6bbf8-47eb-4c66-95b8-dde361fb74ec", // THECLAWBOSS
  "3815f1dd-0e4d-4674-a99c-42fc3b323e77", // IRON-TANK-9000
  "00c29d7f-82eb-4bc6-b8ab-7b3d761551fc", // CHAOS-REAPER
  "70b66f68-6245-4b8b-b68d-673a26128440", // ORACLE-UNIT-7
  "36dd7d85-3050-44f2-bf92-d4f9014c41a5", // PHANTOM-STRIKER
  "66757591-4e48-48dc-aafc-6f89eddf9607", // 7UPA-RING-LEADER
  "8fdbdae0-92c9-466c-b3a5-6a912f95d795", // 7UPA-CLAW-MASTER
]);

/**
 * Check if two fighters are compatible for a match
 */
function isCompatible(f1: any, f2: any): boolean {
  // Whitelisted fighters always match each other (skip wager & range checks)
  if (WHITELISTED_FIGHTERS.has(f1.fighter_id) && WHITELISTED_FIGHTERS.has(f2.fighter_id)) {
    return true;
  }

  // Must have same wager
  if (f1.points_wager !== f2.points_wager) return false;

  // Check points ranges overlap
  const f1Points = f1.fighter?.points || 0;
  const f2Points = f2.fighter?.points || 0;

  // Fighter 1 accepts fighter 2's points
  const f1AcceptsF2 = f2Points >= f1.min_opponent_points && f2Points <= f1.max_opponent_points;

  // Fighter 2 accepts fighter 1's points
  const f2AcceptsF1 = f1Points >= f2.min_opponent_points && f1Points <= f2.max_opponent_points;

  return f1AcceptsF2 && f2AcceptsF1;
}

/**
 * Create a match between two fighters.
 * Includes a database-level guard: refuses to create if either fighter
 * is already in an active (non-FINISHED) match.
 */
async function createMatch(f1: any, f2: any) {
  const supabase = freshSupabase();

  // ── Duplicate guard: check if either fighter is already in an active match ──
  const { data: existingMatch, error: checkError } = await supabase
    .from("ucf_matches")
    .select("id")
    .neq("state", "FINISHED")
    .or(
      `fighter_a_id.in.(${f1.fighter_id},${f2.fighter_id}),fighter_b_id.in.(${f1.fighter_id},${f2.fighter_id})`
    )
    .limit(1)
    .maybeSingle();

  if (checkError) {
    console.error("[Matchmaker] Error checking active matches:", checkError);
    return null;
  }

  if (existingMatch) {
    console.log(
      `[Matchmaker] DUPLICATE PREVENTED: fighter ${f1.fighter_id} or ${f2.fighter_id} already in active match ${existingMatch.id}`
    );
    return null;
  }

  // ── Create the match ──
  const initialAgentState = {
    hp: 100,
    meter: 0,
    rounds_won: 0,
  };

  const { data: match, error } = await supabase
    .from("ucf_matches")
    .insert({
      fighter_a_id: f1.fighter_id, // First in lobby = fighter A
      fighter_b_id: f2.fighter_id,
      state: "COMMIT_PHASE",
      points_wager: Math.min(f1.points_wager, f2.points_wager),
      agent_a_state: initialAgentState,
      agent_b_state: initialAgentState,
      current_round: 1,
      current_turn: 1,
      turn_history: [],
      commit_deadline: new Date(Date.now() + 30000).toISOString(), // 30 seconds
      started_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) {
    console.error("Error creating match:", error);
    return null;
  }

  return match;
}

/**
 * Notify both fighters that a match was created
 */
async function notifyFighters(f1: any, f2: any, match: any) {
  const notifications = [];

  // Notify fighter 1
  if (f1.fighter?.webhook_url) {
    notifications.push(
      sendWebhook(f1.fighter.webhook_url, {
        event: "match_created",
        match_id: match.id,
        your_fighter_id: f1.fighter_id,
        opponent: {
          id: f2.fighter_id,
          name: f2.fighter?.name,
          points: f2.fighter?.points,
        },
        points_wager: match.points_wager,
        state: "COMMIT_PHASE",
        commit_deadline: match.commit_deadline,
        message: "Match found! Submit your move commitment now.",
        you_are: "fighter_a",
      })
    );
  }

  // Notify fighter 2
  if (f2.fighter?.webhook_url) {
    notifications.push(
      sendWebhook(f2.fighter.webhook_url, {
        event: "match_created",
        match_id: match.id,
        your_fighter_id: f2.fighter_id,
        opponent: {
          id: f1.fighter_id,
          name: f1.fighter?.name,
          points: f1.fighter?.points,
        },
        points_wager: match.points_wager,
        state: "COMMIT_PHASE",
        commit_deadline: match.commit_deadline,
        message: "Match found! Submit your move commitment now.",
        you_are: "fighter_b",
      })
    );
  }

  // Fire webhooks (don't wait for response)
  Promise.all(notifications).catch((err) => {
    console.error("Error notifying fighters:", err);
  });
}

/**
 * Send webhook with timeout
 */
async function sendWebhook(url: string, payload: any): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT);

  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    console.error(`Webhook failed for ${url}:`, err);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * GET /api/matchmaker/run
 * Vercel Cron calls GET — run the matchmaker here too
 */
export async function GET(request: Request) {
  // Reuse the POST logic so Vercel cron actually triggers matchmaking
  return POST(request);
}
