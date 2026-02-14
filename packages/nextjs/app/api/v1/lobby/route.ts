// @ts-nocheck
// Redirect alias - /api/v1/lobby -> /api/lobby
import { GET as actualGet, POST as actualPost } from "../../lobby/route";

export const dynamic = "force-dynamic";

export const GET = actualGet;
export const POST = actualPost;
