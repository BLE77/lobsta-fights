// Redirect alias - /api/v1/leaderboard -> /api/leaderboard
import { GET as actualGet } from "../../leaderboard/route";

export const GET = actualGet;
