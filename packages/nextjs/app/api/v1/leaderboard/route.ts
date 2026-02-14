// @ts-nocheck
// Redirect alias - /api/v1/leaderboard -> /api/leaderboard
import { GET as actualGet } from "../../leaderboard/route";

export const dynamic = "force-dynamic";

export const GET = actualGet;
