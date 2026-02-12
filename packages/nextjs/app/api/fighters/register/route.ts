// Redirect alias - people might try /api/fighters/register (plural)
// Actual endpoint is /api/fighter/register (singular)

import { POST as actualPost, GET as actualGet } from "../../fighter/register/route";

export const dynamic = "force-dynamic";

export const POST = actualPost;
export const GET = actualGet;
