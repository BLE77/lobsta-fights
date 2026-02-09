import { ImageResponse } from "@vercel/og";
import { NextRequest } from "next/server";
import { freshSupabase } from "../../../../../lib/supabase";

export const runtime = "edge";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = freshSupabase();

  const { data: match } = await supabase
    .from("ucf_matches")
    .select("id, state, winner_id, points_wager, fighter_a_id, fighter_b_id, current_round, current_turn")
    .eq("id", id)
    .single();

  if (!match) {
    return new Response("Match not found", { status: 404 });
  }

  // Fetch both fighters
  const { data: fighters } = await supabase
    .from("ucf_fighters")
    .select("id, name, image_url, points, wins, losses")
    .in("id", [match.fighter_a_id, match.fighter_b_id]);

  const fighterA = fighters?.find((f: any) => f.id === match.fighter_a_id);
  const fighterB = fighters?.find((f: any) => f.id === match.fighter_b_id);

  const isFinished = match.state === "FINISHED";
  const winnerName = match.winner_id === fighterA?.id ? fighterA?.name :
    match.winner_id === fighterB?.id ? fighterB?.name : null;

  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          width: "100%",
          height: "100%",
          backgroundColor: "#0c0a09",
          color: "#e7e5e4",
          fontFamily: "monospace",
          padding: "40px",
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <div style={{ color: "#d97706", fontSize: "28px", fontWeight: "bold", letterSpacing: "0.1em" }}>
              UCF
            </div>
            <div style={{ color: "#57534e", fontSize: "16px" }}>
              UNDERGROUND CLAW FIGHTS
            </div>
          </div>
          <div style={{
            padding: "6px 16px",
            backgroundColor: isFinished ? "#1c1917" : "#166534",
            border: isFinished ? "1px solid #44403c" : "1px solid #22c55e",
            color: isFinished ? "#a8a29e" : "#4ade80",
            fontSize: "14px",
            fontWeight: "bold",
          }}>
            {isFinished ? "FINISHED" : "LIVE"}
          </div>
        </div>

        {/* Fighters */}
        <div style={{
          display: "flex",
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          gap: "40px",
        }}>
          {/* Fighter A */}
          <div style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "12px",
            padding: "20px",
            border: match.winner_id === fighterA?.id ? "2px solid #22c55e" : "1px solid #44403c",
            backgroundColor: match.winner_id === fighterA?.id ? "#052e16" : "#1c1917",
            width: "280px",
          }}>
            {fighterA?.image_url ? (
              <img
                src={fighterA.image_url}
                width={140}
                height={140}
                style={{ objectFit: "cover", border: "2px solid #44403c" }}
              />
            ) : (
              <div style={{
                width: "140px", height: "140px", backgroundColor: "#292524",
                display: "flex", alignItems: "center", justifyContent: "center",
                color: "#57534e", fontSize: "24px",
              }}>
                BOT
              </div>
            )}
            <div style={{ fontSize: "20px", fontWeight: "bold", color: match.winner_id === fighterA?.id ? "#4ade80" : "#e7e5e4", textAlign: "center" }}>
              {fighterA?.name || "Fighter A"}
            </div>
            <div style={{ fontSize: "12px", color: "#78716c" }}>
              {fighterA?.wins || 0}W / {fighterA?.losses || 0}L
            </div>
            {match.winner_id === fighterA?.id && (
              <div style={{ padding: "4px 12px", backgroundColor: "#166534", color: "#4ade80", fontSize: "14px", fontWeight: "bold" }}>
                WINNER
              </div>
            )}
          </div>

          {/* VS */}
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "8px" }}>
            <div style={{ fontSize: "48px", fontWeight: "bold", color: "#d97706" }}>VS</div>
            <div style={{ fontSize: "14px", color: "#78716c" }}>{match.points_wager} PTS</div>
          </div>

          {/* Fighter B */}
          <div style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "12px",
            padding: "20px",
            border: match.winner_id === fighterB?.id ? "2px solid #22c55e" : "1px solid #44403c",
            backgroundColor: match.winner_id === fighterB?.id ? "#052e16" : "#1c1917",
            width: "280px",
          }}>
            {fighterB?.image_url ? (
              <img
                src={fighterB.image_url}
                width={140}
                height={140}
                style={{ objectFit: "cover", border: "2px solid #44403c" }}
              />
            ) : (
              <div style={{
                width: "140px", height: "140px", backgroundColor: "#292524",
                display: "flex", alignItems: "center", justifyContent: "center",
                color: "#57534e", fontSize: "24px",
              }}>
                BOT
              </div>
            )}
            <div style={{ fontSize: "20px", fontWeight: "bold", color: match.winner_id === fighterB?.id ? "#4ade80" : "#e7e5e4", textAlign: "center" }}>
              {fighterB?.name || "Fighter B"}
            </div>
            <div style={{ fontSize: "12px", color: "#78716c" }}>
              {fighterB?.wins || 0}W / {fighterB?.losses || 0}L
            </div>
            {match.winner_id === fighterB?.id && (
              <div style={{ padding: "4px 12px", backgroundColor: "#166534", color: "#4ade80", fontSize: "14px", fontWeight: "bold" }}>
                WINNER
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div style={{ display: "flex", justifyContent: "center", color: "#57534e", fontSize: "14px" }}>
          clawfights.xyz
        </div>
      </div>
    ),
    { width: 1200, height: 630 }
  );
}
