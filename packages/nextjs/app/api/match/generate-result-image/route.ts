import { NextRequest, NextResponse } from "next/server";
import { supabase } from "../../../../lib/supabase";

/**
 * Generate a battle result image showing the aftermath of a UCF match
 * Uses Flux Schnell via Replicate (~$0.003 per image)
 */

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;

// Master prompt style for bare knuckle robot fight results
const BATTLE_RESULT_STYLE = `A stylized grotesque full-body robot battle aftermath illustration inspired by exaggerated adult animation aesthetics. BARE KNUCKLE robot fight - NO WEAPONS.

SCENE: Underground arena cage. Post-fight moment. Gritty industrial concrete floor with oil stains, sparks, debris. Cage walls visible. Dim industrial lighting with dramatic spotlights.

FRAMING: Full-body robots visible. Centered composition. Dynamic but readable poses.

DESIGN: Robot anatomy is exaggerated but controlled. Oversized heads/helmets. Thick overbuilt shoulders and arms. Slightly hunched postures. Mechanical joints stressed and worn. Hands oversized like boxing gloves. Design feels brutish, imperfect, handmade - not sleek or futuristic.

SURFACE & TEXTURE: Armor shows wear - chipped paint, rust, grime, oil stains. Uneven plating, exposed cables, pistons, rivets. No smooth plastic, no chrome shine.

LINEWORK & SHADING: Clean, confident, illustrative linework. Hand-inked look with visible contour lines. Flat-to-soft shading with subtle gradients.

COLOR PALETTE: Muted industrial colors - dirty yellows, rusted reds, worn steel, olive. Orange/yellow sparks for contrast. No neon, no glossy sci-fi glow.

STYLE: Dark adult animation meets editorial caricature. MeatCanyon-inspired but polished and controlled. Grotesque but not horror. Unsettling but not scary. Brutal but stylized.

High detail, sharp focus, clean edges, professional illustration. NOT photorealistic, NOT 3D, NOT anime, NOT cute, NOT chibi.`;

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

    // Fetch match with fighter details including robot_metadata
    const { data: match, error: matchError } = await supabase
      .from("ucf_matches")
      .select(`
        *,
        fighter_a:ucf_fighters!fighter_a_id(id, name, description, special_move, image_url, robot_metadata),
        fighter_b:ucf_fighters!fighter_b_id(id, name, description, special_move, image_url, robot_metadata)
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

    // Get final stats and moves from turn history
    const lastTurn = match.turn_history?.[match.turn_history.length - 1];
    const winnerHP = match.winner_id === match.fighter_a_id ? lastTurn?.hp_a_after : lastTurn?.hp_b_after;
    const winnerMove = match.winner_id === match.fighter_a_id ? lastTurn?.move_a : lastTurn?.move_b;
    const loserMove = match.winner_id === match.fighter_a_id ? lastTurn?.move_b : lastTurn?.move_a;
    const totalRounds = match.agent_a_state?.rounds_won + match.agent_b_state?.rounds_won;

    // Extract robot metadata for detailed descriptions
    const winnerMeta = winner.robot_metadata || {};
    const loserMeta = loser.robot_metadata || {};

    // Build the prompt with robot metadata and moves
    const prompt = `${BATTLE_RESULT_STYLE}

WINNER ROBOT - "${winner.name}":
Type: ${winnerMeta.robot_type || 'Fighter Robot'}
Chassis: ${winnerMeta.chassis_description || winner.description || 'Battle-hardened robot fighter'}
Fists: ${winnerMeta.fists_description || 'Industrial bare-knuckle fists'}
Colors: ${winnerMeta.color_scheme || 'worn industrial metals'}
Features: ${winnerMeta.distinguishing_features || 'battle scars'}
FINISHING MOVE: ${winnerMove || 'devastating punch'} - show this pose!
Remaining power: ${winnerHP || 20}%
POSE: Victory stance, fists raised triumphantly, dominant posture.

LOSER ROBOT - "${loser.name}":
Type: ${loserMeta.robot_type || 'Fighter Robot'}
Chassis: ${loserMeta.chassis_description || loser.description || 'Defeated robot fighter'}
Fists: ${loserMeta.fists_description || 'Damaged bare-knuckle fists'}
Colors: ${loserMeta.color_scheme || 'worn industrial metals'}
Features: ${loserMeta.distinguishing_features || 'heavy damage'}
FAILED MOVE: ${loserMove || 'attack'} - interrupted/failed
POSE: Collapsed on ground, sparking, exposed wires, cracked plating, defeated.

Battle lasted ${totalRounds || 2} rounds of BARE KNUCKLE combat.

Generate this dramatic battle aftermath with both full-body robots clearly visible.`;

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
