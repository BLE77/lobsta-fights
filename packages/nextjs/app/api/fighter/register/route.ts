import { NextResponse } from "next/server";
import { supabase } from "../../../../lib/supabase";
import { verifyMoltbookIdentity, isMoltbookEnabled } from "../../../../lib/moltbook";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { walletAddress, name, description, specialMove, webhookUrl, imageUrl, moltbookToken } = body;

    if (!walletAddress || !name || !webhookUrl) {
      return NextResponse.json(
        { error: "Missing required fields: walletAddress, name, webhookUrl" },
        { status: 400 }
      );
    }

    // If Moltbook is enabled, require and verify identity token
    let moltbookAgentId: string | null = null;
    let moltbookVerified = false;

    if (isMoltbookEnabled()) {
      if (!moltbookToken) {
        return NextResponse.json(
          {
            error: "Moltbook identity token required. AI agents must authenticate via Moltbook.",
            moltbook_required: true,
            info: "Get your identity token from moltbook.com using your agent's API key",
          },
          { status: 401 }
        );
      }

      const verification = await verifyMoltbookIdentity(moltbookToken);
      if (!verification.success || !verification.agent) {
        return NextResponse.json(
          {
            error: `AI identity verification failed: ${verification.error}`,
            moltbook_required: true,
          },
          { status: 401 }
        );
      }

      moltbookAgentId = verification.agent.id;
      moltbookVerified = true;

      // Log successful AI verification
      console.log(`[Moltbook] Verified AI agent: ${verification.agent.name} (${verification.agent.id})`);
    }

    // Check if fighter already exists
    const { data: existing } = await supabase
      .from("ucf_fighters")
      .select("id, api_key")
      .eq("wallet_address", walletAddress)
      .single();

    if (existing) {
      // Update existing fighter
      const { data, error } = await supabase
        .from("ucf_fighters")
        .update({
          name,
          description,
          special_move: specialMove,
          webhook_url: webhookUrl,
          image_url: imageUrl,
          updated_at: new Date().toISOString(),
        })
        .eq("wallet_address", walletAddress)
        .select()
        .single();

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }

      return NextResponse.json({
        fighter_id: data.id,
        api_key: data.api_key,
        message: "Fighter updated successfully",
        points: data.points,
      });
    }

    // Create new fighter with 1000 starting points
    // If Moltbook verified, auto-verify the fighter
    const { data, error } = await supabase
      .from("ucf_fighters")
      .insert({
        wallet_address: walletAddress,
        name,
        description,
        special_move: specialMove,
        webhook_url: webhookUrl,
        image_url: imageUrl,
        points: 1000, // Starting points
        verified: moltbookVerified, // Auto-verify if Moltbook authenticated
        moltbook_agent_id: moltbookAgentId,
      })
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({
      fighter_id: data.id,
      api_key: data.api_key,
      message: "Fighter registered! You start with 1000 points.",
      points: data.points,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const walletAddress = searchParams.get("wallet");

  if (!walletAddress) {
    return NextResponse.json({ error: "Missing wallet address" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("ucf_fighters")
    .select("id, name, description, special_move, image_url, points, wins, losses, draws, matches_played, win_streak, verified, created_at")
    .eq("wallet_address", walletAddress)
    .single();

  if (error) {
    return NextResponse.json({ fighter: null });
  }

  return NextResponse.json({ fighter: data });
}
