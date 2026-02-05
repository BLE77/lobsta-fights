import { NextResponse } from "next/server";
import { supabase } from "../../../../lib/supabase";

export const dynamic = "force-dynamic";

/**
 * POST /api/match/create
 * Start a new UCF match between two fighters
 *
 * Input: { fighter_a_id, fighter_b_id, points_wager }
 * - Verifies both fighters exist and are verified
 * - Verifies both fighters have enough points
 * - Creates match in ucf_matches table
 * - Returns match_id
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { fighter_a_id, fighter_b_id, points_wager } = body;

    // Validate input
    if (!fighter_a_id || !fighter_b_id) {
      return NextResponse.json(
        { error: "Missing fighter_a_id or fighter_b_id" },
        { status: 400 }
      );
    }

    if (fighter_a_id === fighter_b_id) {
      return NextResponse.json(
        { error: "Cannot fight yourself" },
        { status: 400 }
      );
    }

    const wager = points_wager || 100;
    if (wager < 0) {
      return NextResponse.json(
        { error: "Points wager must be non-negative" },
        { status: 400 }
      );
    }

    // Fetch both fighters
    const { data: fighters, error: fetchError } = await supabase
      .from("ucf_fighters")
      .select("id, name, points, verified, is_active")
      .in("id", [fighter_a_id, fighter_b_id]);

    if (fetchError) {
      return NextResponse.json(
        { error: fetchError.message },
        { status: 500 }
      );
    }

    if (!fighters || fighters.length !== 2) {
      return NextResponse.json(
        { error: "One or both fighters not found" },
        { status: 404 }
      );
    }

    const fighterA = fighters.find((f) => f.id === fighter_a_id);
    const fighterB = fighters.find((f) => f.id === fighter_b_id);

    if (!fighterA || !fighterB) {
      return NextResponse.json(
        { error: "Fighter lookup failed" },
        { status: 404 }
      );
    }

    // Verify both fighters are verified
    if (!fighterA.verified) {
      return NextResponse.json(
        { error: `Fighter A (${fighterA.name}) is not verified` },
        { status: 403 }
      );
    }

    if (!fighterB.verified) {
      return NextResponse.json(
        { error: `Fighter B (${fighterB.name}) is not verified` },
        { status: 403 }
      );
    }

    // Verify both fighters have enough points
    if (fighterA.points < wager) {
      return NextResponse.json(
        { error: `Fighter A (${fighterA.name}) has insufficient points: ${fighterA.points} < ${wager}` },
        { status: 400 }
      );
    }

    if (fighterB.points < wager) {
      return NextResponse.json(
        { error: `Fighter B (${fighterB.name}) has insufficient points: ${fighterB.points} < ${wager}` },
        { status: 400 }
      );
    }

    // Check if either fighter is already in an active match
    const { data: activeMatches } = await supabase
      .from("ucf_matches")
      .select("id, fighter_a_id, fighter_b_id")
      .neq("state", "FINISHED")
      .or(`fighter_a_id.in.(${fighter_a_id},${fighter_b_id}),fighter_b_id.in.(${fighter_a_id},${fighter_b_id})`);

    if (activeMatches && activeMatches.length > 0) {
      const conflictingMatch = activeMatches[0];
      const inMatchFighter = conflictingMatch.fighter_a_id === fighter_a_id || conflictingMatch.fighter_b_id === fighter_a_id
        ? fighterA.name
        : fighterB.name;
      return NextResponse.json(
        { error: `${inMatchFighter} is already in an active match (${conflictingMatch.id})` },
        { status: 409 }
      );
    }

    // Create the match with initial state
    const initialAgentState = {
      hp: 100,
      meter: 0,
      rounds_won: 0,
    };

    const { data: match, error: createError } = await supabase
      .from("ucf_matches")
      .insert({
        fighter_a_id,
        fighter_b_id,
        state: "COMMIT_PHASE",
        points_wager: wager,
        agent_a_state: initialAgentState,
        agent_b_state: initialAgentState,
        current_round: 1,
        current_turn: 1,
        turn_history: [],
        commit_deadline: new Date(Date.now() + 60000).toISOString(), // 60 seconds (1 min) to commit
        started_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (createError) {
      return NextResponse.json(
        { error: createError.message },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      match_id: match.id,
      state: match.state,
      fighter_a: {
        id: fighter_a_id,
        name: fighterA.name,
      },
      fighter_b: {
        id: fighter_b_id,
        name: fighterB.name,
      },
      points_wager: wager,
      current_round: 1,
      current_turn: 1,
      commit_deadline: match.commit_deadline,
      message: "Match created! Both fighters must commit their moves.",
    });
  } catch (error: any) {
    console.error("Error creating match:", error);
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}

/**
 * GET /api/match/create
 * Get details of a specific match
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const matchId = searchParams.get("match_id");

  if (!matchId) {
    return NextResponse.json(
      { error: "Missing match_id parameter" },
      { status: 400 }
    );
  }

  const { data: match, error } = await supabase
    .from("ucf_matches")
    .select(`
      *,
      fighter_a:ucf_fighters!fighter_a_id(id, name, image_url),
      fighter_b:ucf_fighters!fighter_b_id(id, name, image_url)
    `)
    .eq("id", matchId)
    .single();

  if (error || !match) {
    return NextResponse.json(
      { error: "Match not found" },
      { status: 404 }
    );
  }

  return NextResponse.json({ match });
}
