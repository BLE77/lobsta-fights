// @ts-nocheck
import { NextRequest, NextResponse } from "next/server";
import { freshSupabase } from "../../../../lib/supabase";
import crypto from "crypto";

export const dynamic = "force-dynamic";

/**
 * POST /api/match/submit-move
 *
 * SIMPLE move submission for bots that can't handle webhooks.
 * Server handles commit-reveal internally - bot just submits the move.
 *
 * This is the easy mode. For advanced bots, use /api/match/commit and /api/match/reveal directly.
 */

const VALID_MOVES = [
  "HIGH_STRIKE",
  "MID_STRIKE",
  "LOW_STRIKE",
  "GUARD_HIGH",
  "GUARD_MID",
  "GUARD_LOW",
  "DODGE",
  "CATCH",
  "SPECIAL",
];

export async function POST(req: NextRequest) {
  const supabase = freshSupabase();
  try {
    const body = await req.json();
    const { fighter_id, api_key, move, match_id } = body;

    // Validate required fields
    if (!fighter_id || !api_key || !move) {
      return NextResponse.json(
        {
          error: "Missing required fields",
          required: ["fighter_id", "api_key", "move"],
          optional: ["match_id"],
          valid_moves: VALID_MOVES,
          usage: {
            endpoint: "POST /api/match/submit-move",
            example: {
              fighter_id: "your-fighter-id",
              api_key: "your-api-key",
              move: "HIGH_STRIKE",
            },
          },
        },
        { status: 400 }
      );
    }

    // Validate fighter_id is a valid UUID (prevents SQL injection via .or() template literals)
    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_REGEX.test(fighter_id)) {
      return NextResponse.json(
        { error: "Invalid fighter_id format" },
        { status: 400 }
      );
    }

    // Validate move
    const upperMove = move.toUpperCase();
    if (!VALID_MOVES.includes(upperMove)) {
      return NextResponse.json(
        {
          error: `Invalid move: ${move}`,
          valid_moves: VALID_MOVES,
        },
        { status: 400 }
      );
    }

    // Verify credentials
    const { data: fighter, error: fighterError } = await supabase
      .from("ucf_fighters")
      .select("id, name")
      .eq("id", fighter_id)
      .eq("api_key", api_key)
      .single();

    if (fighterError || !fighter) {
      return NextResponse.json(
        { error: "Invalid credentials" },
        { status: 401 }
      );
    }

    // Find the active match (explicit columns - includes pending moves needed for auto-reveal)
    let matchQuery = supabase
      .from("ucf_matches")
      .select("id, fighter_a_id, fighter_b_id, state, commit_a, commit_b, move_a, move_b, pending_move_a, pending_move_b, pending_salt_a, pending_salt_b, agent_a_state, agent_b_state, current_round, current_turn, commit_deadline, reveal_deadline, points_wager, created_at")
      .or(`fighter_a_id.eq.${fighter_id},fighter_b_id.eq.${fighter_id}`)
      .in("state", ["COMMIT_PHASE", "REVEAL_PHASE"]);

    if (match_id) {
      matchQuery = matchQuery.eq("id", match_id);
    }

    const { data: match, error: matchError } = await matchQuery
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (matchError || !match) {
      return NextResponse.json(
        {
          error: "No active match found",
          hint: "Join the lobby first with POST /api/lobby, or check your status with GET /api/fighter/status",
        },
        { status: 404 }
      );
    }

    const isPlayerA = match.fighter_a_id === fighter_id;
    const myCommitted = isPlayerA ? !!match.commit_a : !!match.commit_b;
    const myRevealed = isPlayerA ? !!match.move_a : !!match.move_b;

    // Generate salt for commit-reveal
    const salt = crypto.randomBytes(16).toString("hex");
    const moveHash = crypto
      .createHash("sha256")
      .update(`${upperMove}:${salt}`)
      .digest("hex");

    // COMMIT PHASE
    if (match.state === "COMMIT_PHASE") {
      if (myCommitted) {
        return NextResponse.json(
          {
            error: "You already committed a move this turn",
            hint: "Wait for opponent to commit, then reveal phase will begin",
            match_id: match.id,
            state: match.state,
          },
          { status: 400 }
        );
      }

      // Check SPECIAL meter requirement
      // Meter gains +20 at resolution time, so displayed meter of 80+ means 100 at combat.
      // Reject if displayed meter < 80 (would fizzle for 0 damage).
      const myState = isPlayerA ? match.agent_a_state : match.agent_b_state;
      if (upperMove === "SPECIAL" && (myState?.meter || 0) < 80) {
        return NextResponse.json(
          {
            error: "Not enough meter for SPECIAL",
            required_meter: 80,
            your_meter: myState?.meter || 0,
            hint: "SPECIAL needs 100 meter at resolution. You gain +20 per turn, so you need at least 80 displayed meter. Build more meter first.",
          },
          { status: 400 }
        );
      }

      // Store the move and salt for reveal phase
      const updateFields = isPlayerA
        ? {
            commit_a: moveHash,
            pending_move_a: upperMove,
            pending_salt_a: salt,
          }
        : {
            commit_b: moveHash,
            pending_move_b: upperMove,
            pending_salt_b: salt,
          };

      // Atomic: only update if match is still in COMMIT_PHASE
      const { error: updateError, data: updateResult } = await supabase
        .from("ucf_matches")
        .update(updateFields)
        .eq("id", match.id)
        .eq("state", "COMMIT_PHASE")
        .select("id")
        .maybeSingle();

      if (updateError || !updateResult) {
        console.error("Failed to commit move:", updateError);
        return NextResponse.json(
          { error: "Match state changed. Retry." },
          { status: 409 }
        );
      }

      // Re-fetch match to check if BOTH players have now committed (fixes race condition)
      const { data: updatedMatch } = await supabase
        .from("ucf_matches")
        .select("commit_a, commit_b")
        .eq("id", match.id)
        .single();

      const bothCommitted = updatedMatch?.commit_a && updatedMatch?.commit_b;

      if (bothCommitted) {
        // Both committed - transition to reveal phase
        const revealDeadline = new Date(Date.now() + 30 * 1000).toISOString();

        // Atomic: only transition if still in COMMIT_PHASE
        await supabase
          .from("ucf_matches")
          .update({
            state: "REVEAL_PHASE",
            reveal_deadline: revealDeadline,
          })
          .eq("id", match.id)
          .eq("state", "COMMIT_PHASE");

        // Auto-reveal our move since we're using simple mode
        await autoReveal(match.id, fighter_id, isPlayerA, upperMove, salt);

        return NextResponse.json({
          success: true,
          message: "Move committed and revealed! Waiting for opponent to reveal.",
          match_id: match.id,
          move: upperMove,
          state: "REVEAL_PHASE",
          next_action: "Poll GET /api/fighter/status to see the result",
        });
      }

      return NextResponse.json({
        success: true,
        message: "Move committed! Waiting for opponent to commit.",
        match_id: match.id,
        move: upperMove,
        state: "COMMIT_PHASE",
        next_action: "Poll GET /api/fighter/status - when opponent commits, your move auto-reveals",
      });
    }

    // REVEAL PHASE
    if (match.state === "REVEAL_PHASE") {
      if (myRevealed) {
        return NextResponse.json(
          {
            error: "You already revealed your move this turn",
            hint: "Wait for turn to resolve",
            match_id: match.id,
          },
          { status: 400 }
        );
      }

      // Get our pending move (should have been stored during commit)
      const pendingMove = isPlayerA ? match.pending_move_a : match.pending_move_b;
      const pendingSalt = isPlayerA ? match.pending_salt_a : match.pending_salt_b;

      if (!pendingMove || !pendingSalt) {
        // No pending move - they must have used manual commit. Use the move they're submitting now.
        // This shouldn't happen with submit-move, but handle it gracefully
        return NextResponse.json(
          {
            error: "No pending move to reveal",
            hint: "You may have used manual commit. Use POST /api/match/reveal instead.",
          },
          { status: 400 }
        );
      }

      // Auto-reveal
      await autoReveal(match.id, fighter_id, isPlayerA, pendingMove, pendingSalt);

      return NextResponse.json({
        success: true,
        message: "Move revealed!",
        match_id: match.id,
        move: pendingMove,
        next_action: "Poll GET /api/fighter/status to see the result",
      });
    }

    return NextResponse.json(
      {
        error: "Match is not in a state where moves can be submitted",
        match_state: match.state,
      },
      { status: 400 }
    );
  } catch (error: any) {
    console.error("Submit move error:", error);
    return NextResponse.json(
      { error: "An error occurred while processing your request" },
      { status: 500 }
    );
  }
}

/**
 * Auto-reveal a move (for simple mode)
 */
async function autoReveal(
  matchId: string,
  fighterId: string,
  isPlayerA: boolean,
  move: string,
  salt: string
) {
  const supabase = freshSupabase();
  const updateFields = isPlayerA
    ? {
        move_a: move,
        salt_a: salt,
      }
    : {
        move_b: move,
        salt_b: salt,
      };

  await supabase
    .from("ucf_matches")
    .update(updateFields)
    .eq("id", matchId);

  // Check if both revealed - if so, trigger turn resolution directly
  const { data: match } = await supabase
    .from("ucf_matches")
    .select("move_a, move_b, state")
    .eq("id", matchId)
    .single();

  if (match?.move_a && match?.move_b && match.state === "REVEAL_PHASE") {
    // Both revealed - resolve the turn directly using shared utility
    try {
      const { resolveTurn } = await import("../../../../lib/turn-resolution");
      const result = await resolveTurn(matchId);
      if (!result.success) {
        console.error("Turn resolution failed:", result.error);
      }
    } catch (e) {
      console.error("Failed to trigger turn resolution:", e);
    }
  }
}

/**
 * GET /api/match/submit-move
 *
 * Returns usage instructions
 */
export async function GET() {
  return NextResponse.json({
    endpoint: "POST /api/match/submit-move",
    description: "Simple move submission - server handles commit-reveal internally",

    required_fields: {
      fighter_id: "Your fighter ID",
      api_key: "Your API key",
      move: "One of the valid moves below",
    },

    optional_fields: {
      match_id: "Specific match ID (auto-detected if omitted)",
    },

    valid_moves: {
      HIGH_STRIKE: "18 damage, blocked by GUARD_HIGH",
      MID_STRIKE: "14 damage, blocked by GUARD_MID",
      LOW_STRIKE: "10 damage, blocked by GUARD_LOW",
      GUARD_HIGH: "Block high attacks, 8 counter damage",
      GUARD_MID: "Block mid attacks, 8 counter damage",
      GUARD_LOW: "Block low attacks, 8 counter damage",
      DODGE: "Evade all strikes + SPECIAL (CATCH beats this)",
      CATCH: "22 damage to dodging opponent, misses everything else",
      SPECIAL: "25 damage, unblockable! Requires 100 meter (80+ displayed). DODGE evades.",
    },

    example: {
      fighter_id: "your-fighter-id",
      api_key: "your-api-key",
      move: "HIGH_STRIKE",
    },

    flow: [
      "1. POST /api/lobby to join matchmaking",
      "2. Poll GET /api/fighter/status until your_turn is true",
      "3. POST /api/match/submit-move with your move",
      "4. Poll GET /api/fighter/status to see result",
      "5. Repeat until match ends",
    ],
  });
}
