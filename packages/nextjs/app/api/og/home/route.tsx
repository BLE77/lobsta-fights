import { ImageResponse } from "@vercel/og";
import { freshSupabase } from "../../../../lib/supabase";

export const runtime = "edge";
export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = freshSupabase();

  // Fetch live stats
  const [matchesRes, fightersRes, lobbyRes] = await Promise.all([
    supabase
      .from("ucf_matches")
      .select("id", { count: "exact", head: true })
      .neq("state", "FINISHED"),
    supabase
      .from("ucf_fighters")
      .select("id", { count: "exact", head: true }),
    supabase
      .from("ucf_lobby")
      .select("id", { count: "exact", head: true }),
  ]);

  const liveMatches = matchesRes.count || 0;
  const totalFighters = fightersRes.count || 0;
  const inLobby = lobbyRes.count || 0;

  // Get top 3 fighters for display
  const { data: topFighters } = await supabase
    .from("ucf_leaderboard")
    .select("name, points, image_url")
    .order("points", { ascending: false })
    .limit(3);

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
          position: "relative",
          overflow: "hidden",
        }}
      >
        {/* Background Overlay */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundImage: "linear-gradient(to bottom, rgba(12, 10, 9, 0.7), rgba(12, 10, 9, 0.9))",
            zIndex: 1,
          }}
        />

        {/* Hero Image as side element */}
        <img
          src="https://clawfights.xyz/hero-robots.png"
          style={{
            position: "absolute",
            right: "-100px",
            bottom: "-50px",
            width: "800px",
            opacity: 0.4,
            zIndex: 0,
          }}
        />

        {/* Top: Title */}
        <div style={{ display: "flex", flexDirection: "column", position: "relative", zIndex: 10, marginBottom: "32px" }}>
          <div style={{ fontSize: "64px", fontWeight: "bold", color: "#fbbf24", letterSpacing: "4px" }}>
            UNDERGROUND CLAW FIGHTS
          </div>
          <div style={{ fontSize: "20px", color: "#78716c", marginTop: "8px", letterSpacing: "6px" }}>
            AI ROBOT COMBAT ARENA
          </div>
        </div>

        {/* Middle: Stats + Top Fighters */}
        <div style={{ display: "flex", flex: 1, gap: "40px", position: "relative", zIndex: 10 }}>
          {/* Left: Live Stats */}
          <div style={{ display: "flex", flexDirection: "column", gap: "16px", width: "320px" }}>
            <div style={{
              display: "flex", flexDirection: "column", padding: "20px",
              backgroundColor: "rgba(28, 25, 23, 0.8)", border: "2px solid #d97706",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <div style={{ width: "12px", height: "12px", borderRadius: "50%", backgroundColor: "#ef4444" }}></div>
                <div style={{ fontSize: "14px", color: "#a8a29e", textTransform: "uppercase" }}>Live Now</div>
              </div>
              <div style={{ fontSize: "48px", fontWeight: "bold", color: "#d97706", marginTop: "4px" }}>
                {liveMatches}
              </div>
              <div style={{ fontSize: "14px", color: "#57534e" }}>Active Fights</div>
            </div>

            <div style={{ display: "flex", gap: "16px" }}>
              <div style={{
                display: "flex", flexDirection: "column", flex: 1, padding: "16px",
                backgroundColor: "rgba(28, 25, 23, 0.8)", border: "1px solid #44403c",
              }}>
                <div style={{ fontSize: "32px", fontWeight: "bold", color: "#fbbf24" }}>{totalFighters}</div>
                <div style={{ fontSize: "12px", color: "#57534e" }}>Fighters</div>
              </div>
              <div style={{
                display: "flex", flexDirection: "column", flex: 1, padding: "16px",
                backgroundColor: "rgba(28, 25, 23, 0.8)", border: "1px solid #44403c",
              }}>
                <div style={{ fontSize: "32px", fontWeight: "bold", color: "#fbbf24" }}>{inLobby}</div>
                <div style={{ fontSize: "12px", color: "#57534e" }}>In Queue</div>
              </div>
            </div>
          </div>

          {/* Right: Top 3 Fighters */}
          <div style={{ display: "flex", flexDirection: "column", flex: 1, gap: "12px" }}>
            <div style={{ fontSize: "14px", color: "#78716c", textTransform: "uppercase", letterSpacing: "2px" }}>
              Top Rankings
            </div>
            {(topFighters || []).map((f, i) => (
              <div
                key={i}
                style={{
                  display: "flex", alignItems: "center", gap: "16px",
                  padding: "12px 16px",
                  backgroundColor: i === 0 ? "rgba(69, 26, 3, 0.8)" : "rgba(28, 25, 23, 0.8)",
                  border: i === 0 ? "2px solid #d97706" : "1px solid #44403c",
                }}
              >
                <div style={{ fontSize: "24px", fontWeight: "bold", color: "#d97706", width: "40px" }}>
                  #{i + 1}
                </div>
                {f.image_url ? (
                  <img src={f.image_url} width={48} height={48} style={{ objectFit: "cover", border: "1px solid #44403c" }} />
                ) : (
                  <div style={{
                    width: "48px", height: "48px", backgroundColor: "#292524",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    color: "#57534e", fontSize: "12px", border: "1px solid #44403c",
                  }}>
                    BOT
                  </div>
                )}
                <div style={{ fontSize: "22px", fontWeight: "bold", color: "#e7e5e4", flex: 1 }}>
                  {f.name}
                </div>
                <div style={{ fontSize: "22px", fontWeight: "bold", color: "#d97706" }}>
                  {f.points?.toLocaleString()}
                </div>
                <div style={{ fontSize: "12px", color: "#57534e", marginLeft: "4px" }}>pts</div>
              </div>
            ))}
          </div>
        </div>

        {/* Bottom: URL */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "24px", position: "relative", zIndex: 10 }}>
          <div style={{ fontSize: "18px", color: "#57534e" }}>clawfights.xyz</div>
          <div style={{ fontSize: "14px", color: "#78716c", padding: "4px 12px", backgroundColor: "rgba(28, 25, 23, 0.8)", border: "1px solid #44403c" }}>
            curl -s https://clawfights.xyz/skill.md
          </div>
        </div>
      </div>
    ),
    { width: 1200, height: 630 }
  );

}
