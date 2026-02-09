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

  const { data: fighter } = await supabase
    .from("ucf_leaderboard")
    .select("*")
    .eq("id", id)
    .single();

  if (!fighter) {
    return new Response("Fighter not found", { status: 404 });
  }

  // Get robot metadata
  const { data: fullFighter } = await supabase
    .from("ucf_fighters")
    .select("robot_metadata")
    .eq("id", id)
    .single();

  const fightingStyle = fullFighter?.robot_metadata?.fighting_style || "balanced";

  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          width: "100%",
          height: "100%",
          backgroundColor: "#0c0a09",
          color: "#e7e5e4",
          fontFamily: "monospace",
          padding: "40px",
        }}
      >
        {/* Left: Fighter Image */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", width: "340px", marginRight: "40px" }}>
          {fighter.image_url ? (
            <img
              src={fighter.image_url}
              width={280}
              height={280}
              style={{ objectFit: "cover", border: "3px solid #d97706" }}
            />
          ) : (
            <div style={{
              width: "280px", height: "280px", backgroundColor: "#292524",
              display: "flex", alignItems: "center", justifyContent: "center",
              color: "#57534e", fontSize: "48px", border: "3px solid #44403c",
            }}>
              BOT
            </div>
          )}
        </div>

        {/* Right: Fighter Info */}
        <div style={{ display: "flex", flexDirection: "column", flex: 1, justifyContent: "center", gap: "16px" }}>
          {/* Header */}
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <div style={{ color: "#d97706", fontSize: "16px" }}>UCF</div>
            <div style={{ color: "#57534e", fontSize: "14px" }}>UNDERGROUND CLAW FIGHTS</div>
          </div>

          {/* Rank + Name */}
          <div style={{ display: "flex", alignItems: "baseline", gap: "12px" }}>
            {fighter.rank && (
              <div style={{ color: "#d97706", fontSize: "32px", fontWeight: "bold" }}>#{fighter.rank}</div>
            )}
            <div style={{ fontSize: "42px", fontWeight: "bold", color: "#fbbf24" }}>
              {fighter.name}
            </div>
          </div>

          {/* Style */}
          <div style={{
            display: "flex", alignItems: "center", gap: "8px",
          }}>
            <div style={{ padding: "4px 12px", backgroundColor: "#1c1917", border: "1px solid #44403c", color: "#a8a29e", fontSize: "14px", textTransform: "uppercase" }}>
              {fightingStyle}
            </div>
          </div>

          {/* Stats Grid */}
          <div style={{ display: "flex", gap: "24px", marginTop: "8px" }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "12px 24px", backgroundColor: "#1c1917", border: "1px solid #44403c" }}>
              <div style={{ fontSize: "36px", fontWeight: "bold", color: "#d97706" }}>{fighter.points?.toLocaleString()}</div>
              <div style={{ fontSize: "12px", color: "#78716c", textTransform: "uppercase" }}>Points</div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "12px 24px", backgroundColor: "#1c1917", border: "1px solid #44403c" }}>
              <div style={{ fontSize: "36px", fontWeight: "bold", color: "#4ade80" }}>{fighter.wins}</div>
              <div style={{ fontSize: "12px", color: "#78716c", textTransform: "uppercase" }}>Wins</div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "12px 24px", backgroundColor: "#1c1917", border: "1px solid #44403c" }}>
              <div style={{ fontSize: "36px", fontWeight: "bold", color: "#f87171" }}>{fighter.losses}</div>
              <div style={{ fontSize: "12px", color: "#78716c", textTransform: "uppercase" }}>Losses</div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "12px 24px", backgroundColor: "#1c1917", border: "1px solid #44403c" }}>
              <div style={{ fontSize: "36px", fontWeight: "bold", color: "#e7e5e4" }}>{fighter.win_rate}%</div>
              <div style={{ fontSize: "12px", color: "#78716c", textTransform: "uppercase" }}>Win Rate</div>
            </div>
          </div>

          {/* Footer */}
          <div style={{ display: "flex", color: "#57534e", fontSize: "14px", marginTop: "16px" }}>
            clawfights.xyz
          </div>
        </div>
      </div>
    ),
    { width: 1200, height: 630 }
  );
}
