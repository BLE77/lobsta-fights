import { NextResponse } from "next/server";
import { freshSupabase } from "../../../lib/supabase";

export const dynamic = "force-dynamic";

interface ActivityEvent {
  id: string;
  type: "match_finished" | "fighter_registered" | "fighter_joined_lobby";
  timestamp: string;
  data: Record<string, any>;
}

export async function GET() {
  const supabase = freshSupabase();

  const [matchesResult, fightersResult, lobbyResult] = await Promise.all([
    // Recent finished matches
    supabase
      .from("ucf_matches")
      .select("id, winner_id, fighter_a_id, fighter_b_id, points_wager, finished_at")
      .eq("state", "FINISHED")
      .not("finished_at", "is", null)
      .order("finished_at", { ascending: false })
      .limit(10),

    // Recently registered fighters
    supabase
      .from("ucf_fighters")
      .select("id, name, image_url, created_at")
      .order("created_at", { ascending: false })
      .limit(5),

    // Current lobby entries
    supabase
      .from("ucf_lobby")
      .select("id, fighter_id, points_wager, created_at")
      .order("created_at", { ascending: false })
      .limit(5),
  ]);

  const matches = matchesResult.data || [];
  const fighters = fightersResult.data || [];
  const lobby = lobbyResult.data || [];

  // Collect all unique fighter IDs we need to look up
  const fighterIds = new Set<string>();
  for (const m of matches) {
    fighterIds.add(m.fighter_a_id);
    fighterIds.add(m.fighter_b_id);
  }
  for (const l of lobby) {
    fighterIds.add(l.fighter_id);
  }

  // Batch fetch fighter details
  const fighterMap = new Map<string, { name: string; image_url: string | null }>();
  if (fighterIds.size > 0) {
    const { data: fighterDetails } = await supabase
      .from("ucf_fighters")
      .select("id, name, image_url")
      .in("id", Array.from(fighterIds));

    for (const f of fighterDetails || []) {
      fighterMap.set(f.id, { name: f.name, image_url: f.image_url });
    }
  }

  const events: ActivityEvent[] = [];

  // Match finished events
  for (const m of matches) {
    const winnerInfo = m.winner_id ? fighterMap.get(m.winner_id) : null;
    const loserId = m.winner_id === m.fighter_a_id ? m.fighter_b_id : m.fighter_a_id;
    const loserInfo = fighterMap.get(loserId);

    events.push({
      id: `match:${m.id}`,
      type: "match_finished",
      timestamp: m.finished_at,
      data: {
        match_id: m.id,
        winner_name: winnerInfo?.name || "Unknown",
        winner_id: m.winner_id,
        winner_image: winnerInfo?.image_url,
        loser_name: loserInfo?.name || "Unknown",
        loser_id: loserId,
        loser_image: loserInfo?.image_url,
        points_wager: m.points_wager,
      },
    });
  }

  // Fighter registered events
  for (const f of fighters) {
    events.push({
      id: `reg:${f.id}`,
      type: "fighter_registered",
      timestamp: f.created_at,
      data: {
        fighter_name: f.name,
        fighter_id: f.id,
        fighter_image: f.image_url,
      },
    });
  }

  // Lobby join events
  for (const l of lobby) {
    const info = fighterMap.get(l.fighter_id);
    events.push({
      id: `lobby:${l.id}`,
      type: "fighter_joined_lobby",
      timestamp: l.created_at,
      data: {
        fighter_name: info?.name || "Unknown",
        fighter_id: l.fighter_id,
        fighter_image: info?.image_url,
        points_wager: l.points_wager,
      },
    });
  }

  // Sort by timestamp descending, take top 20
  events.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  return NextResponse.json({ events: events.slice(0, 20) });
}
