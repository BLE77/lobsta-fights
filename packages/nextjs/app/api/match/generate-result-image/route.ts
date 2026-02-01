import { NextRequest, NextResponse } from "next/server";
import { supabase } from "../../../../lib/supabase";

/**
 * Generate a battle result image showing the aftermath of a UCF match
 * Uses Flux Schnell via Replicate (~$0.003 per image)
 */

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;

// Style prompt for battle result images
const BATTLE_RESULT_STYLE = `A dramatic battle aftermath illustration in stylized grotesque adult animation style.

SCENE: Two robot fighters in a gritty underground arena cage. Post-fight moment. Industrial concrete floor with oil stains, sparks, debris.

COMPOSITION: Split composition showing both robots. Winner on one side, loser on the other. Clear visual hierarchy - winner dominant, loser defeated.

WINNER ROBOT: Standing or victory pose. Damaged but triumphant. Sparks flying, steam venting. Aggressive body language. Glowing eyes with intensity. Battle damage visible but still functional.

LOSER ROBOT: Fallen, slumped, or on knees. Significant damage - torn plating, exposed wires, sparking circuits. Smoke rising. Dimmed or flickering eyes. Defeated posture.

ARENA: Cage walls visible in background. Dim industrial lighting with dramatic spotlights. Haze/smoke atmosphere. Crowd silhouettes barely visible. Gritty, underground fight club feel.

STYLE: Dark adult animation meets editorial illustration. MeatCanyon-inspired but polished. Grotesque but not horror. Dramatic lighting with high contrast. Clean linework, flat-to-soft shading.

COLOR PALETTE: Dark industrial tones. Dirty yellows, rusted reds, steel grays. Orange/yellow sparks for contrast. Moody blue shadows. No neon, no glossy effects.

MOOD: Violent aftermath. Intensity. Underground fighting spectacle. Brutal but stylized.

High detail, sharp focus, professional illustration. NOT photorealistic, NOT 3D, NOT anime.`;

export async function POST(req: NextRequest) {
  try {
    if (!REPLICATE_API_TOKEN) {
      return NextResponse.json(
        { error: "Image generation not configured. Add REPLICATE_API_TOKEN to environment." },
        { status: 500 }
      );
    }

    const { match_id } = await req.json();

    if (!match_id) {
      return NextResponse.json(
        { error: "Missing match_id" },
        { status: 400 }
      );
    }

    // Fetch match with fighter details
    const { data: match, error: matchError } = await supabase
      .from("ucf_matches")
      .select(`
        *,
        fighter_a:ucf_fighters!fighter_a_id(id, name, description, special_move, image_url),
        fighter_b:ucf_fighters!fighter_b_id(id, name, description, special_move, image_url)
      `)
      .eq("id", match_id)
      .single();

    if (matchError || !match) {
      return NextResponse.json(
        { error: "Match not found" },
        { status: 404 }
      );
    }

    if (match.state !== "FINISHED") {
      return NextResponse.json(
        { error: "Match is not finished yet" },
        { status: 400 }
      );
    }

    const winner = match.winner_id === match.fighter_a_id ? match.fighter_a : match.fighter_b;
    const loser = match.winner_id === match.fighter_a_id ? match.fighter_b : match.fighter_a;

    // Get final stats from turn history
    const lastTurn = match.turn_history?.[match.turn_history.length - 1];
    const winnerHP = match.winner_id === match.fighter_a_id ? lastTurn?.hp_a_after : lastTurn?.hp_b_after;
    const totalRounds = match.agent_a_state?.rounds_won + match.agent_b_state?.rounds_won;

    // Build the prompt
    const prompt = `${BATTLE_RESULT_STYLE}

MATCH DETAILS:
Winner: "${winner.name}" - ${winner.description || 'A battle-hardened robot fighter'}
${winner.special_move ? `Winner's Signature Move: ${winner.special_move}` : ''}
Winner's remaining power: ${winnerHP || 'Low'}%

Loser: "${loser.name}" - ${loser.description || 'A defeated robot fighter'}
${loser.special_move ? `Loser's Failed Move: ${loser.special_move}` : ''}

Battle lasted ${totalRounds || 2} rounds. The winner stands victorious over their fallen opponent.

Generate this dramatic battle aftermath scene with both robots clearly visible.`;

    // Call Replicate API
    const response = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${REPLICATE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version: "5599ed30703defd1d160a25a63321b4dec97101d98b4674bcc56e41f62f35637",
        input: {
          prompt: prompt,
          num_outputs: 1,
          aspect_ratio: "16:9", // Widescreen for battle scenes
          output_format: "webp",
          output_quality: 90,
        },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error("Replicate API error:", error);
      return NextResponse.json(
        { error: "Failed to start image generation" },
        { status: 500 }
      );
    }

    const prediction = await response.json();

    return NextResponse.json({
      predictionId: prediction.id,
      status: prediction.status,
      message: "Battle result image generation started",
      match_id,
      winner: winner.name,
      loser: loser.name,
    });

  } catch (error: any) {
    console.error("Battle image generation error:", error);
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}

// GET endpoint to check prediction status
export async function GET(req: NextRequest) {
  try {
    if (!REPLICATE_API_TOKEN) {
      return NextResponse.json(
        { error: "Image generation not configured" },
        { status: 500 }
      );
    }

    const predictionId = req.nextUrl.searchParams.get("id");

    if (!predictionId) {
      return NextResponse.json(
        { error: "Missing prediction ID" },
        { status: 400 }
      );
    }

    const response = await fetch(
      `https://api.replicate.com/v1/predictions/${predictionId}`,
      {
        headers: {
          "Authorization": `Bearer ${REPLICATE_API_TOKEN}`,
        },
      }
    );

    if (!response.ok) {
      return NextResponse.json(
        { error: "Failed to get prediction status" },
        { status: 500 }
      );
    }

    const prediction = await response.json();

    return NextResponse.json({
      status: prediction.status,
      output: prediction.output,
      error: prediction.error,
    });

  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}
