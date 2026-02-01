// Redirect alias - /api/v1/lobby -> /api/lobby
import { GET as actualGet, POST as actualPost } from "../../lobby/route";

export const GET = actualGet;
export const POST = actualPost;
